/**
 * Notification Manager – app update notification toggle.
 *
 * Regression guards for the support request about frequent "App updated"
 * notifications on the web app: the device scoped notify_app_updates
 * setting (stored by the settings registry as the string 'false' when
 * disabled) must suppress newRelease notifications while leaving new mail
 * notifications untouched.
 *
 * Setup mirrors notification-manager-filter.test.js: dispatch
 * fe:push-notification events and observe the `notify` mock.
 */

let notifyAppUpdatesRaw = null;

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
  extractFromField: vi.fn(() => 'sender@example.com'),
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
    get: vi.fn((key) => (key === 'notify_app_updates' ? notifyAppUpdatesRaw : 'user@example.com')),
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
} from '../../src/utils/notification-manager.js';
import { notify } from '../../src/utils/notification-bridge.js';
import { PUSH_COALESCE_MS } from '../../src/utils/realtime-event-coalescer.js';

function createMockWsClient() {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return vi.fn();
    }),
    emit(event, data) {
      const fns = handlers.get(event) || [];
      for (const fn of fns) fn(data);
    },
  };
}

function firePushEvent(event, payload) {
  window.dispatchEvent(
    new CustomEvent('fe:push-notification', {
      detail: { event, ...payload },
    }),
  );
}

async function settle() {
  await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);
  await vi.dynamicImportSettled();
}

describe('notification-manager app update toggle', () => {
  let cleanup;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    notifyAppUpdatesRaw = null;
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    await requestNotificationPermission();
    cleanup = connectNotifications(createMockWsClient());
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

  it('shows the release notification by default (setting unset)', async () => {
    firePushEvent('newRelease', {
      notification_id: 'rel-default',
      release: { tagName: 'v9.9.9', name: 'Version 9.9.9' },
    });
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].title).toContain('Update');
  });

  it("suppresses the release notification when notify_app_updates is 'false'", async () => {
    notifyAppUpdatesRaw = 'false';
    firePushEvent('newRelease', {
      notification_id: 'rel-off',
      release: { tagName: 'v9.9.8', name: 'Version 9.9.8' },
    });
    await settle();
    expect(notify).not.toHaveBeenCalled();
  });

  it("still shows the release notification when the setting is 'true'", async () => {
    notifyAppUpdatesRaw = 'true';
    firePushEvent('newRelease', {
      notification_id: 'rel-on',
      release: { tagName: 'v9.9.7', name: 'Version 9.9.7' },
    });
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps new mail notifications when app update notifications are off', async () => {
    notifyAppUpdatesRaw = 'false';
    firePushEvent('newMessage', {
      notification_id: 'mail-1',
      mailbox: 'INBOX',
      message: {
        uid: 'mail-1',
        flags: [],
        from: { text: 'Sender <sender@example.com>' },
        subject: 'Hello',
      },
    });
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].title).not.toContain('Update');
  });
});
