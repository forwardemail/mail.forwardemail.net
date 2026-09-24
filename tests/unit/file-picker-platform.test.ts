/**
 * iOS is not macOS.
 *
 * The macOS-only save/open panel commands (save_file_macos, pick_files_macos)
 * are registered only in macOS builds. The old navigator.platform test matched
 * "iPhone" and "iPad", so every attachment download on iOS called a command
 * that does not exist there and failed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadWith(nativePlatform: string | null, navigatorPlatform = '') {
  vi.resetModules();
  vi.doMock('../../src/utils/platform.js', () => ({
    isTauriDesktop: nativePlatform !== 'ios' && nativePlatform !== 'android',
    nativePlatform,
  }));
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(navigatorPlatform);
  return import('../../src/utils/file-picker');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/utils/platform.js');
});

describe('isMacOSPlatform', () => {
  it('is false on iOS even though navigator.platform says iPhone', async () => {
    const { isMacOSPlatform } = await loadWith('ios', 'iPhone');
    expect(isMacOSPlatform).toBe(false);
  });

  it('is false on iPadOS, which reports a Mac platform string', async () => {
    const { isMacOSPlatform } = await loadWith('ios', 'MacIntel');
    expect(isMacOSPlatform).toBe(false);
  });

  it('is true on the macOS desktop app', async () => {
    const { isMacOSPlatform } = await loadWith('macos', 'MacIntel');
    expect(isMacOSPlatform).toBe(true);
  });

  it('is false on Windows and Linux', async () => {
    expect((await loadWith('windows', 'Win32')).isMacOSPlatform).toBe(false);
    expect((await loadWith('linux', 'Linux x86_64')).isMacOSPlatform).toBe(false);
  });
});
