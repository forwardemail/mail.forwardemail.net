import { beforeEach, describe, expect, it, vi } from 'vitest';

let focusHandler;
const onFocusChangedMock = vi.fn((handler) => {
  focusHandler = handler;
  return Promise.resolve(() => {});
});
let actionHandler;

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  isTauriMobile: false,
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  onAction: vi.fn(async (handler) => {
    actionHandler = handler;
  }),
  registerActionTypes: vi.fn(async () => {}),
  isPermissionGranted: vi.fn(async () => true),
  sendNotification: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: onFocusChangedMock,
  }),
}));

describe('notification-bridge click routing', () => {
  let navigated;

  beforeEach(async () => {
    vi.clearAllMocks();
    actionHandler = undefined;
    navigated = [];
    const { configureNotificationOpen, __resetNotificationOpenForTests } =
      await import('../../src/utils/notification-open.ts');
    __resetNotificationOpenForTests();
    configureNotificationOpen({
      isReady: () => true,
      switchAccount: async () => {},
      navigate: (path) => navigated.push(path),
    });
  });

  it('opens the message a notification with a Forward Email URL points at', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');

    await initTauriNotificationClickHandler();
    expect(typeof actionHandler).toBe('function');

    await actionHandler({ extra: { url: 'forwardemail://mailbox#inbox/42' } });

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/42']));
  });

  it('opens the folder and message from the notification data', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');

    await initTauriNotificationClickHandler();
    await actionHandler({
      notification: { extra: { folder: 'Work/Projects', messageId: 'abc123' } },
    });

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#Work%2FProjects/abc123']));
  });

  it('opens the calendar item a calendar notification points at', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');

    await initTauriNotificationClickHandler();
    await actionHandler({
      extra: { path: '#calendar', url: 'forwardemail://calendar#event=evt-1' },
    });

    await vi.waitFor(() => expect(navigated).toEqual(['/calendar#event=evt-1']));
  });

  it('does not also open its own last notification when a push tap focused the window', async () => {
    const { initTauriNotificationClickHandler, notify } =
      await import('../../src/utils/notification-bridge.js');
    await initTauriNotificationClickHandler();
    await notify({ title: 'Hi', body: 'x', data: { folder: 'INBOX', messageId: 'local-1' } });

    // A remote push tap is being handled (push-notifications.js) and it is
    // what brought the window to the front.
    window.dispatchEvent(new CustomEvent('fe:push-tap'));
    focusHandler({ payload: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(navigated).toEqual([]);
  });

  it('opens the last notification when the window gains focus from clicking it', async () => {
    const { initTauriNotificationClickHandler, notify } =
      await import('../../src/utils/notification-bridge.js');
    await initTauriNotificationClickHandler();
    await notify({ title: 'Hi', body: 'x', data: { folder: 'INBOX', messageId: 'local-2' } });

    focusHandler({ payload: true });

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/local-2']));
  });
});
