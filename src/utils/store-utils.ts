import { derived, type Readable } from 'svelte/store';

type StoreValue<T> = T extends Readable<infer U> ? U : never;
type StoreValues<T extends Readable<unknown>[]> = { [K in keyof T]: StoreValue<T[K]> };

/**
 * Creates a derived store that debounces expensive computations
 * Useful for operations that don't need to run immediately on every change
 */
export function debouncedDerived<S extends Readable<unknown>, T>(
  stores: S,
  fn: (value: StoreValue<S>) => T,
  initialValue: T,
  delay?: number,
): Readable<T>;
export function debouncedDerived<S extends Readable<unknown>[], T>(
  stores: S,
  fn: (values: StoreValues<S>) => T,
  initialValue: T,
  delay?: number,
): Readable<T>;
export function debouncedDerived<T>(
  stores: Readable<unknown> | Readable<unknown>[],
  fn: (value: unknown) => T,
  initialValue: T,
  delay: number = 16,
): Readable<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstRun = true;

  return derived(
    stores as Readable<unknown>,
    ($values: unknown, set: (value: T) => void) => {
      // Run immediately on first invocation
      if (firstRun) {
        firstRun = false;
        const result = fn($values);
        set(result);
        return;
      }

      // Debounce subsequent updates
      if (timer) clearTimeout(timer);

      timer = setTimeout(() => {
        const result = fn($values);
        set(result);
      }, delay);

      return () => {
        if (timer) clearTimeout(timer);
      };
    },
    initialValue,
  );
}

/**
 * Like debouncedDerived, but the first change after a quiet period is applied
 * at once and only the changes that follow within `delay` are coalesced into
 * one trailing run.
 *
 * A trailing debounce delays every update, including the one that matters
 * most: the list for a folder just opened, or the row just archived. That put
 * a blank list, or the previous folder's rows, on screen for one debounce
 * window. This keeps the coalescing for bursts of ticks without that delay.
 */
export function throttledDerived<S extends Readable<unknown>[], T>(
  stores: S,
  fn: (values: StoreValues<S>) => T,
  initialValue: T,
  delay: number = 16,
): Readable<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRun = -Infinity;
  let latest: unknown;

  return derived(
    stores as unknown as Readable<unknown>,
    ($values: unknown, set: (value: T) => void) => {
      latest = $values;
      const run = () => {
        timer = null;
        lastRun = Date.now();
        set(fn(latest as StoreValues<S>));
      };
      if (timer === null && Date.now() - lastRun >= delay) {
        run();
        return;
      }
      if (timer === null) {
        timer = setTimeout(run, Math.max(0, lastRun + delay - Date.now()));
      }
    },
    initialValue,
  );
}

/**
 * Creates a derived store that uses requestIdleCallback for non-urgent computations
 * Computations run when the browser is idle, improving responsiveness
 */
export function idleDerived<S extends Readable<unknown>, T>(
  stores: S,
  fn: (value: StoreValue<S>) => T,
  initialValue: T,
  timeout?: number,
): Readable<T>;
export function idleDerived<S extends Readable<unknown>[], T>(
  stores: S,
  fn: (values: StoreValues<S>) => T,
  initialValue: T,
  timeout?: number,
): Readable<T>;
export function idleDerived<T>(
  stores: Readable<unknown> | Readable<unknown>[],
  fn: (value: unknown) => T,
  initialValue: T,
  timeout: number = 100,
): Readable<T> {
  let handle: number | ReturnType<typeof setTimeout> | null = null;
  const hasIdleCallback = typeof requestIdleCallback !== 'undefined';

  return derived(
    stores as Readable<unknown>,
    ($values: unknown, set: (value: T) => void) => {
      if (handle) {
        if (hasIdleCallback) {
          cancelIdleCallback(handle as number);
        } else {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        }
      }

      if (hasIdleCallback) {
        handle = requestIdleCallback(
          () => {
            const result = fn($values);
            set(result);
          },
          { timeout },
        );
      } else {
        // Fallback to setTimeout if requestIdleCallback not available
        handle = setTimeout(() => {
          const result = fn($values);
          set(result);
        }, 16);
      }

      return () => {
        if (handle) {
          if (hasIdleCallback) {
            cancelIdleCallback(handle as number);
          } else {
            clearTimeout(handle as ReturnType<typeof setTimeout>);
          }
        }
      };
    },
    initialValue,
  );
}

/**
 * Shallow array equality check
 * Returns true if arrays have same length and same elements (===)
 */
export function shallowArrayEqual<T>(
  a: T[] | null | undefined,
  b: T[] | null | undefined,
): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }

  return true;
}

/**
 * Shallow object equality check
 * Returns true if objects have same keys and same values (===)
 */
export function shallowObjectEqual(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (a[key] !== b[key]) return false;
  }

  return true;
}

export interface MemoCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  clear(): void;
  readonly size: number;
}

/**
 * Creates a memoization cache with optional size limit
 */
export function createMemoCache<K, V>(maxSize: number = 1000): MemoCache<K, V> {
  const cache = new Map<K, V>();

  return {
    get(key: K): V | undefined {
      return cache.get(key);
    },

    set(key: K, value: V): void {
      // Simple LRU: if cache is full, delete oldest entry
      if (cache.size >= maxSize) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) {
          cache.delete(firstKey);
        }
      }
      cache.set(key, value);
    },

    has(key: K): boolean {
      return cache.has(key);
    },

    clear(): void {
      cache.clear();
    },

    get size(): number {
      return cache.size;
    },
  };
}

/**
 * Creates a memoized version of a function
 * Uses a simple Map-based cache with LRU eviction
 */
export function memoize<T, R>(fn: (arg: T) => R, maxSize: number = 1000): (arg: T) => R {
  const cache = createMemoCache<T, R>(maxSize);

  return function memoized(arg: T): R {
    if (cache.has(arg)) {
      return cache.get(arg)!;
    }

    const result = fn(arg);
    cache.set(arg, result);
    return result;
  };
}
