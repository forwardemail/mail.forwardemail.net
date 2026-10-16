import { beforeEach, describe, expect, it, vi } from 'vitest';

// When sync writes to a folder's cache, the folder badge has to keep showing
// the server's unread count: older history the server already counted must not
// be added to it, and new mail must reach it through a fresh server count.
const h = vi.hoisted(() => ({
  active: 'a@b.com',
  results: [] as Array<Record<string, unknown>>,
  hold: null as null | Promise<unknown>,
  tasks: [] as Array<Record<string, unknown>>,
  loadFolders: vi.fn(async () => {}),
  removeRemoteMessages: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/sync-helpers.ts', () => ({
  accountKey: (a: string) => a || h.active,
}));
vi.mock('../../src/utils/sync-settings.js', () => ({
  getSyncSettings: () => ({ pageSize: 50, maxHeaders: 500, scope: 'all', bodyLimit: 100 }),
  pickFoldersForScope: (folders: unknown[]) => folders,
}));
vi.mock('../../src/stores/mailboxActions', () => ({
  syncProgress: { set: vi.fn(), update: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncTask: vi.fn(async (task: Record<string, unknown>) => {
    h.tasks.push(task);
    if (h.hold) {
      const hold = h.hold;
      h.hold = null;
      await hold;
    }
    return h.results.shift() ?? { inserted: 0, updated: 0 };
  }),
  onSyncProgress: vi.fn(() => () => {}),
  resetSyncWorkerReady: vi.fn(),
  connectSyncSearchPort: vi.fn(),
}));
vi.mock('../../src/utils/storage.js', () => ({
  Local: { get: (key: string) => (key === 'email' ? h.active : null) },
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));
vi.mock('../../src/stores/mailboxStore', () => ({
  getPendingDeleteIds: () => [],
  getPendingFlagMutations: () => ({ m9: { is_unread: false } }),
  mailboxStore: {
    actions: { loadFolders: h.loadFolders, removeRemoteMessages: h.removeRemoteMessages },
  },
}));
vi.mock('../../src/workers/sync-pure.ts', () => ({
  nextBackfillDecision: () => ({ requeue: false, noProgressStreak: 0 }),
}));

describe('sync-controller and folder badges', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    h.active = 'a@b.com';
    h.results = [];
    h.hold = null;
    h.tasks = [];
    h.loadFolders.mockClear();
    h.removeRemoteMessages.mockClear();
  });

  const run = async (results: Array<Record<string, unknown>>) => {
    h.results = results;
    const { syncFolderForEvent } = await import('../../src/utils/sync-controller.js');
    syncFolderForEvent('a@b.com', { path: 'INBOX' });
    // metadata, then the backfill it queues
    await vi.advanceTimersByTimeAsync(100);
  };

  it('fetches the counts once after new messages are written', async () => {
    await run([
      { inserted: 3, updated: 0 },
      { inserted: 50, done: false },
    ]);

    expect(h.loadFolders).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.loadFolders).toHaveBeenCalledTimes(1);
    expect(h.loadFolders).toHaveBeenCalledWith({ force: true });
  });

  it('does nothing when sync changed nothing', async () => {
    await run([
      { inserted: 0, updated: 0 },
      { inserted: 0, done: true },
    ]);
    await vi.advanceTimersByTimeAsync(2000);

    expect(h.loadFolders).not.toHaveBeenCalled();
  });

  it('does not fetch counts for older history alone', async () => {
    await run([
      { inserted: 0, updated: 0 },
      { inserted: 50, done: false },
    ]);
    await vi.advanceTimersByTimeAsync(2000);

    expect(h.loadFolders).not.toHaveBeenCalled();
  });

  it('does not fetch counts for an account that is no longer on screen', async () => {
    await run([{ inserted: 1, updated: 0 }]);
    h.active = 'c@d.com';
    await vi.advanceTimersByTimeAsync(2000);

    expect(h.loadFolders).not.toHaveBeenCalled();
  });

  it("runs the next account's sync after a switch while a task was running", async () => {
    let release = () => {};
    h.hold = new Promise<void>((r) => {
      release = r;
    });
    const { startInitialSync } = await import('../../src/utils/sync-controller.js');
    startInitialSync('a@b.com', [{ path: 'INBOX' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.tasks.map((t) => t.account)).toEqual(['a@b.com']);

    // Switch while a@b.com's task is still out.
    h.active = 'c@d.com';
    startInitialSync('c@d.com', [{ path: 'INBOX' }]);
    release();
    await vi.advanceTimersByTimeAsync(100);

    expect(h.tasks.map((t) => t.account)).toContain('c@d.com');
  });

  it('passes pending read changes to sync and takes pruned messages off the list', async () => {
    await run([
      { inserted: 0, updated: 0 },
      { inserted: 0, done: false, pruned: 2, prunedIds: ['m1', 'm2'] },
    ]);

    expect(h.tasks[0].pendingFlagMutations).toEqual({ m9: { is_unread: false } });
    expect(h.tasks[1].pendingFlagMutations).toEqual({ m9: { is_unread: false } });
    expect(h.removeRemoteMessages).toHaveBeenCalledWith({
      account: 'a@b.com',
      folder: 'INBOX',
      ids: ['m1', 'm2'],
    });
  });
});
