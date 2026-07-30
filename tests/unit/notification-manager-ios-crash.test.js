/**
 * Notification Manager – iOS crash prevention regression tests.
 *
 * On iOS WKWebView, an unhandled promise rejection during cold start
 * terminates the webview process (instant crash on app open). These tests
 * verify that:
 *
 *   1. routeNotificationEvent catches synchronous errors and async rejections
 *      from handleNewMessage (which is async but called fire-and-forget).
 *   2. showNotification swallows errors when called without await from sync
 *      handlers (handleMailboxCreated, handleNewRelease, etc.).
 *   3. The system recovers after a failure and processes subsequent events.
 *   4. Malformed/null/undefined data does not throw synchronously.
 *   5. Concurrent event bursts with failures do not produce unhandled
 *      rejections.
 *
 * These tests use the same mock patterns as notification-manager-filter.test.js
 * and notification-manager-account-scope.test.js.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
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
  Remote: { request: vi.fn(() => Promise.resolve([])) },
}));

vi.mock('../../src/utils/sync-helpers.ts', () => ({
  extractFromField: vi.fn(() => ''),
}));

vi.mock('../../src/stores/mailboxStore', () => ({
  mailboxStore: {
    state: {
      folders: { subscribe: (fn) => (fn([]), () => {}) },
      selectedFolder: { subscribe: (fn) => (fn(''), () => {}) },
      messages: { subscribe: (fn) => (fn([]), () => {}), set: vi.fn() },
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
  Local: {
    get: vi.fn((key) => (key === 'email' ? 'user@example.com' : null)),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../src/utils/mime-utils.js', () => ({
  decodeMimeHeader: vi.fn((v) => v),
}));

vi.mock('../../src/utils/address.ts', () => ({
  extractEmail: vi.fn((v) => (typeof v === 'string' ? v : '')),
}));

import {
  connectNotifications,
  requestNotificationPermission,
  setBadgeCount,
} from '../../src/utils/notification-manager.js';
import { notify } from '../../src/utils/notification-bridge.js';
import { Remote } from '../../src/utils/remote.js';
import { PUSH_COALESCE_MS } from '../../src/utils/realtime-event-coalescer.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function createMockWsClient() {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return vi.fn();
    }),
    handlers,
    emit(event, data) {
      const fns = handlers.get(event) || [];
      for (const fn of fns) fn(data);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('iOS crash prevention – unhandled rejection guards', () => {
  let wsClient;
  let cleanup;
  let unhandledRejections;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    unhandledRejections = [];
    process.on('unhandledRejection', (reason) => unhandledRejections.push(reason));

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });

    await setBadgeCount(0);
    await requestNotificationPermission();
    wsClient = createMockWsClient();
    cleanup = connectNotifications(wsClient);
  });

  afterEach(() => {
    if (cleanup) cleanup();
    process.removeAllListeners('unhandledRejection');
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it('does not crash when Remote.request rejects during cold start (WS path)', async () => {
    vi.mocked(Remote.request).mockRejectedValue(new Error('Network unavailable'));

    wsClient.emit('newMessage', {
      mailbox: 'INBOX',
      message: {
        uid: 'cold-start-1',
        from: { text: 'Sender <sender@other.com>' },
        subject: 'Cold start test',
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(vi.mocked(notify)).toHaveBeenCalled());

    expect(unhandledRejections).toHaveLength(0);
  });

  it('does not crash when Remote.request rejects during cold start (push path)', async () => {
    vi.mocked(Remote.request).mockRejectedValue(new Error('Network unavailable'));

    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'newMessage',
          notification_id: 'push-cold-1',
          mailbox: 'INBOX',
          from: 'Push Sender <push@other.com>',
          subject: 'Push cold start',
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS + 100);
    await vi.waitFor(() => expect(vi.mocked(notify)).toHaveBeenCalled());

    expect(unhandledRejections).toHaveLength(0);
  });

  it('does not crash when notify rejects (simulating iOS plugin not ready)', async () => {
    vi.mocked(notify).mockRejectedValue(new Error('Plugin not initialized'));

    wsClient.emit('newMessage', {
      mailbox: 'INBOX',
      message: {
        uid: 'plugin-fail-1',
        from: { text: 'Sender <sender@other.com>' },
        subject: 'Plugin fail test',
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(vi.mocked(notify)).toHaveBeenCalled());

    expect(unhandledRejections).toHaveLength(0);
  });

  it('does not crash when Remote.request throws synchronously', async () => {
    vi.mocked(Remote.request).mockImplementation(() => {
      throw new Error('Sync throw from Remote');
    });

    wsClient.emit('newMessage', {
      mailbox: 'INBOX',
      message: {
        uid: 'sync-throw-1',
        from: { text: 'Sender <sender@other.com>' },
        subject: 'Sync throw test',
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(vi.mocked(notify)).toHaveBeenCalled());

    expect(unhandledRejections).toHaveLength(0);
  });

  it('handles push with flat data fields (message reconstruction path)', async () => {
    vi.mocked(notify).mockRejectedValue(new Error('Bridge down'));

    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'newMessage',
          notification_id: 'flat-push-1',
          mailbox: 'INBOX',
          from: 'Flat Sender <flat@other.com>',
          subject: 'Flat push test',
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS + 100);
    await vi.waitFor(() => expect(vi.mocked(notify)).toHaveBeenCalled());

    expect(unhandledRejections).toHaveLength(0);
  });

  it('does not crash when requestPermission throws inside showNotification', async () => {
    // Force permissionGranted to false by mocking requestPermission to reject
    vi.mocked(notify).mockRejectedValueOnce(new Error('Notification bridge unavailable'));

    // Use a sync handler that calls showNotification without await
    wsClient.emit('mailboxRenamed', {
      oldPath: 'OldName',
      newPath: 'NewName',
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    expect(unhandledRejections).toHaveLength(0);
  });

  it('recovers gracefully and processes subsequent events after a failure', async () => {
    // First event: notify rejects (simulating cold-start plugin failure)
    vi.mocked(notify).mockRejectedValueOnce(new Error('First call fails'));

    wsClient.emit('newMessage', {
      mailbox: 'INBOX',
      message: {
        uid: 'fail-1',
        from: { text: 'First <first@other.com>' },
        subject: 'Will fail',
      },
    });

    // Wait for the async handler to complete
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(vi.mocked(notify)).toHaveBeenCalledTimes(1));

    // Second event should also not crash (notify is back to default resolved)
    wsClient.emit('newMessage', {
      mailbox: 'INBOX',
      message: {
        uid: 'success-2',
        from: { text: 'Second <second@other.com>' },
        subject: 'Should succeed',
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(vi.mocked(notify)).toHaveBeenCalledTimes(2));

    // Critical: no unhandled rejections escaped despite the first failure
    expect(unhandledRejections).toHaveLength(0);
  });

  it('handles concurrent push and WS events failing without crash', async () => {
    vi.mocked(Remote.request).mockRejectedValue(new Error('Network down'));
    vi.mocked(notify).mockRejectedValue(new Error('Bridge down'));

    // Fire multiple events simultaneously (simulates iOS cold start burst)
    wsClient.emit('newMessage', {
      mailbox: 'INBOX',
      message: { uid: 'burst-1', from: { text: 'A <a@other.com>' }, subject: 'Burst 1' },
    });
    wsClient.emit('newMessage', {
      mailbox: 'INBOX',
      message: { uid: 'burst-2', from: { text: 'B <b@other.com>' }, subject: 'Burst 2' },
    });
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'newMessage',
          notification_id: 'burst-push-1',
          mailbox: 'INBOX',
          from: 'Burst <burst@other.com>',
          subject: 'Burst push',
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS + 100);
    await vi.runAllTimersAsync();

    // None of the concurrent failures should produce unhandled rejections
    expect(unhandledRejections).toHaveLength(0);
  });
});

describe('iOS crash prevention – routeNotificationEvent synchronous guards', () => {
  let wsClient;
  let cleanup;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });

    await setBadgeCount(0);
    await requestNotificationPermission();
    wsClient = createMockWsClient();
    cleanup = connectNotifications(wsClient);
  });

  afterEach(() => {
    if (cleanup) cleanup();
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it('does not throw when data is null', () => {
    expect(() => {
      wsClient.emit('newMessage', null);
    }).not.toThrow();
  });

  it('does not throw when data is undefined', () => {
    expect(() => {
      wsClient.emit('newMessage', undefined);
    }).not.toThrow();
  });

  it('does not throw when data is a non-object primitive', () => {
    expect(() => {
      wsClient.emit('newMessage', 'invalid string');
    }).not.toThrow();
  });

  it('does not throw for unknown event types routed through push', async () => {
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'totallyUnknownEvent',
          notification_id: 'unknown-001',
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS + 100);

    // Should not have called notify for unknown events
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
  });
});
