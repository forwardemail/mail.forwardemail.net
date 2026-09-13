import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ desktop: true }));
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  get isTauriDesktop() {
    return platform.desktop;
  },
  isTauriMobile: false,
  getPlatform: () => 'macos',
}));

vi.mock('../../src/utils/tauri-bridge.js', () => ({
  invoke: (...args: unknown[]) => bridge.invoke(...args),
}));

import { checkRendererWatchdog } from '../../src/utils/diagnostics';

// The watchdog reload count is the only trace a renderer death leaves; the
// check has to surface it on a support report without touching anything.
describe('checkRendererWatchdog', () => {
  beforeEach(() => {
    platform.desktop = true;
    bridge.invoke.mockReset();
  });

  it('passes when the page is answering and nothing was reloaded', async () => {
    bridge.invoke.mockResolvedValueOnce({
      reloads: 0,
      lastReloadUnixMs: null,
      missed: 0,
      armed: true,
    });

    const result = await checkRendererWatchdog();

    expect(bridge.invoke).toHaveBeenCalledWith('renderer_watchdog_status');
    expect(result.status).toBe('pass');
    expect(result.detail).toMatchObject({ reloads: 0, lastReloadAt: null, armed: true });
  });

  it('warns with the count and time when the renderer was reloaded', async () => {
    bridge.invoke.mockResolvedValueOnce({
      reloads: 2,
      lastReloadUnixMs: Date.UTC(2026, 8, 13, 15, 0, 0),
      missed: 0,
      armed: true,
    });

    const result = await checkRendererWatchdog();

    expect(result.status).toBe('warn');
    expect(result.message).toBe('Renderer reloaded 2 times this session');
    expect(result.detail).toMatchObject({ reloads: 2, lastReloadAt: '2026-09-13T15:00:00.000Z' });
  });

  it('warns when the page has never answered, since a reload could not fire', async () => {
    bridge.invoke.mockResolvedValueOnce({
      reloads: 0,
      lastReloadUnixMs: null,
      missed: 3,
      armed: false,
    });

    const result = await checkRendererWatchdog();

    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/not answered/);
  });

  it('fails rather than passes when the command is blocked or missing', async () => {
    bridge.invoke.mockResolvedValueOnce(undefined);

    expect((await checkRendererWatchdog()).status).toBe('fail');
  });

  it('skips off desktop', async () => {
    platform.desktop = false;

    const result = await checkRendererWatchdog();

    expect(result.status).toBe('skip');
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
});
