// The badge counts unread mail in INBOX. Flag events move it by the number of
// messages they name, only for INBOX, and only once per change.

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: false,
  isTauriMacOS: false,
  isTauri: false,
}));
vi.mock('../../src/utils/notification-bridge.js', () => ({
  getPermissionState: vi.fn(() => Promise.resolve('granted')),
  notify: vi.fn(() => Promise.resolve()),
  requestPermission: vi.fn(() => Promise.resolve('granted')),
}));
vi.mock('../../src/utils/tauri-bridge.js', () => ({ setBadgeCount: vi.fn() }));
vi.mock('../../src/utils/favicon-badge.js', () => ({ updateFaviconBadge: vi.fn() }));
vi.mock('../../src/utils/remote.js', () => ({ Remote: { request: vi.fn() } }));
vi.mock('../../src/utils/sync-helpers.ts', () => ({ extractFromField: vi.fn(() => '') }));
vi.mock('../../src/stores/mailboxStore', () => ({
  mailboxStore: {
    state: {
      folders: {
        subscribe: (fn) => (
          fn([
            { id: 'inbox-id', path: 'INBOX' },
            { id: 'sent-id', path: 'Sent' },
          ]),
          () => {}
        ),
      },
    },
    actions: { getSentFolderPath: () => 'Sent', getDraftsFolderPath: () => 'Drafts' },
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
vi.mock('../../src/utils/demo-mode.js', () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock('../../src/utils/storage.js', () => ({
  Local: { get: vi.fn(() => 'user@example.com') },
}));
vi.mock('../../src/utils/push-notifications.js', () => ({
  getActivePushProvider: () => null,
  canReceiveWebPush: async () => false,
}));

import {
  connectNotifications,
  getBadgeCount,
  setBadgeCount,
} from '../../src/utils/notification-manager.js';

function createMockWsClient() {
  const listeners = {};
  return {
    on(event, handler) {
      (listeners[event] ||= []).push(handler);
      return () => {};
    },
    emit(event, data) {
      for (const handler of listeners[event] || []) handler(data);
    },
  };
}

describe('badge from flag and expunge events', () => {
  let wsClient;
  let cleanup;

  beforeEach(async () => {
    await setBadgeCount(10);
    wsClient = createMockWsClient();
    cleanup = connectNotifications(wsClient);
  });

  afterEach(() => cleanup?.());

  const seen = (extra) => ({ action: 'add', flags: ['\\Seen'], ...extra });

  it('moves by the number of messages marked read in INBOX', async () => {
    wsClient.emit('flagsUpdated', seen({ path: 'INBOX', uids: [1, 2, 3], notificationId: 'a' }));
    await vi.waitFor(() => expect(getBadgeCount()).toBe(7));
    wsClient.emit('flagsUpdated', {
      action: 'remove',
      flags: ['\\Seen'],
      path: 'INBOX',
      uids: [1],
      notificationId: 'b',
    });
    await vi.waitFor(() => expect(getBadgeCount()).toBe(8));
  });

  it('resolves a mailbox id to INBOX', async () => {
    wsClient.emit('flagsUpdated', seen({ mailbox: 'inbox-id', uids: [4, 5], notificationId: 'c' }));
    await vi.waitFor(() => expect(getBadgeCount()).toBe(8));
  });

  it('ignores read changes outside INBOX', async () => {
    wsClient.emit('flagsUpdated', seen({ mailbox: 'sent-id', uids: [1], notificationId: 'd' }));
    wsClient.emit('flagsUpdated', seen({ path: 'Sent', uids: [2], notificationId: 'e' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(getBadgeCount()).toBe(10);
  });

  it('counts one change once when the server sends it twice', async () => {
    const copy = { path: 'INBOX', uids: [1], timestamp: 1000 };
    wsClient.emit('flagsUpdated', seen({ ...copy, notificationId: 'f1' }));
    wsClient.emit('flagsUpdated', seen({ ...copy, notificationId: 'f2' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(getBadgeCount()).toBe(9);
  });

  it('leaves an expunge to the unread recount', async () => {
    // Expunged messages may have been read; only a recount can tell.
    wsClient.emit('messagesExpunged', { mailbox: 'inbox-id', uids: [1, 2], notificationId: 'g' });
    await new Promise((r) => setTimeout(r, 20));
    expect(getBadgeCount()).toBe(10);
  });
});
