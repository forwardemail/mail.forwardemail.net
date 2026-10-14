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

// Alice is on screen; Bob is signed in too.
const session = vi.hoisted(() => ({ active: 'alice@example.com' }));
vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (key) => (key === 'email' ? session.active : null),
    set: () => {},
    remove: () => {},
  },
  Accounts: {
    getAll: () => [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
  },
}));

// What tauri-plugin-notification 2.3.3 delivers to onAction.
//
// Android (NotificationPlugin.kt onIntent): the notification as it was
// scheduled, `extra` included.
function androidTap(notification) {
  return { actionId: 'tap', notification };
}

// iOS (NotificationHandler.swift didReceive): ReceivedNotification built from
// ActiveNotification, which has the id, title and body but no `extra`.
function iosTap({ id, title = 'Carol Chen', body = 'Quarterly numbers' }) {
  return {
    actionId: 'tap',
    inputValue: null,
    notification: { id, title, body, sound: '', actionTypeId: 'default-mail', attachments: null },
  };
}

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: onFocusChangedMock,
  }),
}));

describe('notification-bridge click routing', () => {
  let navigated;

  let switched;

  beforeEach(async () => {
    vi.clearAllMocks();
    actionHandler = undefined;
    navigated = [];
    switched = [];
    session.active = 'alice@example.com';
    const { configureNotificationOpen, __resetNotificationOpenForTests } =
      await import('../../src/utils/notification-open.ts');
    __resetNotificationOpenForTests();
    const { __resetTapTargetsForTests } = await import('../../src/utils/notification-bridge.js');
    __resetTapTargetsForTests?.();
    configureNotificationOpen({
      isReady: () => true,
      switchAccount: async (email) => {
        switched.push(email);
        session.active = email;
      },
      navigate: (path) => navigated.push(path),
    });
  });

  it('opens the message a notification with a Forward Email URL points at', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');

    await initTauriNotificationClickHandler();
    expect(typeof actionHandler).toBe('function');

    await actionHandler(
      androidTap({
        id: 101,
        title: 'Forward Email',
        body: 'x',
        extra: { url: 'forwardemail://mailbox#inbox/42' },
      }),
    );

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/42']));
  });

  it('opens the folder and message from the notification data', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');

    await initTauriNotificationClickHandler();
    await actionHandler(
      androidTap({
        id: 102,
        title: 'Carol Chen',
        body: 'Quarterly numbers',
        extra: { folder: 'Work/Projects', messageId: 'abc123' },
      }),
    );

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#Work%2FProjects/abc123']));
  });

  it('opens the calendar item a calendar notification points at', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');

    await initTauriNotificationClickHandler();
    await actionHandler(
      androidTap({
        id: 103,
        title: 'Team sync',
        body: 'Tomorrow at 10:00',
        extra: { path: '#calendar', url: 'forwardemail://calendar#event=evt-1' },
      }),
    );

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
  it('iOS: opens the message and switches account from a tap that carries only the id', async () => {
    const { initTauriNotificationClickHandler, notify } =
      await import('../../src/utils/notification-bridge.js');
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    await initTauriNotificationClickHandler();

    await notify({
      title: 'Carol Chen',
      body: 'Quarterly numbers',
      tag: 'new-message-bob@example.com-665f1c2e8a1b2c3d4e5f6001',
      channelId: 'new-mail',
      data: { account: 'bob@example.com', folder: 'INBOX', messageId: '665f1c2e8a1b2c3d4e5f6001' },
    });
    const { id } = sendNotification.mock.calls[0][0];
    expect(Number.isInteger(id)).toBe(true);

    await actionHandler(iosTap({ id }));

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/665f1c2e8a1b2c3d4e5f6001']));
    expect(switched).toEqual(['bob@example.com']);
  });

  it('iOS: resolves a tap for a notification shown without a tag', async () => {
    const { initTauriNotificationClickHandler, notify } =
      await import('../../src/utils/notification-bridge.js');
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    await initTauriNotificationClickHandler();

    await notify({ title: 'Folder Created', body: 'x', data: { folder: 'Receipts' } });
    const { id } = sendNotification.mock.calls[0][0];

    await actionHandler(iosTap({ id, title: 'Folder Created', body: 'x' }));

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#Receipts']));
  });

  it('iOS: still resolves the tap after the page has reloaded', async () => {
    const bridge = await import('../../src/utils/notification-bridge.js');
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    await bridge.notify({
      title: 'Carol Chen',
      body: 'Quarterly numbers',
      tag: 'new-message-alice@example.com-m-77',
      data: { account: 'alice@example.com', folder: 'INBOX', messageId: 'm-77' },
    });
    const { id } = sendNotification.mock.calls[0][0];

    // The renderer restarts while the app stays alive: the module state is
    // gone and only what was stored survives.
    vi.resetModules();
    const open = await import('../../src/utils/notification-open.ts');
    open.configureNotificationOpen({
      isReady: () => true,
      switchAccount: async () => {},
      navigate: (path) => navigated.push(path),
    });
    const reloaded = await import('../../src/utils/notification-bridge.js');
    await reloaded.initTauriNotificationClickHandler();
    await actionHandler(iosTap({ id }));

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/m-77']));
  });
});
