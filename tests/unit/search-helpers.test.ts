import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../../src/types';
import { buildServerSearchParams, mergeResults } from '../../src/stores/search-helpers';

// parseSearchQuery is plain JS, so its `filters` type is effectively `any`.
// Build a full-shaped filters object so the tests read like real input.
const makeFilters = (overrides: Record<string, unknown> = {}) => ({
  from: [],
  to: [],
  subject: [],
  labels: [],
  isUnread: null,
  isStarred: null,
  hasAttachment: null,
  after: null,
  before: null,
  ...overrides,
});

const hit = (id: unknown, extra: Record<string, unknown> = {}): SearchResult =>
  ({ id, ...extra }) as unknown as SearchResult;

describe('buildServerSearchParams', () => {
  it('puts free text in the general search param with the base params', () => {
    expect(buildServerSearchParams('hello', makeFilters(), null, 50)).toEqual({
      limit: 50,
      page: 1,
      lightweight: true,
      raw: false,
      attachments: false,
      search: 'hello',
    });
  });

  it('maps from/to/subject arrays to space-joined params', () => {
    const params = buildServerSearchParams(
      '',
      makeFilters({ from: ['alice', 'bob'], to: ['carol'], subject: ['report', 'q3'] }),
      null,
      25,
    );
    expect(params).toMatchObject({ from: 'alice bob', to: 'carol', subject: 'report q3' });
  });

  it('maps boolean flags, but only when strictly true', () => {
    expect(
      buildServerSearchParams(
        'x',
        makeFilters({ isUnread: true, isStarred: true, hasAttachment: true }),
        null,
        10,
      ),
    ).toMatchObject({ is_unread: true, is_flagged: true, has_attachments: true });

    // isUnread === false (read filter) must NOT set is_unread
    const readOnly = buildServerSearchParams('x', makeFilters({ isUnread: false }), null, 10);
    expect(readOnly).not.toHaveProperty('is_unread');
  });

  it('converts after/before timestamps to ISO since/before', () => {
    const after = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00.000Z
    const before = Date.UTC(2026, 5, 1); // 2026-06-01T00:00:00.000Z
    const params = buildServerSearchParams('x', makeFilters({ after, before }), null, 10);
    expect(params).toMatchObject({
      since: '2026-01-01T00:00:00.000Z',
      before: '2026-06-01T00:00:00.000Z',
    });
  });

  it('includes a real folder but not the "all" sentinel', () => {
    expect(buildServerSearchParams('x', makeFilters(), 'Archive', 10)).toMatchObject({
      folder: 'Archive',
    });
    expect(buildServerSearchParams('x', makeFilters(), 'all', 10)).not.toHaveProperty('folder');
    expect(buildServerSearchParams('x', makeFilters(), null, 10)).not.toHaveProperty('folder');
  });

  it('returns null when no server-meaningful param is present', () => {
    // folder/flags/dates alone are not something the server text search can use
    expect(buildServerSearchParams('', makeFilters({ isUnread: true }), 'INBOX', 10)).toBeNull();
    expect(buildServerSearchParams('', makeFilters(), null, 10)).toBeNull();
  });

  it('still returns params when only a structured field (no free text) is set', () => {
    const params = buildServerSearchParams('', makeFilters({ from: ['alice'] }), null, 10);
    expect(params).toMatchObject({ from: 'alice' });
    expect(params).not.toHaveProperty('search');
  });
});

describe('mergeResults', () => {
  it('returns the local hits unchanged when there are no server hits', () => {
    const local = [hit('a')];
    expect(mergeResults(local, [])).toBe(local);
  });

  it('returns the server hits unchanged when there are no local hits', () => {
    const server = [hit('a')];
    expect(mergeResults([], server)).toBe(server);
  });

  it('dedupes by id with server results overwriting local (server is more complete)', () => {
    const local = [hit('a', { src: 'local' }), hit('b', { src: 'local' })];
    const server = [hit('b', { src: 'server' }), hit('c', { src: 'server' })];
    const merged = mergeResults(local, server);
    expect(merged).toEqual([
      { id: 'a', src: 'local' },
      { id: 'b', src: 'server' }, // overwritten, original position kept
      { id: 'c', src: 'server' },
    ]);
  });

  it('skips hits without an id', () => {
    const local = [hit('a'), hit(undefined)];
    const server = [hit(null), hit('b')];
    expect(mergeResults(local, server)).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});
