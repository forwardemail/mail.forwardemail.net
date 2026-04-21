import { beforeEach, describe, expect, it, vi } from 'vitest';

const onFocusChangedMock = vi.fn(() => Promise.resolve(() => {}));
let actionHandler;

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  onAction: vi.fn(async (handler) => {
    actionHandler = handler;
  }),
  registerActionTypes: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: onFocusChangedMock,
  }),
}));

describe('notification-bridge click routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actionHandler = undefined;
    window.location.hash = '';
  });

  it('dispatches an app deep-link event when a notification click includes a Forward Email URL', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');

    const received = new Promise((resolve) => {
      window.addEventListener('app:deep-link', (event) => resolve(event.detail), { once: true });
    });

    await initTauriNotificationClickHandler();
    expect(typeof actionHandler).toBe('function');

    await actionHandler({
      extra: {
        url: 'forwardemail://mailbox#inbox/42',
      },
    });

    await expect(received).resolves.toEqual({
      url: 'forwardemail://mailbox#inbox/42',
    });
  });

  it('re-dispatches hash navigation when the clicked notification targets the current message hash', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');

    window.location.hash = '#inbox/42';
    const received = new Promise((resolve) => {
      window.addEventListener('hashchange', () => resolve(window.location.hash), { once: true });
    });

    await initTauriNotificationClickHandler();
    expect(typeof actionHandler).toBe('function');

    await actionHandler({
      extra: {
        path: '#inbox/42',
      },
    });

    await expect(received).resolves.toBe('#inbox/42');
  });
});
