/**
 * The search index on a phone, where the web content process (the search
 * worker with it) is ended at its memory limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchService, setSearchDbClient } from '../../src/utils/search-service.js';

let stored: Map<string, { data?: unknown[]; sizeBytes?: number }>;

beforeEach(() => {
  vi.useFakeTimers();
  stored = new Map();
  setSearchDbClient({
    searchIndex: {
      put: vi.fn(async (rec: { key: string; account: string }) => {
        stored.set(`${rec.account}:${rec.key}`, rec);
      }),
      get: async ([account, key]: [string, string]) => stored.get(`${account}:${key}`) ?? null,
    },
    indexMeta: { put: vi.fn(async () => {}) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  setSearchDbClient(null);
});

const doc = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  folder: 'INBOX',
  subject: `quarterly invoice ${id}`,
  from: 'billing@example.com',
  snippet: 'remember the deadline tomorrow',
  labels: [],
  ...extra,
});

const ids = (results: Array<{ id: string }>) => results.map((r) => r.id).sort();

describe('search index on a phone', () => {
  it('drops body text a saved index kept from when body search was on', async () => {
    stored.set('me:messages_v1', {
      data: [
        { ...doc('m1'), labelsText: '', body: 'x'.repeat(5000) },
        { ...doc('m2'), labelsText: '', body: 'y'.repeat(5000) },
      ],
      sizeBytes: 10_000,
    });
    const service = new SearchService({ account: 'me', includeBody: false, lite: true });
    expect(await service.loadFromCache()).toBe(2);
    expect(service.entries.every((e) => e.body === undefined)).toBe(true);
    expect(service.sizeBytes).toBeLessThan(1000);
    // and the lighter copy is saved
    await vi.runAllTimersAsync();
    const saved = stored.get('me:messages_v1')!;
    expect(JSON.stringify(saved.data)).not.toContain('xxxxx');
  });

  it('keeps prefix search for subjects and matches whole words in previews (lite)', () => {
    const service = new SearchService({ account: 'me', lite: true });
    service.addEntry(doc('m1'));
    const candidates = service.entries;
    expect(ids(service.search('quart', candidates))).toEqual(['m1']);
    expect(ids(service.search('deadline', candidates))).toEqual(['m1']);
    expect(service.search('deadl', candidates)).toEqual([]);

    const full = new SearchService({ account: 'me' });
    full.addEntry(doc('m1'));
    expect(ids(full.search('deadl', full.entries))).toEqual(['m1']);
  });

  it('leaves the index alone for an update that does not change its text', () => {
    const service = new SearchService({ account: 'me', lite: true });
    service.addEntry(doc('m1'));
    const remove = vi.spyOn(service.index, 'remove');
    service.updateEntry({ ...doc('m1'), folder: 'Archive', flags: ['\\Seen'] });
    expect(remove).not.toHaveBeenCalled();
    expect(service.entries[0].folder).toBe('Archive');

    service.updateEntry({ ...doc('m1'), subject: 'renamed' });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(ids(service.search('renamed', service.entries))).toEqual(['m1']);
  });

  it('reports the folder of a moved message in a search across folders', async () => {
    const service = new SearchService({ account: 'me' });
    service.addEntry(doc('m1'));
    service.updateEntry({ ...doc('m1'), folder: 'Archive' });
    const hits = await service.searchAllFolders('quarterly');
    expect(hits.map((h) => [h.id, h.folder])).toEqual([['m1', 'Archive']]);
  });

  it('builds the index again for a large removal instead of removing one at a time', () => {
    const service = new SearchService({ account: 'me', lite: true });
    for (let i = 0; i < 520; i += 1) service.addEntry(doc(`m${i}`));
    const remove = vi.spyOn(service.index, 'remove');
    service.removeEntriesByIds(Array.from({ length: 500 }, (_, i) => `m${i}`));
    expect(remove).not.toHaveBeenCalled();
    expect(service.size()).toBe(20);
    expect(ids(service.search('quarterly', service.entries))).toHaveLength(20);
    expect(service.search('m5', service.entries).map((r) => r.id)).not.toContain('m5');

    // a few are still removed one by one
    service.removeEntriesByIds(['m500', 'm501']);
    expect(service.size()).toBe(18);
  });
});
