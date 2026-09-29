// Notification Manager – who sees a new-mail event, and what happens when no
// system notification can be shown.
//
// "In the app" means the page is visible AND its window has focus. A desktop
// window left open behind another app, or a visible browser tab while the
// user works elsewhere, used to count as foreground: the event became an
// in-app toast nobody saw, and no system notification was shown.

const bridge = vi.hoisted(() => ({
  permission: 'granted',
  notifyResult: true,
}));
const store = vi.hoisted(() => new Map());

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: false,
  isTauriMacOS: false,
  isTauri: false,
}));
vi.mock('../../src/utils/notification-bridge.js', () => ({
  getPermissionState: vi.fn(() => Promise.resolve(bridge.permission)),
  notify: vi.fn(() => Promise.resolve(bridge.notifyResult)),
  requestPermission: vi.fn(() => Promise.resolve(bridge.permission)),
}));
vi.mock('../../src/utils/tauri-bridge.js', () => ({ setBadgeCount: vi.fn() }));
vi.mock('../../src/utils/favicon-badge.js', () => ({ updateFaviconBadge: vi.fn() }));
vi.mock('../../src/utils/remote.js', () => ({ Remote: { request: vi.fn() } }));
vi.mock('../../src/utils/sync-helpers.ts', () => ({ extractFromField: vi.fn(() => '') }));
vi.mock('../../src/stores/mailboxStore', () => ({
  mailboxStore: {
    state: { folders: { subscribe: (fn) => (fn([]), () => {}) } },
    actions: { getSentFolderPath: () => 'Sent', getDraftsFolderPath: () => 'Drafts' },
  },
}));
vi.mock('../../src/utils/demo-mode.js', () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: vi.fn((key) => (key === 'email' ? 'user@example.com' : store.get(key))),
    set: vi.fn((key, value) => store.set(key, value)),
    remove: vi.fn((key) => store.delete(key)),
  },
}));
vi.mock('../../src/utils/push-notifications.js', () => ({ getActivePushProvider: () => null }));
vi.mock('../../src/utils/notification-open.ts', () => ({
  openNotificationTarget: vi.fn(),
  notificationDataToTarget: vi.fn(),
}));

import {
  connectNotifications,
  initNotificationPermission,
  setNotificationToasts,
} from '../../src/utils/notification-manager.js';
import { notify, requestPermission } from '../../src/utils/notification-bridge.js';
import { openNotificationTarget } from '../../src/utils/notification-open.ts';

function createWsClient() {
  const listeners = {};
  return {
    on(event, handler) {
      (listeners[event] ||= []).push(handler);
      return () => {
        listeners[event] = listeners[event].filter((candidate) => candidate !== handler);
      };
    },
    emit(event, data) {
      for (const handler of listeners[event] || []) handler(data);
    },
  };
}

let uid = 1000;
function newMail(from = 'Alice <alice@example.com>', subject = 'Hello') {
  uid += 1;
  return { mailbox: 'INBOX', message: { uid: String(uid), from: { text: from }, subject } };
}

function setWindow({ visible, focused }) {
  Object.defineProperty(document, 'visibilityState', {
    value: visible ? 'visible' : 'hidden',
    configurable: true,
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

describe('new mail: in the app, behind another window, or away', () => {
  let ws;
  let cleanup;
  let toasts;

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    bridge.permission = 'granted';
    bridge.notifyResult = true;
    toasts = { show: vi.fn() };
    setNotificationToasts(toasts);
    ws = createWsClient();
    cleanup = connectNotifications(ws);
  });

  afterEach(() => {
    cleanup?.();
    vi.restoreAllMocks();
    setWindow({ visible: true, focused: true });
  });

  it('shows a system notification when the window is visible but not focused', async () => {
    setWindow({ visible: true, focused: false });

    ws.emit('newMessage', newMail());

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Alice', body: 'Hello' });
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it('shows only an in-app toast when the user is looking at the app', async () => {
    setWindow({ visible: true, focused: true });

    ws.emit('newMessage', newMail());

    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledTimes(1));
    expect(toasts.show.mock.calls[0][0]).toBe('New email from Alice: Hello');
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not prompt for permission on the web; tells the user when they return', async () => {
    bridge.permission = 'default';
    setWindow({ visible: false, focused: false });

    ws.emit('newMessage', newMail('Bob <bob@example.com>', 'Invoice'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requestPermission).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(toasts.show).not.toHaveBeenCalled();

    setWindow({ visible: true, focused: true });
    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledTimes(1));
    const [message, , , action] = toasts.show.mock.calls[0];
    expect(message).toBe('New email from Bob: Invoice');
    action.callback();
    expect(openNotificationTarget).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'INBOX' }),
    );
  });

  it('counts a message replayed after a reconnect once', async () => {
    bridge.permission = 'default';
    setWindow({ visible: false, focused: false });
    const mail = newMail('Erin <erin@example.com>', 'Twice');

    ws.emit('newMessage', mail);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // The connection is rebuilt (account switch, unlock, network change) and
    // the server replays the event to the new one.
    cleanup();
    ws = createWsClient();
    cleanup = connectNotifications(ws);
    ws.emit('newMessage', structuredClone(mail));
    await new Promise((resolve) => setTimeout(resolve, 1500));

    setWindow({ visible: true, focused: true });
    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledTimes(1));
    expect(toasts.show.mock.calls[0][0]).toBe('New email from Erin: Twice');
  });

  it('summarises several missed messages in one toast', async () => {
    bridge.notifyResult = false; // The OS refused the notification.
    setWindow({ visible: false, focused: false });

    ws.emit('newMessage', newMail('Carol <carol@example.com>', 'First'));
    ws.emit('newMessage', newMail('Dave <dave@example.com>', 'Second'));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2), { timeout: 5000 });

    setWindow({ visible: true, focused: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledTimes(1));
    expect(toasts.show.mock.calls[0][0]).toBe(
      '2 new emails while you were away. Latest from Dave: Second',
    );
  });
});

describe('asking for notification permission on the web', () => {
  let toasts;

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    toasts = { show: vi.fn() };
    setNotificationToasts(toasts);
  });

  it('offers permission once, in a toast whose button makes the request', async () => {
    bridge.permission = 'default';

    expect(await initNotificationPermission()).toBe(false);
    // Asking outside a click is ignored or auto-denied by browsers.
    expect(requestPermission).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledTimes(1);
    const [, , , action] = toasts.show.mock.calls[0];
    expect(action.label).toBe('Turn on');

    bridge.permission = 'granted';
    action.callback();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(toasts.show).toHaveBeenLastCalledWith('Notifications are on.', 'success'),
    );

    // Not offered again on this device.
    bridge.permission = 'default';
    toasts.show.mockClear();
    await initNotificationPermission();
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it('waits until the user is in the app before using up the one offer', async () => {
    bridge.permission = 'default';
    setWindow({ visible: false, focused: false });

    await initNotificationPermission();
    expect(toasts.show).not.toHaveBeenCalled();
    expect(store.get('notification_permission_offered')).toBeUndefined();

    setWindow({ visible: true, focused: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledTimes(1));
    expect(toasts.show.mock.calls[0][3].label).toBe('Turn on');
    expect(store.get('notification_permission_offered')).toBe('1');
  });

  it('makes no offer when permission is already granted or blocked', async () => {
    bridge.permission = 'granted';
    expect(await initNotificationPermission()).toBe(true);
    bridge.permission = 'denied';
    expect(await initNotificationPermission()).toBe(false);
    expect(toasts.show).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
