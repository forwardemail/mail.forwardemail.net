/**
 * The in-worker search index holds one entry per synced message for the life
 * of the session. Upserts used to remove by filtering the whole array, so a
 * sync batch against a large index cost O(batch x index) and the size figure
 * only ever went up. These pin the replace-in-place behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchService, setSearchDbClient } from '../../src/utils/search-service.js';

let putSpy: ReturnType<typeof vi.fn>;
let stored: Map<string, { data?: unknown[]; sizeBytes?: number }>;

beforeEach(() => {
  stored = new Map();
  putSpy = vi.fn(async (rec: { key: string; account: string }) => {
    stored.set(`${rec.account}:${rec.key}`, rec);
  });
  setSearchDbClient({
    searchIndex: {
      put: putSpy,
      get: async ([account, key]: [string, string]) => stored.get(`${account}:${key}`) ?? null,
    },
    indexMeta: { put: vi.fn(async () => {}) },
  });
});

afterEach(() => {
  setSearchDbClient(null);
});

const doc = (id: string, subject: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject,
  from: 'a@b.com',
  snippet: '',
  ...extra,
});

describe('SearchService entries', () => {
  it('replaces an entry in place on upsert instead of growing', () => {
    const svc = new SearchService({ account: 'u@example.com' });
    svc.upsertEntries([doc('1', 'first'), doc('2', 'second')]);
    svc.upsertEntries([doc('1', 'first, edited')]);

    expect(svc.size()).toBe(2);
    expect(svc.entries.map((e) => e.subject)).toEqual(['second', 'first, edited']);
    expect(svc.getStats().count).toBe(2);
  });

  it('keeps sizeBytes equal to what is actually held after updates and removals', () => {
    const svc = new SearchService({ account: 'u@example.com' });
    svc.upsertEntries([doc('1', 'abcd'), doc('2', 'efgh')]);
    const afterInsert = svc.getStats().sizeBytes;
    svc.upsertEntries([doc('1', 'abcd')]);
    expect(svc.getStats().sizeBytes).toBe(afterInsert);

    svc.removeEntriesByIds(['2']);
    const fresh = new SearchService({ account: 'u@example.com' });
    fresh.upsertEntries([doc('1', 'abcd')]);
    expect(svc.getStats().sizeBytes).toBe(fresh.getStats().sizeBytes);
    expect(svc.size()).toBe(1);
  });

  it('finds the updated text and not the old one', () => {
    const svc = new SearchService({ account: 'u@example.com' });
    svc.upsertEntries([doc('1', 'quarterly numbers')]);
    svc.upsertEntries([doc('1', 'annual report')]);

    // search() only returns ids that are also in the candidate list, so the
    // service's own entries stand in for the folder rows a caller would pass.
    expect(svc.search('annual', svc.entries).map((h) => h.id)).toEqual(['1']);
    expect(svc.search('quarterly', svc.entries)).toEqual([]);
  });

  it('round-trips through persist and loadFromCache as a plain array', async () => {
    const svc = new SearchService({ account: 'u@example.com' });
    svc.upsertEntries([doc('1', 'one', { labels: ['work'] }), doc('2', 'two')]);
    await svc.persist();

    const record = putSpy.mock.calls[0][0] as { data: unknown[] };
    expect(Array.isArray(record.data)).toBe(true);
    expect(record.data).toHaveLength(2);

    const reloaded = new SearchService({ account: 'u@example.com' });
    expect(await reloaded.loadFromCache()).toBe(2);
    expect(reloaded.size()).toBe(2);
    expect(reloaded.search('two', reloaded.entries).map((h) => h.id)).toEqual(['2']);
  });
});
