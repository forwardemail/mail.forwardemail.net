/**
 * Retiring a search worker on an account switch or sign-out.
 *
 * On a phone the old worker's last index write (a copy of its whole index)
 * ran while the next account loaded, which is the overlap that ended the iOS
 * web content process. And a signed-out account's index, deleted with its
 * cache, was written back by that same flush.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Client = Record<string, ReturnType<typeof vi.fn>>;

const h = vi.hoisted(() => ({
  constrained: false,
  clients: [] as Client[],
  // What each new client's flush() and dropAccount() return.
  flush: () => Promise.resolve() as Promise<unknown>,
  drop: () => Promise.resolve() as Promise<unknown>,
  events: [] as string[],
}));

vi.mock('../../src/utils/memory-profile', () => ({
  get isMemoryConstrained() {
    return h.constrained;
  },
}));
vi.mock('../../src/utils/crypto-store.js', () => ({ isVaultLocked: () => false }));
vi.mock('../../src/utils/remote', () => ({ Remote: { request: vi.fn() } }));
vi.mock('../../src/utils/demo-mode', () => ({ isDemoMode: () => false }));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => 'a@example.com'), set: vi.fn() },
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
    const n = h.clients.length;
    h.events.push(`create ${n}`);
    const client: Client = {
      init: vi.fn(() => Promise.resolve()),
      getHealth: vi.fn(() => Promise.resolve({ healthy: true, needsRebuild: false })),
      flush: vi.fn(() => h.flush()),
      dropAccount: vi.fn(() => h.drop()),
      terminate: vi.fn(() => h.events.push(`terminate ${n}`)),
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

async function loadStore() {
  vi.resetModules();
  const { searchStore } = await import('../../src/stores/searchStore');
  return searchStore;
}

const deferred = () => {
  let resolve: (value?: unknown) => void = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(() => {
  h.constrained = false;
  h.clients.length = 0;
  h.events.length = 0;
  h.flush = () => Promise.resolve();
  h.drop = () => Promise.resolve();
});

describe('switching accounts on a phone', () => {
  it('terminateWorker resolves only after the old worker has written its index', async () => {
    h.constrained = true;
    const store = await loadStore();
    await store.actions.ensureInitialized('a@example.com');
    const write = deferred();
    h.clients[0].flush.mockImplementation(() => write.promise);

    let done = false;
    const retired = Promise.resolve(store.actions.terminateWorker()).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.clients[0].flush).toHaveBeenCalled();
    expect(done).toBe(false);

    write.resolve();
    await retired;
    expect(h.clients[0].terminate).toHaveBeenCalled();
  });

  it('starting another account waits for the old worker to write and end first', async () => {
    h.constrained = true;
    const store = await loadStore();
    await store.actions.ensureInitialized('a@example.com');
    const write = deferred();
    h.clients[0].flush.mockImplementation(() => write.promise);

    const next = store.actions.ensureInitialized('b@example.com');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The old index is written, not dropped, and no second worker yet.
    expect(h.clients[0].flush).toHaveBeenCalled();
    expect(h.clients).toHaveLength(1);

    write.resolve();
    await next;
    expect(h.events).toEqual(['create 0', 'terminate 0', 'create 1']);
  });
});

describe('signing out of an account', () => {
  it('makes the live worker and one still retiring forget the account', async () => {
    const store = await loadStore();
    await store.actions.ensureInitialized('a@example.com');
    // Still flushing after a switch away from it.
    h.clients[0].flush.mockImplementation(() => new Promise(() => {}));
    void store.actions.terminateWorker();
    await store.actions.ensureInitialized('b@example.com');

    await store.actions.dropAccount('a@example.com');

    expect(h.clients[0].dropAccount).toHaveBeenCalledWith('a@example.com');
    expect(h.clients[1].dropAccount).toHaveBeenCalledWith('a@example.com');
  });

  it('ends a worker that does not answer, without a flush', async () => {
    vi.useFakeTimers();
    try {
      const store = await loadStore();
      await store.actions.ensureInitialized('a@example.com');
      h.clients[0].dropAccount.mockImplementation(() => new Promise(() => {}));

      const dropping = store.actions.dropAccount('a@example.com');
      await vi.advanceTimersByTimeAsync(2_000);
      await dropping;

      expect(h.clients[0].terminate).toHaveBeenCalled();
      expect(h.clients[0].flush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
