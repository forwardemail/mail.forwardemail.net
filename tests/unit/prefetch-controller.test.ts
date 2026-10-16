import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock state so the vi.mock factories (which run before imports) can
// share the deferred sendSyncTask plumbing with the test body.
const hoisted = vi.hoisted(() => {
  const resolvers: Array<() => void> = [];
  const sendSyncTask = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
  return { resolvers, sendSyncTask };
});

vi.mock('../../src/utils/sync-helpers.ts', () => ({
  accountKey: (a: string) => (a || '').toLowerCase(),
}));

vi.mock('../../src/utils/sync-settings.js', () => ({
  getSyncSettings: () => ({ pageSize: 50, maxHeaders: 500, scope: 'all', bodyLimit: 100 }),
  pickFoldersForScope: (folders: unknown[]) => folders,
}));

vi.mock('../../src/stores/mailboxActions', () => ({
  // The controller only ever .update()/.set()s this; a minimal fake store is enough.
  syncProgress: { set: vi.fn(), update: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncTask: hoisted.sendSyncTask,
  onSyncProgress: vi.fn(() => () => {}),
  resetSyncWorkerReady: vi.fn(),
  connectSyncSearchPort: vi.fn(),
}));

vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/stores/mailboxStore', () => ({
  getPendingDeleteIds: () => [],
  getPendingFlagMutations: () => ({}),
}));
vi.mock('../../src/workers/sync-pure.ts', () => ({ nextBackfillDecision: () => ({}) }));

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe('sync-controller prefetchMessages', () => {
  let prefetchMessages: (folder: string, account: string, ids: string[]) => void;

  beforeEach(async () => {
    vi.resetModules();
    hoisted.resolvers.length = 0;
    hoisted.sendSyncTask.mockClear();
    ({ prefetchMessages } = await import('../../src/utils/sync-controller.js'));
  });

  afterEach(() => {
    // Drain any still-pending worker promise so a leaked task can't bleed across tests.
    hoisted.resolvers.forEach((r) => r());
  });

  it('dispatches an id-targeted prefetch task to the worker', async () => {
    prefetchMessages('INBOX', 'A@B.com', ['1', '2', '3']);
    await tick();

    expect(hoisted.sendSyncTask).toHaveBeenCalledTimes(1);
    const task = hoisted.sendSyncTask.mock.calls[0][0];
    expect(task).toMatchObject({
      type: 'prefetch',
      folder: 'INBOX',
      messageIds: ['1', '2', '3'],
    });
  });

  it('replaces a still-queued prefetch so the newest navigation target wins', async () => {
    // First selection starts immediately and stays in-flight (its worker promise
    // is left unresolved), so the next two calls land in the queue.
    prefetchMessages('INBOX', 'A@B.com', ['1']);
    prefetchMessages('INBOX', 'A@B.com', ['2']); // queued
    prefetchMessages('INBOX', 'A@B.com', ['3']); // must replace the ['2'] task

    expect(hoisted.sendSyncTask).toHaveBeenCalledTimes(1);
    expect(hoisted.sendSyncTask.mock.calls[0][0].messageIds).toEqual(['1']);

    // Let the in-flight task finish; the controller should now run the LATEST
    // queued prefetch (['3']) and never the superseded one (['2']).
    hoisted.resolvers[0]?.();
    await tick();

    expect(hoisted.sendSyncTask).toHaveBeenCalledTimes(2);
    expect(hoisted.sendSyncTask.mock.calls[1][0].messageIds).toEqual(['3']);
    const allSentIds = hoisted.sendSyncTask.mock.calls.map((c) => c[0].messageIds);
    expect(allSentIds).not.toContainEqual(['2']);
  });

  it('ignores empty / id-less requests', async () => {
    prefetchMessages('INBOX', 'A@B.com', []);
    prefetchMessages('', 'A@B.com', ['1']);
    await tick();
    expect(hoisted.sendSyncTask).not.toHaveBeenCalled();
  });
});
