/**
 * hasMorePages() — drives `hasNextPage` from the cache read. The desktop bug
 * was that pagination stalled at the locally-synced subset because only the
 * cached count was consulted; consulting the server total too lets infinite
 * scroll continue (the next-page fetch pulls from the API). Pin the matrix.
 */
import { describe, it, expect } from 'vitest';
import { hasMorePages } from '../../src/utils/pagination.js';

describe('hasMorePages', () => {
  it('is true when the cache alone has more than the current page covers', () => {
    expect(hasMorePages({ cachedCount: 150, serverTotal: null, offset: 0, limit: 100 })).toBe(true);
  });

  it('is false when the cache is exhausted and the server total is unknown', () => {
    expect(hasMorePages({ cachedCount: 100, serverTotal: null, offset: 0, limit: 100 })).toBe(
      false,
    );
  });

  it('is true when the server has more even though the cache is exhausted (the desktop bug)', () => {
    expect(hasMorePages({ cachedCount: 100, serverTotal: 500, offset: 0, limit: 100 })).toBe(true);
  });

  it('is false at the true end of the folder (cache and server agree)', () => {
    expect(hasMorePages({ cachedCount: 100, serverTotal: 100, offset: 0, limit: 100 })).toBe(false);
  });

  it('accounts for the page offset', () => {
    // On page 5 (offset 400, limit 100) the current page ends at index 500.
    // 450 cached -> last page is partial, nothing beyond -> false.
    expect(hasMorePages({ cachedCount: 450, serverTotal: null, offset: 400, limit: 100 })).toBe(
      false,
    );
    // 600 cached -> a full page beyond index 500 exists -> true.
    expect(hasMorePages({ cachedCount: 600, serverTotal: null, offset: 400, limit: 100 })).toBe(
      true,
    );
  });

  it('ignores a non-finite server total', () => {
    expect(hasMorePages({ cachedCount: 100, serverTotal: NaN, offset: 0, limit: 100 })).toBe(false);
    expect(hasMorePages({ cachedCount: 100, serverTotal: undefined, offset: 0, limit: 100 })).toBe(
      false,
    );
  });
});
