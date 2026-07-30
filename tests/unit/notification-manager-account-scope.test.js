/**
 * Notification Manager – multi-account store scoping
 *
 * The multi-account WebSocket manager routes every signed-in account's
 * events through handleNewMessage. The optimistic prepend into the visible
 * message list must only happen for the active account: the folder-name
 * guard alone passes for every account (INBOX === INBOX), which leaked
 * other accounts' deliveries into whatever list was on screen and stamped
 * them with the active account's email.
 */

// A minimal svelte-store-contract writable that vi.hoisted can build without
// importing svelte/store (mock factories run before module imports).
const { messagesStore, selectedFolderStore } = vi.hoisted(() => {
  function miniWritable(initial) {
    let value = initial;
    const subs = new Set();
    return {
      subscribe(fn) {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
      set(next) {
        value = next;
        for (const fn of subs) fn(value);
      },
      get value() {
        return value;
      },
    };
  }

  return {
    messagesStore: miniWritable([]),
    selectedFolderStore: miniWritable('INBOX'),
  };
});

// ── Mocks ─────────────────────────────────────────────────────────────────

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

// Active account is a@example.com for every test.
vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: vi.fn((key) => (key === 'email' ? 'a@example.com' : null)),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../src/stores/mailboxStore', () => ({
  mailboxStore: {
    state: {
      folders: { subscribe: (fn) => (fn([]), () => {}) },
      selectedFolder: selectedFolderStore,
      messages: messagesStore,
    },
  },
}));

vi.mock('../../src/utils/websocket-client', () => ({
  WS_EVENTS: {
    NEW_MESSAGE: 'newMessage',
    MESSAGES_MOVED: 'messagesMoved',
    MESSAGES_COPIED: 'messagesCopied',
    FLAGS_UPDATED: 'flagsUpdated',
    MESSAGES_EXPUNGED: 'messagesExpunged',
    MAILBOX_CREATED: 'mailboxCreated',
    MAILBOX_DELETED: 'mailboxDeleted',
    MAILBOX_RENAMED: 'mailboxRenamed',
    CALENDAR_CREATED: 'calendarCreated',
    CALENDAR_UPDATED: 'calendarUpdated',
    CALENDAR_DELETED: 'calendarDeleted',
    CALENDAR_EVENT_CREATED: 'calendarEventCreated',
    CALENDAR_EVENT_UPDATED: 'calendarEventUpdated',
    CALENDAR_EVENT_DELETED: 'calendarEventDeleted',
    ADDRESS_BOOK_CREATED: 'addressBookCreated',
    ADDRESS_BOOK_DELETED: 'addressBookDeleted',
    CONTACT_CREATED: 'contactCreated',
    CONTACT_UPDATED: 'contactUpdated',
    CONTACT_DELETED: 'contactDeleted',
    NEW_RELEASE: 'newRelease',
  },
}));

import { notify } from '../../src/utils/notification-bridge.js';
import {
  connectNotifications,
  requestNotificationPermission,
} from '../../src/utils/notification-manager.js';

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

function newMessageEvent({ account, uid, from = 'Sender <sender@other.com>' }) {
  return {
    ...(account ? { _account: account } : {}),
    mailbox: 'INBOX',
    message: {
      uid,
      id: uid,
      from,
      subject: `Subject ${uid}`,
      flags: [],
    },
  };
}

// Let the fire-and-forget prepend (dynamic imports inside) settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

// ── Tests ─────────────────────────────────────────────────────────────────

describe('notification-manager multi-account store scoping', () => {
  let wsClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Simulate background so handleNewMessage fires OS notification (not toast)
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    messagesStore.set([]);
    selectedFolderStore.set('INBOX');
    await requestNotificationPermission();
    wsClient = createMockWsClient();
    connectNotifications(wsClient);
  });

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
  });

  it("ignores another account's delivery entirely — no row, no notification", async () => {
    wsClient.emit('newMessage', newMessageEvent({ account: 'b@example.com', uid: 101 }));
    await settle();

    // Notifications describe the mailbox on screen. An account the user is not
    // looking at gets no OS notification, no toast and no row: it refreshes
    // when they switch to it.
    expect(notify).not.toHaveBeenCalled();
    expect(messagesStore.value).toHaveLength(0);
  });

  it("still notifies for the active account's delivery", async () => {
    wsClient.emit('newMessage', newMessageEvent({ account: 'a@example.com', uid: 104 }));

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });
  });

  it('scopes the notification dedup tag by account so UIDs cannot collide', async () => {
    // UIDs are per-mailbox counters, so two accounts routinely hold the same
    // one. The tag has to carry the account or the first account to see UID 105
    // permanently suppresses the second account's UID 105.
    wsClient.emit('newMessage', newMessageEvent({ account: 'a@example.com', uid: 105 }));
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalled();
    });

    const tag = notify.mock.calls[0][0]?.tag;
    expect(tag).toContain('a@example.com');
    expect(tag).toContain('105');
  });

  it("prepends the active account's delivery and stamps the event account", async () => {
    wsClient.emit('newMessage', newMessageEvent({ account: 'a@example.com', uid: 102 }));

    await vi.waitFor(() => {
      expect(messagesStore.value).toHaveLength(1);
    });

    const row = messagesStore.value[0];
    expect(row.account).toBe('a@example.com');
    expect(row.id).toBe('102');
    expect(row.from).toContain('sender@other.com');
  });

  // Push payloads used to arrive untagged, which is why "untagged means active"
  // exists at all. They now carry `_account`, resolved from `alias_id` at the
  // point push enters the app, so this fallback covers only a single-account
  // install or a registration made before alias IDs were captured. Dropping
  // those would silently stop their notifications, so they stay permissive.
  it('treats an untagged event as active (single-account and legacy installs)', async () => {
    wsClient.emit('newMessage', newMessageEvent({ uid: 103 }));

    await vi.waitFor(() => {
      expect(messagesStore.value).toHaveLength(1);
    });

    expect(messagesStore.value[0].account).toBe('a@example.com');
  });
});
