/**
 * Notification Manager – new-message filter tests.
 *
 * Regression guards for the "Thunderbird IMAP COPY/APPEND notification spam"
 * report. The notification filter in handleNewMessage must suppress:
 *   1. Messages that arrive already-\Seen (cross-folder copy/migration).
 *   2. Messages destined for Archive / Junk / Trash / All (by specialUse
 *      or by path-name fallback).
 *
 * It must NOT suppress a normal Inbox arrival.
 *
 * The setup mirrors notification-manager-push-events.test.js: we dispatch
 * fe:push-notification events and observe the `notify` mock, which is what
 * the bridge would call on a real platform.
 */

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
      // No selectedFolder match for these tests — the optimistic prepend path
      // requires it to match, so the absence here keeps these tests focused
      // purely on the suppression rules.
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
  Local: { get: vi.fn(() => 'user@example.com') },
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

function fireNewMessage(payload) {
  window.dispatchEvent(
    new CustomEvent('fe:push-notification', {
      detail: {
        event: 'newMessage',
        notification_id: payload.notification_id || `filter-${payload.message?.uid}`,
        ...payload,
      },
    }),
  );
}

async function expectNoNotification(reason) {
  await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);
  await vi.dynamicImportSettled();
  expect(notify, reason).not.toHaveBeenCalled();
}

describe('notification-manager new-message filter', () => {
  let cleanup;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    await requestNotificationPermission();
    cleanup = connectNotifications(createMockWsClient());
  });

  afterEach(() => {
    if (cleanup) cleanup();
    vi.useRealTimers();
  });

  it('suppresses notification when the arriving message is already \\Seen', async () => {
    fireNewMessage({
      mailbox: 'INBOX',
      message: {
        uid: 'seen-1',
        flags: ['\\Seen'],
        from: { text: 'Migrated <m@example.com>' },
        subject: 'Old mail copied from Thunderbird',
      },
    });
    await expectNoNotification('\\Seen flag should suppress notification');
  });

  it('suppresses for case-insensitive \\seen variant', async () => {
    fireNewMessage({
      mailbox: 'INBOX',
      message: {
        uid: 'seen-2',
        flags: ['\\seen'],
        from: { text: 'sender@example.com' },
        subject: 'lowercase seen',
      },
    });
    await expectNoNotification('lowercase \\seen should still suppress');
  });

  it('suppresses when path is "Archive" (name-based fallback)', async () => {
    fireNewMessage({
      mailbox: 'Archive',
      message: {
        uid: 'arch-1',
        flags: [],
        from: { text: 'sender@example.com' },
        subject: 'goes to archive',
      },
    });
    await expectNoNotification('Archive folder should suppress notification');
  });

  it('suppresses for Junk / Spam / Trash / Bin paths', async () => {
    for (const path of ['Junk', 'JUNK EMAIL', 'Spam', 'Trash', 'Bin', 'Deleted Items']) {
      vi.clearAllMocks();
      fireNewMessage({
        mailbox: path,
        message: {
          uid: `path-${path}`,
          flags: [],
          from: { text: 'sender@example.com' },
          subject: `goes to ${path}`,
        },
      });
      await expectNoNotification(`${path} folder should suppress notification`);
    }
  });

  it('shows notification for a normal Inbox arrival (positive case)', async () => {
    fireNewMessage({
      mailbox: 'INBOX',
      message: {
        uid: 'inbox-1',
        flags: [],
        from: { text: 'Real Sender <real@example.com>' },
        subject: 'fresh delivery',
      },
    });
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const call = notify.mock.calls[0][0];
    expect(call.body).toContain('fresh delivery');
  });
});
