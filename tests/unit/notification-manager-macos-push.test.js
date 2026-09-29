// Notification Manager – macOS, where the system can draw an APNs alert while
// the app is running. The WebSocket copy of a newMessage usually arrives
// first; it is held briefly so the push can report whether macOS already
// showed the alert, and the app then draws nothing, or its own notification.

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: false,
  isTauri: false,
  isTauriMacOS: true,
}));
vi.mock('../../src/utils/notification-bridge.js', () => ({
  getPermissionState: vi.fn(() => Promise.resolve('granted')),
  notify: vi.fn(() => Promise.resolve()),
  requestPermission: vi.fn(() => Promise.resolve('granted')),
}));
vi.mock('../../src/utils/tauri-bridge.js', () => ({
  setBadgeCount: vi.fn(),
}));
vi.mock('../../src/utils/favicon-badge.js', () => ({
  updateFaviconBadge: vi.fn(),
}));
vi.mock('../../src/utils/remote.js', () => ({
  Remote: { request: vi.fn() },
}));
vi.mock('../../src/utils/sync-helpers.ts', () => ({
  extractFromField: vi.fn(() => ''),
}));
vi.mock('../../src/stores/mailboxStore', () => ({
  mailboxStore: {
    state: {
      folders: { subscribe: (fn) => (fn([]), () => {}) },
    },
    actions: {
      getSentFolderPath: () => 'Sent',
      getDraftsFolderPath: () => 'Drafts',
    },
  },
}));
vi.mock('../../src/utils/websocket-client', () => ({
  WS_EVENTS: {
    NEW_MESSAGE: 'newMessage',
    FLAGS_UPDATED: 'flagsUpdated',
    MESSAGES_EXPUNGED: 'messagesExpunged',
    MAILBOX_CREATED: 'mailboxCreated',
    MAILBOX_DELETED: 'mailboxDeleted',
    MAILBOX_RENAMED: 'mailboxRenamed',
    CALENDAR_EVENT_CREATED: 'calendarEventCreated',
    CALENDAR_EVENT_UPDATED: 'calendarEventUpdated',
    CONTACT_CREATED: 'contactCreated',
    CONTACT_UPDATED: 'contactUpdated',
    NEW_RELEASE: 'newRelease',
  },
}));
vi.mock('../../src/utils/demo-mode.js', () => ({
  isDemoMode: vi.fn(() => false),
}));
vi.mock('../../src/utils/storage.js', () => ({
  Local: { get: vi.fn(() => 'user@example.com') },
}));
vi.mock('../../src/utils/mime-utils.js', () => ({
  decodeMimeHeader: vi.fn((value) => value),
}));
vi.mock('../../src/utils/address.ts', () => ({
  extractEmail: vi.fn((value) => (typeof value === 'string' ? value : '')),
}));
const { systemPushAlertExpected } = vi.hoisted(() => ({
  systemPushAlertExpected: vi.fn(),
}));
vi.mock('../../src/utils/push-notifications.js', () => ({
  getActivePushProvider: () => 'apns',
  isSystemPushAlertExpected: systemPushAlertExpected,
}));

import {
  connectNotifications,
  getBadgeCount,
  requestNotificationPermission,
  setBadgeCount,
} from '../../src/utils/notification-manager.js';
import { notify } from '../../src/utils/notification-bridge.js';
import { SOCKET_HOLD_FOR_PUSH_MS } from '../../src/utils/realtime-event-coalescer.js';

function createMockWsClient() {
  const listeners = {};
  return {
    on(event, handler) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
      return () => {
        listeners[event] = listeners[event].filter((candidate) => candidate !== handler);
      };
    },
    emit(event, data) {
      for (const handler of listeners[event] || []) handler(data);
    },
  };
}

const newMessage = (id) => ({
  notification_id: id,
  mailbox: 'INBOX',
  message: {
    uid: `uid-${id}`,
    from: { text: 'Sender <sender@example.com>' },
    subject: `Subject ${id}`,
  },
});

function pushCopy(payload, displayedBySystem) {
  window.dispatchEvent(
    new CustomEvent('fe:push-notification', {
      detail: {
        event: 'newMessage',
        ...payload,
        ...(displayedBySystem ? { displayedBySystem: true } : {}),
      },
    }),
  );
}

describe('notification-manager on macOS with APNs registered', () => {
  let wsClient;
  let cleanup;
  let hasFocus;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    systemPushAlertExpected.mockReturnValue(true);
    hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    await setBadgeCount(0);
    await requestNotificationPermission();
    wsClient = createMockWsClient();
    cleanup = connectNotifications(wsClient);
    // The push-alert check is loaded lazily.
    await vi.dynamicImportSettled();
  });

  afterEach(() => {
    if (cleanup) cleanup();
    hasFocus.mockRestore();
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it('draws nothing when macOS already showed the push alert', async () => {
    const payload = newMessage('mac-1');
    wsClient.emit('newMessage', payload);
    expect(getBadgeCount()).toBe(0);

    pushCopy(payload, true);

    await vi.waitFor(() => expect(getBadgeCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(SOCKET_HOLD_FOR_PUSH_MS);
    expect(notify).not.toHaveBeenCalled();
    expect(getBadgeCount()).toBe(1);
  });

  it('draws its own notification when the push was not shown by macOS', async () => {
    const payload = newMessage('mac-2');
    wsClient.emit('newMessage', payload);
    pushCopy(payload, false);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0].body).toContain('Subject mac-2');
    await vi.advanceTimersByTimeAsync(SOCKET_HOLD_FOR_PUSH_MS);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('draws its own notification when no push arrives in time', async () => {
    wsClient.emit('newMessage', newMessage('mac-3'));

    await vi.advanceTimersByTimeAsync(SOCKET_HOLD_FOR_PUSH_MS - 1);
    expect(notify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0].body).toContain('Subject mac-3');
  });

  it('does not hold socket events while the app has focus', async () => {
    hasFocus.mockReturnValue(true);
    wsClient.emit('newMessage', newMessage('mac-4'));

    await vi.waitFor(() => expect(getBadgeCount()).toBe(1));
    expect(systemPushAlertExpected).not.toHaveBeenCalled();
  });

  it('does not hold socket events no push alert is expected for', async () => {
    systemPushAlertExpected.mockReturnValue(false);
    wsClient.emit('newMessage', newMessage('mac-5'));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(systemPushAlertExpected).toHaveBeenCalledWith(
      'newMessage',
      expect.objectContaining({ notification_id: 'mac-5' }),
    );
  });
});
