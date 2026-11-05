import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn(async () => null));

vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('runMacOSSelfHeal', () => {
  beforeEach(() => {
    invoke.mockClear();
    localStorage.clear();
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('flushes LaunchServices once per app version', async () => {
    const { runMacOSSelfHeal } = await import('../../src/utils/self-heal-macos.ts');

    vi.stubEnv('VITE_PKG_VERSION', '1.0.1');
    await runMacOSSelfHeal();
    await runMacOSSelfHeal();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('self_heal_flush_launch_services');

    // The first launch after an update flushes again.
    vi.stubEnv('VITE_PKG_VERSION', '1.0.2');
    await runMacOSSelfHeal();
    await runMacOSSelfHeal();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('does not flush on other platforms', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const { runMacOSSelfHeal } = await import('../../src/utils/self-heal-macos.ts');
    await runMacOSSelfHeal();
    expect(invoke).not.toHaveBeenCalled();
  });
});
