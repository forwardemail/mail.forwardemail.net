import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import { throttledDerived } from '../../src/utils/store-utils';

describe('throttledDerived', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('applies the first change after a quiet period at once', () => {
    const source = writable(['a']);
    const out = throttledDerived([source], ([list]) => list.length, 0, 32);
    const stop = out.subscribe(() => {});
    vi.advanceTimersByTime(100);
    // A folder switch: the new list must show without waiting a window.
    source.set(['x', 'y', 'z']);
    expect(get(out)).toBe(3);
    stop();
  });

  it('coalesces changes inside the window into one trailing run with the latest value', () => {
    const source = writable(1);
    const fn = vi.fn(([n]: [number]) => n * 10);
    const out = throttledDerived([source], fn, 0, 32);
    const stop = out.subscribe(() => {});
    expect(get(out)).toBe(10);
    source.set(2);
    source.set(3);
    source.set(4);
    // Still inside the window opened by the first run
    expect(get(out)).toBe(10);
    vi.advanceTimersByTime(32);
    expect(get(out)).toBe(40);
    // One run at subscribe, one trailing run for the burst
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
  });

  it('runs at once again after the window has passed', () => {
    const source = writable(1);
    const out = throttledDerived([source], ([n]) => n, 0, 32);
    const stop = out.subscribe(() => {});
    vi.advanceTimersByTime(40);
    source.set(5);
    expect(get(out)).toBe(5);
    stop();
  });
});
