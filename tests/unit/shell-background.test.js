import { beforeEach, describe, expect, it, vi } from 'vitest';

// The strips around the iOS webview (status bar, home indicator) are native
// views painted through set_shell_background. On an iPad's sign-in screen the
// light theme's canvas left a light band above and below a dark page.

let platform;
const setShellBackground = vi.fn();

vi.mock('../../src/utils/platform.js', () => ({
  get isTauriMobile() {
    return platform !== 'web';
  },
  get nativePlatform() {
    return platform;
  },
}));
vi.mock('../../src/utils/tauri-bridge.js', () => ({
  setShellBackground: (...args) => setShellBackground(...args),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function load() {
  vi.resetModules();
  return (await import('../../src/utils/shell-background.js')).syncShellBackground;
}

beforeEach(() => {
  platform = 'ios';
  setShellBackground.mockReset();
  setShellBackground.mockResolvedValue(undefined);
});

describe('syncShellBackground', () => {
  it('paints the strips dark on the sign-in screen of an iPad in the light theme', async () => {
    const sync = await load();
    sync({ themeDark: false, route: 'login', width: 820 });
    await flush();
    expect(setShellBackground.mock.calls).toEqual([[true]]);
  });

  it('follows the theme once signed in, and on a phone-width sign-in', async () => {
    const sync = await load();
    sync({ themeDark: false, route: 'login', width: 820 });
    sync({ themeDark: false, route: 'mailbox', width: 820 });
    sync({ themeDark: false, route: 'login', width: 390 });
    sync({ themeDark: true, route: 'mailbox', width: 390 });
    await flush();
    expect(setShellBackground.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('sends nothing when the colour does not change', async () => {
    const sync = await load();
    sync({ themeDark: true, route: 'mailbox', width: 1180 });
    sync({ themeDark: true, route: 'login', width: 1180 });
    sync({ themeDark: true, route: 'settings', width: 820 });
    await flush();
    expect(setShellBackground).toHaveBeenCalledTimes(1);
  });

  it('sends one colour at a time, so a later one is never overtaken', async () => {
    let finishFirst;
    setShellBackground.mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = resolve)),
    );
    const sync = await load();
    sync({ themeDark: false, route: 'mailbox', width: 820 });
    sync({ themeDark: true, route: 'mailbox', width: 820 });
    await flush();
    expect(setShellBackground.mock.calls).toEqual([[false]]);

    finishFirst();
    await flush();
    expect(setShellBackground.mock.calls).toEqual([[false], [true]]);
  });

  it('tries the same colour again after a failed call', async () => {
    setShellBackground.mockRejectedValueOnce(new Error('webview not ready'));
    const sync = await load();
    sync({ themeDark: true, route: 'mailbox', width: 820 });
    await flush();
    sync({ themeDark: true, route: 'mailbox', width: 820 });
    await flush();
    expect(setShellBackground.mock.calls).toEqual([[true], [true]]);
  });

  it.each(['android', 'web'])('does nothing on %s', async (name) => {
    platform = name;
    const sync = await load();
    sync({ themeDark: false, route: 'login', width: 820 });
    await flush();
    expect(setShellBackground).not.toHaveBeenCalled();
  });
});
