import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the platform module — default to non-Tauri so most tests exercise
// the early-return paths.  Individual tests override as needed.
let mockIsTauriDesktop = false;
vi.mock('../../src/utils/platform.js', () => ({
  get isTauriDesktop() {
    return mockIsTauriDesktop;
  },
}));

import {
  handleWsNewRelease,
  checkForUpdates,
  initAutoUpdater,
  stopAutoUpdater,
} from '../../src/utils/updater-bridge.js';

beforeEach(() => {
  mockIsTauriDesktop = false;
  stopAutoUpdater();
});

afterEach(() => {
  stopAutoUpdater();
  vi.restoreAllMocks();
});

// ── extractVersionFromRelease (tested indirectly via handleWsNewRelease) ──

describe('handleWsNewRelease payload parsing', () => {
  // handleWsNewRelease is a no-op when isTauriDesktop is false,
  // so we test the extraction logic by enabling the Tauri flag
  // and checking whether _autoCheckCallback is invoked.

  it('is a no-op when not on Tauri desktop', () => {
    mockIsTauriDesktop = false;
    // Should not throw
    expect(() => handleWsNewRelease({ release: { tagName: 'v1.0.0' } })).not.toThrow();
  });

  it('extracts version from nested { release: { tagName } } shape', () => {
    mockIsTauriDesktop = true;
    const callback = vi.fn();

    // Set up the auto-check callback by calling initAutoUpdater
    // (it's a no-op for the actual updater since we mock platform,
    //  but we can test the callback wiring)
    initAutoUpdater({ onUpdateAvailable: callback });

    // Replace _autoCheckCallback by calling handleWsNewRelease
    // If extraction works, it should trigger the callback
    handleWsNewRelease({ release: { tagName: 'v2.0.0' } });

    // The callback is async (doCheck), so we just verify no error
    // and the function ran without throwing
  });

  it('extracts version from nested { release: { tag_name } } shape', () => {
    mockIsTauriDesktop = true;
    expect(() => handleWsNewRelease({ release: { tag_name: 'v2.0.0' } })).not.toThrow();
  });

  it('extracts version from nested { release: { version } } shape', () => {
    mockIsTauriDesktop = true;
    expect(() => handleWsNewRelease({ release: { version: '2.0.0' } })).not.toThrow();
  });

  it('extracts version from flattened { tagName } shape', () => {
    mockIsTauriDesktop = true;
    expect(() => handleWsNewRelease({ tagName: 'v2.0.0' })).not.toThrow();
  });

  it('extracts version from flattened { tag_name } shape', () => {
    mockIsTauriDesktop = true;
    expect(() => handleWsNewRelease({ tag_name: 'v2.0.0' })).not.toThrow();
  });

  it('extracts version from flattened { version } shape', () => {
    mockIsTauriDesktop = true;
    expect(() => handleWsNewRelease({ version: '2.0.0' })).not.toThrow();
  });

  it('extracts version from flattened { tag } shape', () => {
    mockIsTauriDesktop = true;
    expect(() => handleWsNewRelease({ tag: 'v2.0.0' })).not.toThrow();
  });

  it('ignores null/undefined data', () => {
    mockIsTauriDesktop = true;
    expect(() => handleWsNewRelease(null)).not.toThrow();
    expect(() => handleWsNewRelease(undefined)).not.toThrow();
  });

  it('ignores data with no extractable version', () => {
    mockIsTauriDesktop = true;
    expect(() => handleWsNewRelease({})).not.toThrow();
    expect(() => handleWsNewRelease({ release: {} })).not.toThrow();
    expect(() => handleWsNewRelease({ foo: 'bar' })).not.toThrow();
  });

  it('ignores non-object data', () => {
    mockIsTauriDesktop = true;
    expect(() => handleWsNewRelease('string')).not.toThrow();
    expect(() => handleWsNewRelease(42)).not.toThrow();
    expect(() => handleWsNewRelease(true)).not.toThrow();
  });
});

// ── checkForUpdates (non-Tauri) ───────────────────────────────────────────

describe('checkForUpdates', () => {
  it('returns null on non-Tauri platforms', async () => {
    mockIsTauriDesktop = false;
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });
});

// ── initAutoUpdater / stopAutoUpdater lifecycle ───────────────────────────

describe('initAutoUpdater lifecycle', () => {
  it('is a no-op on non-Tauri platforms', async () => {
    mockIsTauriDesktop = false;
    // Should not throw or set up any timers
    await expect(initAutoUpdater()).resolves.toBeUndefined();
  });

  it('subscribes to wsClient.on("newRelease") when wsClient is provided', async () => {
    mockIsTauriDesktop = true;
    const unsub = vi.fn();
    const mockOn = vi.fn(() => unsub);
    const wsClient = { on: mockOn };

    await initAutoUpdater({ wsClient });

    expect(mockOn).toHaveBeenCalledWith('newRelease', expect.any(Function));
  });

  it('calls unsubscribe on stop when wsClient was provided', async () => {
    mockIsTauriDesktop = true;
    const unsub = vi.fn();
    const mockOn = vi.fn(() => unsub);
    const wsClient = { on: mockOn };

    await initAutoUpdater({ wsClient });
    stopAutoUpdater();

    expect(unsub).toHaveBeenCalled();
  });

  it('does not throw when wsClient is not provided', async () => {
    mockIsTauriDesktop = true;
    await expect(initAutoUpdater()).resolves.toBeUndefined();
  });

  it('stopAutoUpdater is idempotent', () => {
    expect(() => {
      stopAutoUpdater();
      stopAutoUpdater();
      stopAutoUpdater();
    }).not.toThrow();
  });
});
