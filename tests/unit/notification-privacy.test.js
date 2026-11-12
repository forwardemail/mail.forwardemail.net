// Notification privacy (Settings > Privacy & Security, issue #113): what a
// new-mail notification shows, with one choice while App Lock has the app
// locked and another the rest of the time.

const bridge = vi.hoisted(() => ({ permission: 'granted' }));
const store = vi.hoisted(() => new Map());
const lock = vi.hoisted(() => ({ enabled: false, locked: false }));
const shared = vi.hoisted(() => []);

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: false,
  isTauriMacOS: false,
  isTauri: false,
}));
vi.mock('../../src/utils/notification-bridge.js', () => ({
  getPermissionState: vi.fn(() => Promise.resolve(bridge.permission)),
  notify: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(() => Promise.resolve(bridge.permission)),
}));
vi.mock('../../src/utils/tauri-bridge.js', () => ({ setBadgeCount: vi.fn() }));
vi.mock('../../src/utils/favicon-badge.js', () => ({ updateFaviconBadge: vi.fn() }));
vi.mock('../../src/utils/remote.js', () => ({ Remote: { request: vi.fn() } }));
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
  Accounts: { getAll: () => [] },
}));
vi.mock('../../src/utils/crypto-store.js', () => ({
  isLockEnabled: () => lock.enabled,
  isVaultLocked: () => lock.enabled && lock.locked,
}));
vi.mock('../../src/utils/web-push.js', () => ({
  sharePushPreviewWithServiceWorker: vi.fn((preview) => shared.push(preview)),
}));
vi.mock('../../src/utils/push-notifications.js', () => ({ getPushProviderForAccount: () => null }));
vi.mock('../../src/utils/notification-open.ts', () => ({
  openNotificationTarget: vi.fn(),
  notificationDataToTarget: vi.fn(),
}));

import {
  connectNotifications,
  newMailWording,
  notificationPreviewLevel,
  setNotificationToasts,
} from '../../src/utils/notification-manager.js';
import { notify } from '../../src/utils/notification-bridge.js';

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

let uid = 5000;
const newMail = () => {
  uid += 1;
  return {
    mailbox: 'INBOX',
    message: {
      uid: String(uid),
      from: { text: 'Alex Rivera <alex@example.com>' },
      subject: 'Lunch on Friday?',
      snippet: 'Are you free at noon',
    },
  };
};

function setWindow({ visible, focused }) {
  Object.defineProperty(document, 'visibilityState', {
    value: visible ? 'visible' : 'hidden',
    configurable: true,
  });
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

describe('notification privacy levels', () => {
  it('shows less at each level', () => {
    const at = (level) => newMailWording('Alex', 'Lunch', 'Are you free', level);
    expect(at('full')).toMatchObject({ title: 'Alex', body: 'Lunch\nAre you free' });
    expect(at('sender_subject')).toMatchObject({ title: 'Alex', body: 'Lunch' });
    expect(at('sender')).toMatchObject({ title: 'Alex', body: '', about: '' });
    expect(at('none')).toMatchObject({ title: 'New email', body: '', from: '', about: '' });
  });

  it('defaults to sender and subject unlocked, nothing locked', () => {
    store.clear();
    lock.enabled = true;
    lock.locked = false;
    expect(notificationPreviewLevel()).toBe('sender_subject');
    lock.locked = true;
    expect(notificationPreviewLevel()).toBe('none');
  });

  it('uses the unlocked choice when App Lock is off', () => {
    store.clear();
    store.set('notification_preview_unlocked', 'sender');
    store.set('notification_preview_locked', 'full');
    lock.enabled = false;
    lock.locked = true;
    expect(notificationPreviewLevel()).toBe('sender');
  });

  it('ignores a saved value it does not know', () => {
    store.clear();
    store.set('notification_preview_unlocked', 'everything');
    lock.enabled = false;
    expect(notificationPreviewLevel()).toBe('sender_subject');
  });
});

describe('new mail notifications follow the setting and the lock', () => {
  let ws;
  let cleanup;
  let toasts;

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    shared.length = 0;
    lock.enabled = true;
    lock.locked = false;
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

  it('shows sender and subject, without the preview, by default', async () => {
    setWindow({ visible: false, focused: false });
    ws.emit('newMessage', newMail());
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: 'Alex Rivera',
      body: 'Lunch on Friday?',
    });
  });

  it('shows the preview when the user chose it', async () => {
    store.set('notification_preview_unlocked', 'full');
    setWindow({ visible: false, focused: false });
    ws.emit('newMessage', newMail());
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0].body).toBe('Lunch on Friday?\nAre you free at noon');
  });

  it('hides sender and subject while App Lock has the app locked', async () => {
    lock.locked = true;
    setWindow({ visible: false, focused: false });
    ws.emit('newMessage', newMail());
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const shown = notify.mock.calls[0][0];
    expect(shown).toMatchObject({ title: 'New email', body: '' });
    expect(JSON.stringify(shown)).not.toMatch(/Alex|Lunch|noon/);
  });

  it('words the in-app toast the same way', async () => {
    store.set('notification_preview_unlocked', 'sender');
    setWindow({ visible: true, focused: true });
    ws.emit('newMessage', newMail());
    await vi.waitFor(() => expect(toasts.show).toHaveBeenCalledTimes(1));
    expect(toasts.show.mock.calls[0][0]).toBe('New email from Alex Rivera');
  });

  it('leaves out calendar details when the level is nothing', async () => {
    lock.locked = true;
    setWindow({ visible: false, focused: false });
    ws.emit('calendarEventCreated', { summary: 'Dentist appointment' });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Calendar Event Created', body: '' });
  });

  it('tells the service worker the levels and the lock state when the lock changes', async () => {
    store.set('notification_preview_locked', 'sender');
    lock.locked = true;
    window.dispatchEvent(new CustomEvent('fe:lock-state-changed'));
    expect(shared.at(-1)).toEqual({
      unlocked: 'sender_subject',
      locked: 'sender',
      lockEnabled: true,
      lockedNow: true,
    });
  });
});
