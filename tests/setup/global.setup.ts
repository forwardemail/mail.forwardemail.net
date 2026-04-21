import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom doesn't implement a few browser APIs our code / libraries touch during
// module initialization. Provide the minimum viable polyfills so the import
// graph doesn't crash before tests run.

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
