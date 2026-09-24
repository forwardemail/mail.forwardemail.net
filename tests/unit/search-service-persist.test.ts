/**
 * SearchService coalesced-persistence tests.
 *
 * persist() writes the entire entries array, so calling it once per sync
 * batch made initial indexing O(n^2) in bytes written. schedulePersist()
 * debounces the write; flush() forces a durable one. These tests pin the
 * new behavior: a burst of schedules collapses to a single write, that write
 * reflects the latest in-memory state, and a direct persist()/reset still
 * writes immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchService, setSearchDbClient } from '../../src/utils/search-service.js';

interface PutRecord {
  key: string;
  account: string;
  data?: unknown[];
  updatedAt: number;
}

let searchIndexStore: Map<string, PutRecord>;
let putSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  searchIndexStore = new Map();
  putSpy = vi.fn(async (rec: PutRecord) => {
    searchIndexStore.set(`${rec.account}:${rec.key}`, rec);
  });
  setSearchDbClient({
    searchIndex: {
      put: putSpy,
      get: async ([account, key]: [string, string]) =>
        searchIndexStore.get(`${account}:${key}`) ?? null,
    },
    indexMeta: { put: vi.fn(async () => {}) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  setSearchDbClient(null);
});

const doc = (id: string, subject: string) => ({ id, subject, from: 'a@b.com', snippet: '' });

describe('SearchService coalesced persistence', () => {
  it('collapses a burst of schedulePersist calls into a single write', async () => {
    const svc = new SearchService({ account: 'u@example.com' });

    // Simulate 10 sync batches, each adding docs then scheduling a persist.
    for (let b = 0; b < 10; b++) {
      for (let i = 0; i < 5; i++) svc.addEntry(doc(`${b}-${i}`, `msg ${b}-${i}`));
      svc.schedulePersist();
    }

    // Nothing written yet — all coalesced behind the debounce.
    expect(putSpy).not.toHaveBeenCalled();

    await svc.flush();

    // One write total, not ten.
    expect(putSpy).toHaveBeenCalledTimes(1);
    const written = putSpy.mock.calls[0][0] as PutRecord;
    expect(written.data).toHaveLength(50); // all 10 batches present
  });

  it('the debounce timer fires a single trailing write without flush()', async () => {
    const svc = new SearchService({ account: 'u@example.com' });
    svc.addEntry(doc('1', 'hello'));
    svc.schedulePersist();
    svc.addEntry(doc('2', 'world'));
    svc.schedulePersist();

    expect(putSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SearchService.PERSIST_DEBOUNCE_MS + 10);

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect((putSpy.mock.calls[0][0] as PutRecord).data).toHaveLength(2);
  });

  it('flush after the write is a no-op (nothing pending)', async () => {
    const svc = new SearchService({ account: 'u@example.com' });
    svc.addEntry(doc('1', 'x'));
    svc.schedulePersist();
    await svc.flush();
    expect(putSpy).toHaveBeenCalledTimes(1);

    await svc.flush(); // nothing scheduled since
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it('a scheduled write reflects mutations made after scheduling', async () => {
    const svc = new SearchService({ account: 'u@example.com' });
    svc.addEntry(doc('1', 'first'));
    svc.schedulePersist();
    // Mutation lands before the debounce fires — the single write must include it.
    svc.addEntry(doc('2', 'second'));

    await svc.flush();
    const written = putSpy.mock.calls[0][0] as PutRecord;
    expect(written.data).toHaveLength(2);
  });

  it('direct persist() writes immediately and cancels a pending schedule', async () => {
    const svc = new SearchService({ account: 'u@example.com' });
    svc.addEntry(doc('1', 'x'));
    svc.schedulePersist();
    await svc.persist();
    expect(putSpy).toHaveBeenCalledTimes(1);

    // The pending schedule was satisfied by the direct persist; no second write.
    await vi.advanceTimersByTimeAsync(SearchService.PERSIST_DEBOUNCE_MS + 10);
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it('a scheduled write that fails (locked database) does not reject and is retried', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const svc = new SearchService({ account: 'u@example.com' });
      const locked = Object.assign(new Error('Database is locked'), { name: 'DbLockedError' });
      putSpy.mockRejectedValueOnce(locked);

      svc.addEntry(doc('1', 'x'));
      svc.schedulePersist();
      await vi.advanceTimersByTimeAsync(SearchService.PERSIST_DEBOUNCE_MS + 10);
      await vi.runAllTimersAsync();
      expect(putSpy).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();

      // After unlock, the next flush writes the pending index.
      await svc.flush();
      expect(putSpy).toHaveBeenCalledTimes(2);
      expect((putSpy.mock.calls[1][0] as PutRecord).data).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('persisted blob round-trips back through loadFromCache', async () => {
    const svc = new SearchService({ account: 'u@example.com' });
    svc.addEntry(doc('1', 'searchable subject'));
    svc.addEntry(doc('2', 'another'));
    svc.schedulePersist();
    await svc.flush();

    const fresh = new SearchService({ account: 'u@example.com' });
    const loaded = await fresh.loadFromCache();
    expect(loaded).toBe(2);
    // searchAllFolders reads the rebuilt index directly (search() needs a
    // candidate list); confirms the reloaded index is actually queryable.
    const hits = await fresh.searchAllFolders('searchable');
    expect(hits.some((h: { id?: string }) => h.id === '1')).toBe(true);
  });
});
