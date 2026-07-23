import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalUserAgent = navigator.userAgent;

function setUserAgent(value) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value,
  });
}

function setNativePlatform(value) {
  window.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: value };
}

describe('native mobile platform detection', () => {
  beforeEach(() => {
    vi.resetModules();
    window.__TAURI_INTERNALS__ = {};
    setUserAgent('ForwardEmail/1.0 WebView');
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI_OS_PLUGIN_INTERNALS__;
    setUserAgent(originalUserAgent);
  });

  it.each([
    ['ios', 'ios'],
    ['android', 'android'],
  ])('detects Tauri %s without relying on the user agent', async (platform, expected) => {
    setNativePlatform(platform);

    const detected = await import('../../src/utils/platform.js');

    expect(detected.nativePlatform).toBe(expected);
    expect(detected.isTauriMobile).toBe(true);
    expect(detected.isTauriDesktop).toBe(false);
  });

  it('keeps Tauri desktop builds out of mobile-only settings and lifecycle code', async () => {
    setNativePlatform('macos');

    const detected = await import('../../src/utils/platform.js');

    expect(detected.nativePlatform).toBe('macos');
    expect(detected.isTauriMobile).toBe(false);
    expect(detected.isTauriDesktop).toBe(true);
    expect(detected.getOS()).toBe('macos');
  });

  it('falls back to the mobile user agent when the OS plugin value is unavailable', async () => {
    setUserAgent('ForwardEmail/1.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');

    const detected = await import('../../src/utils/platform.js');

    expect(detected.nativePlatform).toBe('ios');
    expect(detected.isTauriMobile).toBe(true);
  });
});
