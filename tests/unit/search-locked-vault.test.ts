/**
 * Search indexing must wait for App Lock.
 *
 * While the vault is locked the cache is unreadable: sealed messages come back
 * without subject or sender and every index write fails with DbLockedError.
 * The store used to build and check the index anyway, which ended in a
 * "Search index build failed" toast that sat behind the lock screen and greeted
 * the user right after unlocking. These tests pin the deferral: nothing runs
 * while locked, the work resumes on unlock, and lock/worker-replacement errors
 * never reach the user as a failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  locked: false,
  email: 'user@example.com',
  clients: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  rebuild: vi.fn(),
  health: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../src/utils/crypto-store.js', () => ({
  isVaultLocked: () => h.locked,
}));
vi.mock('../../src/utils/remote', () => ({ Remote: { request: vi.fn() } }));
vi.mock('../../src/utils/demo-mode', () => ({ isDemoMode: () => false }));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn((key: string) => (key === 'email' ? h.email : null)), set: vi.fn() },
}));
vi.mock('../../src/utils/db', () => ({ db: {} }));
vi.mock('../../src/utils/search-service', () => ({
  SearchService: vi.fn(),
  SavedSearchService: vi.fn().mockImplementation(() => ({
    getAll: () => Promise.resolve([]),
  })),
  setSearchDbClient: vi.fn(),
}));
vi.mock('../../src/utils/search-mapping', () => ({ mapMessageToDoc: (msg: unknown) => msg }));
vi.mock('../../src/utils/search-worker-client', () => ({
  SearchWorkerClient: vi.fn().mockImplementation(() => {
    const client = {
      init: vi.fn(() => Promise.resolve()),
      getHealth: vi.fn((...args: unknown[]) => h.health(...args)),
      rebuildFromCache: vi.fn((...args: unknown[]) => h.rebuild(...args)),
      index: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      syncMissingMessages: vi.fn(() => Promise.resolve({})),
      terminate: vi.fn(),
    };
    h.clients.push(client);
    return client;
  }),
}));
vi.mock('../../src/utils/sync-controller', () => ({ connectSearchWorker: vi.fn() }));
vi.mock('../../src/stores/mailboxActions', () => ({
  indexProgress: { set: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));
vi.mock('../../src/utils/search-body-indexing.js', () => ({
  resolveSearchBodyIndexing: () => false,
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));

const needsRebuild = {
  healthy: false,
  messagesCount: 50,
  indexCount: 0,
  divergence: 50,
  needsRebuild: true,
};

async function loadStore() {
  vi.resetModules();
  const { searchStore } = await import('../../src/stores/searchStore');
  searchStore.actions.terminateWorker();
  const { setIndexToasts } = await import('../../src/stores/searchStore');
  setIndexToasts({ show: h.toast });
  return searchStore;
}

beforeEach(() => {
  h.locked = false;
  h.email = 'user@example.com';
  h.clients.length = 0;
  h.toast.mockReset();
  h.rebuild.mockReset();
  h.health.mockReset();
  h.health.mockResolvedValue(needsRebuild);
  h.rebuild.mockResolvedValue({ count: 50, stats: { count: 50 } });
});

describe('search store while App Lock holds the vault', () => {
  it('creates no worker and indexes nothing while locked', async () => {
    const store = await loadStore();
    h.locked = true;

    await store.actions.ensureInitialized();
    await store.actions.indexMessages([{ id: 'm1' } as never]);
    await store.actions.removeFromIndex(['m1']);

    expect(h.clients).toHaveLength(0);
    expect(h.rebuild).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it('runs the deferred health check and rebuild for the real account after unlock', async () => {
    const store = await loadStore();
    h.locked = true;
    await store.actions.ensureInitialized();
    expect(h.clients).toHaveLength(0);

    h.locked = false;
    await store.actions.resumeAfterUnlock();

    expect(h.clients).toHaveLength(1);
    expect(h.clients[0].init).toHaveBeenCalledWith('user@example.com', false);
    expect(h.rebuild).toHaveBeenCalledTimes(1);
    expect(h.rebuild.mock.calls[0][0]).toMatchObject({ account: 'user@example.com' });
  });

  it('does not report a locked-database rebuild failure, and retries it on unlock', async () => {
    const store = await loadStore();
    h.rebuild.mockRejectedValueOnce(
      new Error('Database is locked: at-rest encryption is enabled and no key is available'),
    );

    await store.actions.ensureInitialized();
    expect(h.rebuild).toHaveBeenCalledTimes(1);
    expect(h.toast).not.toHaveBeenCalled();

    await store.actions.resumeAfterUnlock();
    expect(h.rebuild).toHaveBeenCalledTimes(2);
    expect(h.toast).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalledWith('Search index build failed', 'error');
  });

  it('does not report a rebuild cut short by a worker swap', async () => {
    const store = await loadStore();
    h.rebuild.mockRejectedValueOnce(new Error('Search worker terminated'));

    await store.actions.ensureInitialized();

    expect(h.toast).not.toHaveBeenCalledWith('Search index build failed', 'error');
  });

  it('still reports a genuine rebuild failure', async () => {
    const store = await loadStore();
    h.rebuild.mockRejectedValueOnce(new Error('QuotaExceededError'));

    await store.actions.ensureInitialized();

    expect(h.toast).toHaveBeenCalledWith('Search index build failed', 'error');
  });

  it('shares one initialization between concurrent callers', async () => {
    const store = await loadStore();

    await Promise.all([
      store.actions.ensureInitialized(),
      store.actions.ensureInitialized(),
      store.actions.resumeAfterUnlock(),
    ]);

    expect(h.clients).toHaveLength(1);
    expect(h.health).toHaveBeenCalledTimes(1);
    expect(h.rebuild).toHaveBeenCalledTimes(1);
  });
});
