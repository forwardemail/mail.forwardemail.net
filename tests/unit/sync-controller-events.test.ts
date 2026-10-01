import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A realtime event asks for a metadata sync of the folder it changed. That
// sync must run next, not behind queued background work, and regardless of
// the background sync scope.
const hoisted = vi.hoisted(() => {
  const resolvers: Array<() => void> = [];
  const sendSyncTask = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
  const scope = { inboxOnly: false };
  return { resolvers, sendSyncTask, scope };
});

vi.mock('../../src/utils/sync-helpers.ts', () => ({
  accountKey: (a: string) => (a || '').toLowerCase(),
}));
vi.mock('../../src/utils/sync-settings.js', () => ({
  getSyncSettings: () => ({ pageSize: 50, maxHeaders: 500, scope: 'all', bodyLimit: 100 }),
  pickFoldersForScope: (folders: Array<{ path: string }>) =>
    hoisted.scope.inboxOnly ? folders.filter((f) => f.path === 'INBOX') : folders,
}));
vi.mock('../../src/stores/mailboxActions', () => ({
  syncProgress: { set: vi.fn(), update: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncTask: hoisted.sendSyncTask,
  onSyncProgress: vi.fn(() => () => {}),
  resetSyncWorkerReady: vi.fn(),
  connectSyncSearchPort: vi.fn(),
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/stores/mailboxStore', () => ({ getPendingDeleteIds: () => [] }));
vi.mock('../../src/workers/sync-pure.ts', () => ({
  nextBackfillDecision: () => ({ requeue: false, noProgressStreak: 0 }),
}));

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const sentFolders = () =>
  hoisted.sendSyncTask.mock.calls.map((call) => {
    const task = (call as unknown[])[0] as { type: string; folder: string };
    return `${task.type}:${task.folder}`;
  });

describe('sync-controller syncFolderForEvent', () => {
  let startInitialSync: (account: string, folders: unknown[], options?: unknown) => void;
  let syncFolderForEvent: (account: string, folder: unknown) => void;

  beforeEach(async () => {
    vi.resetModules();
    hoisted.resolvers.length = 0;
    hoisted.sendSyncTask.mockClear();
    hoisted.scope.inboxOnly = false;
    ({ startInitialSync, syncFolderForEvent } = await import('../../src/utils/sync-controller.js'));
  });

  afterEach(async () => {
    // Let this test's queue drain so it cannot send tasks into the next test.
    for (let i = 0; i < 20 && hoisted.resolvers.length; i++) {
      hoisted.resolvers.splice(0).forEach((r) => r());
      await tick(40);
    }
  });

  const finishCurrent = async () => {
    hoisted.resolvers.shift()?.();
    await tick();
  };

  it('runs ahead of work already queued', async () => {
    startInitialSync('a@b.com', [{ path: 'INBOX' }, { path: 'A' }, { path: 'B' }]);
    await tick();
    syncFolderForEvent('a@b.com', { path: 'Work' });

    await finishCurrent();

    expect(sentFolders()).toEqual(['metadata:INBOX', 'metadata:Work']);
  });

  it('moves a copy already queued to the front instead of leaving it behind', async () => {
    startInitialSync('a@b.com', [{ path: 'INBOX' }, { path: 'A' }, { path: 'B' }]);
    await tick();
    syncFolderForEvent('a@b.com', 'B');

    await finishCurrent();
    await finishCurrent();
    await finishCurrent();

    // INBOX was running; B jumps ahead of A and the backfill INBOX queued.
    expect(sentFolders().slice(0, 3)).toEqual(['metadata:INBOX', 'metadata:B', 'metadata:A']);
    expect(sentFolders().filter((f) => f === 'metadata:B')).toHaveLength(1);
  });

  it('syncs a folder outside the background sync scope', async () => {
    hoisted.scope.inboxOnly = true;
    startInitialSync('a@b.com', [{ path: 'Work' }]);
    await tick();
    expect(sentFolders()).toEqual([]);

    syncFolderForEvent('a@b.com', { path: 'Work' });
    await tick();

    expect(sentFolders()).toEqual(['metadata:Work']);
  });
});
