import 'fake-indexeddb/auto';
import { vi } from 'vitest';

// fake-indexeddb installs IDBFactory/IDBKeyRange/etc. on globalThis, which is
// what Dexie looks for. We also need a few browser APIs Dexie touches.

if (typeof globalThis.structuredClone === 'undefined') {
  (globalThis as unknown as { structuredClone: typeof structuredClone }).structuredClone = (v) =>
    JSON.parse(JSON.stringify(v));
}

if (!('storage' in navigator)) {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 50_000_000 }),
    },
  });
}
