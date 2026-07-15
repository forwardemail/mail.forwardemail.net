// Notification Manager – native push and WebSocket coalescing regressions.

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: false,
}));
vi.mock('../../src/utils/notification-bridge.js', () => ({
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

import {
  connectNotifications,
  requestNotificationPermission,
  getBadgeCount,
  setBadgeCount,
} from '../../src/utils/notification-manager.js';
import { notify } from '../../src/utils/notification-bridge.js';
import { PUSH_COALESCE_MS } from '../../src/utils/realtime-event-coalescer.js';

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

describe('notification-manager push event listener', () => {
  let wsClient;
  let cleanup;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    await setBadgeCount(0);
    await requestNotificationPermission();
    wsClient = createMockWsClient();
    cleanup = connectNotifications(wsClient);
  });

  afterEach(() => {
    if (cleanup) cleanup();
    vi.useRealTimers();
  });

  it('registers a window event listener for fe:push-notification', () => {
    const spy = vi.spyOn(window, 'removeEventListener');
    cleanup();
    cleanup = null;

    expect(spy).toHaveBeenCalledWith('fe:push-notification', expect.any(Function));
    spy.mockRestore();
  });

  it('routes a push newMessage after the bounded WebSocket wait', async () => {
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'newMessage',
          notification_id: '123e4567-e89b-12d3-a456-426614174000',
          mailbox: 'INBOX',
          message: {
            uid: 'push-123',
            from: { text: 'Push Sender <push@example.com>' },
            subject: 'Push notification test',
          },
        },
      }),
    );

    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));

    const call = notify.mock.calls[0][0];
    expect(call.title).toContain('Push Sender');
    expect(call.body).toContain('Push notification test');
  });

  it('routes push flagsUpdated side effects only after the bounded wait', async () => {
    await setBadgeCount(5);
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'flagsUpdated',
          notification_id: '123e4567-e89b-12d3-a456-426614174001',
          action: 'add',
          flags: ['\\Seen'],
        },
      }),
    );

    expect(getBadgeCount()).toBe(5);
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);
    expect(getBadgeCount()).toBe(4);
  });

  it('routes mailbox and calendar push fallbacks', async () => {
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'mailboxCreated',
          notification_id: '123e4567-e89b-12d3-a456-426614174002',
          path: 'NewFolder',
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'calendarEventCreated',
          notification_id: '123e4567-e89b-12d3-a456-426614174003',
          summary: 'Team Meeting',
          id: 'cal-push-1',
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        title: 'Folder Created',
        body: expect.stringContaining('NewFolder'),
      }),
    );
    expect(notify.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        title: 'Calendar Event Created',
        body: expect.stringContaining('Team Meeting'),
      }),
    );
  });

  it('prefers WebSocket when push arrives first inside the coalescing window', async () => {
    const notificationId = '123e4567-e89b-12d3-a456-426614174004';
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'mailboxCreated',
          notification_id: notificationId,
          path: 'SocketWins',
        },
      }),
    );
    expect(notify).not.toHaveBeenCalled();

    wsClient.emit('mailboxCreated', {
      notification_id: notificationId,
      path: 'SocketWins',
    });
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].body).toContain('SocketWins');
  });

  it('suppresses a late matching push after WebSocket delivery', async () => {
    const notificationId = '123e4567-e89b-12d3-a456-426614174005';
    wsClient.emit('mailboxCreated', {
      notification_id: notificationId,
      path: 'AlreadyHandled',
    });
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'mailboxCreated',
          notification_id: notificationId,
          path: 'AlreadyHandled',
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not display a second visual for a push already shown by the system', async () => {
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'mailboxCreated',
          notification_id: '123e4567-e89b-12d3-a456-426614174006',
          path: 'SystemDisplayed',
          displayedBySystem: true,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);

    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    ['missing event field', { data: 'no event field' }],
    ['non-string event field', { event: 123 }],
    ['unknown event type', { event: 'unknownEvent' }],
    ['null detail', null],
  ])('ignores push events with %s', (_description, detail) => {
    window.dispatchEvent(new CustomEvent('fe:push-notification', { detail }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('removes the listener and cancels pending fallback work on cleanup', async () => {
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'mailboxCreated',
          notification_id: '123e4567-e89b-12d3-a456-426614174007',
          path: 'PendingBeforeCleanup',
        },
      }),
    );

    cleanup();
    cleanup = null;
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: { event: 'mailboxCreated', path: 'ShouldNotNotify' },
      }),
    );
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);

    expect(notify).not.toHaveBeenCalled();
  });
});
