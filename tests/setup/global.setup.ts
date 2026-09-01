import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom doesn't implement a few browser APIs our code / libraries touch during
// module initialization. Provide the minimum viable polyfills so the import
// graph doesn't crash before tests run.

// Node 23+ ships its own WebStorage globals. Without a --localstorage-file
// flag the built-in localStorage resolves to undefined, and because the
// property already exists on the worker global it shadows the working jsdom
// implementation vitest would otherwise install. Rebind both storages to
// jsdom's so tests get real, per-environment storage on every Node version.
const ensureWebStorage = (key: 'localStorage' | 'sessionStorage') => {
  const isUsable = (value: unknown): value is Storage =>
    Boolean(value) && typeof (value as Storage).clear === 'function';

  let current: unknown;
  try {
    current = (globalThis as Record<string, unknown>)[key];
  } catch {
    current = undefined;
  }

  // Prefer jsdom's storage: the jsdom window keeps its own reference even
  // when the worker global's property was shadowed by Node's.
  let replacement: Storage | undefined;
  try {
    const win = (globalThis as { window?: Window }).window;
    const fromWindow = win?.[key];
    if (isUsable(fromWindow)) replacement = fromWindow;
  } catch {
    // jsdom can throw on cross-origin access; fall through to the shim.
  }

  if (current === replacement && isUsable(current)) return;

  if (!replacement) {
    if (isUsable(current)) return;
    // Last resort: a spec-shaped in-memory Storage.
    const backing = new Map<string, string>();
    replacement = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (k: string) => (backing.has(k) ? (backing.get(k) ?? null) : null),
      key: (i: number) => [...backing.keys()][i] ?? null,
      removeItem: (k: string) => {
        backing.delete(k);
      },
      setItem: (k: string, v: string) => {
        backing.set(String(k), String(v));
      },
    } as Storage;
  }

  try {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: replacement,
    });
  } catch {
    (globalThis as Record<string, unknown>)[key] = replacement;
  }
};
ensureWebStorage('localStorage');
ensureWebStorage('sessionStorage');

if (!('storage' in navigator)) {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 50_000_000 }),
    },
  });
}

if (typeof globalThis.BroadcastChannel === 'undefined') {
  class NoopBroadcastChannel {
    name: string;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor(name: string) {
      this.name = name;
    }
    postMessage() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
  (globalThis as unknown as { BroadcastChannel: typeof NoopBroadcastChannel }).BroadcastChannel =
    NoopBroadcastChannel;
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver =
    NoopResizeObserver;
}

if (typeof globalThis.structuredClone === 'undefined') {
  (globalThis as unknown as { structuredClone: typeof structuredClone }).structuredClone = (v) =>
    JSON.parse(JSON.stringify(v));
}

if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  // `writable: true` + `configurable: true` so tests can replace matchMedia
  // with their own mock (e.g. system-theme-listener.test.js assigns directly).
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
