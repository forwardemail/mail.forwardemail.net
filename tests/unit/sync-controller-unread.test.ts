import { beforeEach, describe, expect, it, vi } from 'vitest';

// When sync writes to a folder's cache, the folder badge has to keep showing
// the server's unread count: older history the server already counted must not
// be added to it, and new mail must reach it through a fresh server count.
const h = vi.hoisted(() => ({
  active: 'a@b.com',
  results: [] as Array<Record<string, unknown>>,
  rebaseFolderUnread: vi.fn(async () => {}),
  loadFolders: vi.fn(async () => {}),
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
  sendSyncTask: vi.fn(async () => h.results.shift() ?? { inserted: 0, updated: 0 }),
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
  mailboxStore: {
    actions: { rebaseFolderUnread: h.rebaseFolderUnread, loadFolders: h.loadFolders },
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
    h.rebaseFolderUnread.mockClear();
    h.loadFolders.mockClear();
  });

  const run = async (results: Array<Record<string, unknown>>) => {
    h.results = results;
    const { syncFolderForEvent } = await import('../../src/utils/sync-controller.js');
    syncFolderForEvent('a@b.com', { path: 'INBOX' });
    // metadata, then the backfill it queues
    await vi.advanceTimersByTimeAsync(100);
  };

  it('keeps the badge after new messages are written, then fetches the counts once', async () => {
    await run([
      { inserted: 3, updated: 0 },
      { inserted: 50, done: false },
    ]);

    expect(h.rebaseFolderUnread).toHaveBeenCalledWith('a@b.com', 'INBOX');
    expect(h.rebaseFolderUnread).toHaveBeenCalledTimes(2);
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

    expect(h.rebaseFolderUnread).not.toHaveBeenCalled();
    expect(h.loadFolders).not.toHaveBeenCalled();
  });

  it('does not fetch counts for an account that is no longer on screen', async () => {
    await run([{ inserted: 1, updated: 0 }]);
    h.active = 'c@d.com';
    await vi.advanceTimersByTimeAsync(2000);

    expect(h.loadFolders).not.toHaveBeenCalled();
  });
});
