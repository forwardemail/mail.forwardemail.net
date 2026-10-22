import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ getBuildInfo: vi.fn() }));

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  isTauriDesktop: false,
  isTauriMacOS: false,
  isTauriMobile: true,
  getPlatform: () => 'ios',
}));

vi.mock('../../src/utils/tauri-bridge.js', () => ({
  getBuildInfo: (...args: unknown[]) => bridge.getBuildInfo(...args),
}));

import { readBootHistory, recordBoot, summarizeBootHistory } from '../../src/utils/boot-history';
import { checkMemory, checkPageReloads, checkStorageUsage } from '../../src/utils/diagnostics';

const memoryStore = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

// The "screen keeps flashing" report: iOS kills the page and the app
// reloads it. The page cannot see the kill, only that the page before it was
// still on screen when it ended.
describe('page load history', () => {
  it('tells a page that died on screen from one closed in the background', () => {
    const store = memoryStore();
    const first = recordBoot(store, 1_000);
    expect(first?.previousEndedOnScreen).toBeNull();

    // Killed while visible: nothing cleared the marker
    expect(recordBoot(store, 2_000)?.previousEndedOnScreen).toBe(true);

    // Put in the background (visibilitychange hidden), then closed by iOS
    store.setItem('fe_page_visible', '0');
    expect(recordBoot(store, 3_000)?.previousEndedOnScreen).toBe(false);

    expect(readBootHistory(store).map((e) => e.previousEndedOnScreen)).toEqual([null, true, false]);
  });

  it('counts only loads inside the window', () => {
    const hour = 60 * 60_000;
    const now = 10 * hour;
    const history = [
      { at: now - 3 * hour, previousEndedOnScreen: true },
      { at: now - 20 * 60_000, previousEndedOnScreen: true },
      { at: now - 10 * 60_000, previousEndedOnScreen: true },
      { at: now - 60_000, previousEndedOnScreen: false },
    ];
    expect(summarizeBootHistory(history, now)).toEqual({
      loads: 3,
      endedOnScreen: 2,
      recovered: 0,
    });
  });

  it('keeps the last 30 loads', () => {
    const store = memoryStore();
    for (let i = 0; i < 40; i++) recordBoot(store, i);
    const history = readBootHistory(store);
    expect(history).toHaveLength(30);
    expect(history[0].at).toBe(10);
  });

  it('survives a corrupt history', () => {
    const store = memoryStore();
    store.setItem('fe_boot_history', '{not json');
    expect(readBootHistory(store)).toEqual([]);
    expect(recordBoot(store, 5)?.at).toBe(5);
  });
});

describe('recovery reloads', () => {
  // A fresh copy of the module per test: it remembers this page's own load
  const fresh = async () => {
    vi.resetModules();
    return import('../../src/utils/boot-history');
  };

  it('marks this load when the native side reports before the load is recorded', async () => {
    const store = memoryStore();
    const history = await fresh();
    history.recordBoot(store, 1_000);
    const next = await fresh();
    // Crash loop: the previous load is seconds old and must stay unmarked
    next.markRendererRecovered(store);
    next.recordBoot(store, 4_000);
    expect(next.readBootHistory(store).map((e) => e.rendererRecovered === true)).toEqual([
      false,
      true,
    ]);
  });

  it('marks this load when the report comes after it was recorded', async () => {
    const store = memoryStore();
    const history = await fresh();
    history.recordBoot(store, 1_000);
    const next = await fresh();
    next.recordBoot(store, 4_000);
    next.markRendererRecovered(store);
    next.markRendererRecovered(store);
    expect(next.readBootHistory(store).map((e) => e.rendererRecovered === true)).toEqual([
      false,
      true,
    ]);
    expect(next.summarizeBootHistory(next.readBootHistory(store), 5_000).recovered).toBe(1);
  });
});

describe('checkPageReloads', () => {
  beforeEach(() => localStorage.clear());

  it('warns when the page died on screen twice within the hour', async () => {
    const now = Date.now();
    localStorage.setItem(
      'fe_boot_history',
      JSON.stringify([
        { at: now - 5 * 60_000, previousEndedOnScreen: false },
        { at: now - 4 * 60_000, previousEndedOnScreen: true },
        { at: now - 3 * 60_000, previousEndedOnScreen: true },
      ]),
    );
    const result = await checkPageReloads();
    expect(result.status).toBe('warn');
    expect(result.message).toBe(
      '3 loads in the last hour, 2 after the page died on screen (2 today)',
    );
  });

  it('passes for an ordinary launch', async () => {
    localStorage.setItem(
      'fe_boot_history',
      JSON.stringify([{ at: Date.now() - 1000, previousEndedOnScreen: false }]),
    );
    expect((await checkPageReloads()).status).toBe('pass');
  });
});

describe('checkMemory on an iPhone', () => {
  it('reports the model and RAM the app gives, since WebKit reports no heap', async () => {
    bridge.getBuildInfo.mockResolvedValueOnce({
      version: '0.15.5',
      deviceModel: 'iPhone14,6',
      memoryBytes: String(4 * 1024 ** 3),
      osVersion: '26.0.1',
    });
    const result = await checkMemory();
    expect(result.status).toBe('pass');
    expect(result.message).toBe('iPhone14,6, device 4.0 GB');
    expect(result.detail).toMatchObject({ deviceModel: 'iPhone14,6', osVersion: '26.0.1' });
  });
});

describe('checkStorageUsage', () => {
  const realStorage = navigator.storage;
  const withEstimate = (usage: number, quota: number) =>
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ usage, quota }),
        persisted: async () => true,
      },
    });

  beforeEach(() => {
    Object.defineProperty(navigator, 'storage', { configurable: true, value: realStorage });
  });

  it('warns about a cache in the gigabytes', async () => {
    withEstimate(3.2 * 1024 ** 3, 60 * 1024 ** 3);
    const result = await checkStorageUsage();
    expect(result.status).toBe('warn');
    expect(result.message).toBe('3.2 GB used of 60.0 GB');
  });

  it('passes a modest cache', async () => {
    withEstimate(180 * 1024 ** 2, 60 * 1024 ** 3);
    const result = await checkStorageUsage();
    expect(result.status).toBe('pass');
    expect(result.message).toBe('180 MB used of 60.0 GB');
  });
});
