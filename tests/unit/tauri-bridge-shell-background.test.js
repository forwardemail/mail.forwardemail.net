const invoke = vi.fn(async () => undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(), emit: vi.fn() }));

describe('setShellBackground', () => {
  it('sends the theme to the native set_shell_background command', async () => {
    const { setShellBackground } = await import('../../src/utils/tauri-bridge.js');
    await setShellBackground(true);
    await setShellBackground(0);
    // An unknown name would be dropped by the bridge's allow-list with a
    // warning, and the native strips would never change color.
    expect(invoke.mock.calls).toEqual([
      ['set_shell_background', { dark: true }],
      ['set_shell_background', { dark: false }],
    ]);
  });
});
