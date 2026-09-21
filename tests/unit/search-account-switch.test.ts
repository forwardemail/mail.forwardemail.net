/**
 * A search that outlives an account switch must not leak.
 *
 * search() runs the server search with the credentials active when it was
 * issued and, on completion, caches the server hits into db.messages stamped
 * with the search store's account. Before this guard, switching accounts while
 * that request was in flight rewrote the account variable underneath it, so
 * account A's hits were written into account B's cache partition (permanent)
 * and returned as B's search results.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  activeEmail: 'a@test.com',
  request: vi.fn(),
  bulkPut: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args: unknown[]) => h.request(...args) },
}));
vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  interceptDemoRequest: () => ({ handled: false }),
}));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => h.activeEmail), set: vi.fn() },
  Accounts: { add: vi.fn(), list: vi.fn(() => []) },
}));
vi.mock('../../src/utils/db', () => ({
  db: {
    messages: {
      where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }),
      bulkGet: () => Promise.resolve([]),
      bulkPut: (...args: unknown[]) => h.bulkPut(...args),
    },
    messageBodies: { bulkGet: () => Promise.resolve([]) },
  },
}));
vi.mock('../../src/utils/search-service', () => ({
  SearchService: vi.fn().mockImplementation(() => ({
    loadFromCache: vi.fn(),
    getStats: () => ({ count: 0, sizeBytes: 0, includeBody: false, account: 'test' }),
    searchAllFolders: vi.fn(() => []),
    search: vi.fn(() => []),
    upsertEntries: vi.fn(),
    persist: vi.fn(),
  })),
  SavedSearchService: vi.fn().mockImplementation(() => ({
    getAll: () => Promise.resolve([]),
    save: vi.fn(),
    delete: vi.fn(),
  })),
  setSearchDbClient: vi.fn(),
}));
vi.mock('../../src/utils/search-mapping', () => ({ mapMessageToDoc: (msg: unknown) => msg }));
vi.mock('../../src/utils/search-worker-client', () => ({
  SearchWorkerClient: vi.fn().mockImplementation(() => {
    throw new Error('Worker not available in test');
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

const { searchStore } = await import('../../src/stores/searchStore');

const serverHit = (id: string) => ({
  id,
  subject: `Server ${id}`,
  from: 'someone@elsewhere.test',
  folder: 'INBOX',
  date: new Date().toISOString(),
});

beforeEach(async () => {
  h.activeEmail = 'a@test.com';
  h.request.mockReset();
  h.bulkPut.mockClear();
  await searchStore.actions.ensureInitialized('a@test.com');
});

describe('search results arriving after an account switch', () => {
  it('are discarded and never cached under the new account', async () => {
    let release!: (v: unknown) => void;
    h.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = searchStore.actions.search('invoice');
    await Promise.resolve();

    // What switchAccount does to the search store, in order.
    searchStore.actions.resetSearchConnection();
    h.activeEmail = 'b@test.com';
    await searchStore.actions.ensureInitialized('b@test.com');

    release([serverHit('a-hit')]);
    const results = await pending;

    expect(results).toEqual([]);
    expect(h.bulkPut).not.toHaveBeenCalled();
  });

  it('are cached under the account that issued the search otherwise', async () => {
    h.request.mockResolvedValue([serverHit('a-hit')]);

    const results = await searchStore.actions.search('invoice');

    expect(results.map((r) => r.id)).toEqual(['a-hit']);
    expect(h.bulkPut).toHaveBeenCalledTimes(1);
    const rows = h.bulkPut.mock.calls[0][0] as Array<{ account: string }>;
    expect(rows.every((r) => r.account === 'a@test.com')).toBe(true);
  });
});
