import { describe, it, expect } from 'vitest';
import {
  shallowArrayEqual,
  shallowObjectEqual,
  createMemoCache,
  memoize,
} from '../../src/utils/store-utils.ts';

describe('shallowArrayEqual', () => {
  it('returns true for identical references', () => {
    const arr = [1, 2, 3];
    expect(shallowArrayEqual(arr, arr)).toBe(true);
  });

  it('returns true for arrays with same elements', () => {
    expect(shallowArrayEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(shallowArrayEqual([], [])).toBe(true);
  });

  it('returns false for different lengths', () => {
    expect(shallowArrayEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('returns false for different elements', () => {
    expect(shallowArrayEqual([1, 2, 3], [1, 2, 4])).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(shallowArrayEqual(null, [1])).toBe(false);
    expect(shallowArrayEqual([1], null)).toBe(false);
    expect(shallowArrayEqual(null, null)).toBe(false);
    expect(shallowArrayEqual(undefined, undefined)).toBe(false);
  });

  it('uses strict equality (===) not deep', () => {
    const obj = { a: 1 };
    expect(shallowArrayEqual([obj], [obj])).toBe(true);
    expect(shallowArrayEqual([{ a: 1 }], [{ a: 1 }])).toBe(false);
  });
});

describe('shallowObjectEqual', () => {
  it('returns true for identical references', () => {
    const obj = { a: 1 };
    expect(shallowObjectEqual(obj, obj)).toBe(true);
  });

  it('returns true for objects with same keys/values', () => {
    expect(shallowObjectEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(shallowObjectEqual({}, {})).toBe(true);
  });

  it('returns false for different key counts', () => {
    expect(shallowObjectEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('returns false for different values', () => {
    expect(shallowObjectEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('returns false for missing keys', () => {
    expect(shallowObjectEqual({ a: 1 }, { b: 1 })).toBe(false);
  });

  it('returns false when one side is null', () => {
    expect(shallowObjectEqual(null, {})).toBe(false);
    expect(shallowObjectEqual({}, null)).toBe(false);
  });

  it('returns true when both are null (reference equality)', () => {
    expect(shallowObjectEqual(null, null)).toBe(true);
  });
});

describe('createMemoCache', () => {
  it('stores and retrieves values', () => {
    const cache = createMemoCache();
    cache.set('key', 'value');
    expect(cache.has('key')).toBe(true);
    expect(cache.get('key')).toBe('value');
  });

  it('returns undefined for missing keys', () => {
    const cache = createMemoCache();
    expect(cache.has('nope')).toBe(false);
    expect(cache.get('nope')).toBeUndefined();
  });

  it('evicts oldest entry when at capacity', () => {
    const cache = createMemoCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // should evict 'a'
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('clears all entries', () => {
    const cache = createMemoCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
  });

  it('tracks size correctly', () => {
    const cache = createMemoCache();
    expect(cache.size).toBe(0);
    cache.set('a', 1);
    expect(cache.size).toBe(1);
  });
});

describe('memoize', () => {
  it('caches function results', () => {
    let callCount = 0;
    const fn = (x) => {
      callCount++;
      return x * 2;
    };
    const memoized = memoize(fn);

    expect(memoized(5)).toBe(10);
    expect(memoized(5)).toBe(10);
    expect(callCount).toBe(1);
  });

  it('computes different results for different args', () => {
    const memoized = memoize((x) => x * 2);
    expect(memoized(3)).toBe(6);
    expect(memoized(4)).toBe(8);
  });

  it('respects maxSize', () => {
    let callCount = 0;
    const fn = (x) => {
      callCount++;
      return x;
    };
    const memoized = memoize(fn, 2);

    memoized(1);
    memoized(2);
    memoized(3); // evicts 1
    callCount = 0;

    memoized(1); // should recompute (was evicted)
    expect(callCount).toBe(1);

    memoized(3); // still cached
    expect(callCount).toBe(1);
  });
});
