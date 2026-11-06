import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writable } from 'svelte/store';

// ── Mocks ─────────────────────────────────────────────────────────────────

// Mock storage
vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn(() => null),
    set: vi.fn(),
  },
  Accounts: {
    getAll: vi.fn(() => []),
  },
}));

// Mock sync-controller
const mockSyncFolderForEvent = vi.fn();
vi.mock('../../src/utils/sync-controller', () => ({
  syncFolderForEvent: (...args) => mockSyncFolderForEvent(...args),
}));

// Mock notification-manager
const mockConnectMultiAccountNotifications = vi.fn(() => vi.fn());
const mockRequestNotificationPermission = vi.fn();
vi.mock('../../src/utils/notification-manager', () => ({
  connectNotifications: vi.fn(() => vi.fn()),
  connectMultiAccountNotifications: (...args) => mockConnectMultiAccountNotifications(...args),
  initNotificationPermission: (...args) => {
    mockRequestNotificationPermission(...args);
    return Promise.resolve(false);
  },
}));

// Mock demo-mode helper
const mockIsDemoMode = vi.fn(() => false);
vi.mock('../../src/utils/demo-mode.js', () => ({
  isDemoMode: (...args) => mockIsDemoMode(...args),
}));

// Mock settingsStore
vi.mock('../../src/stores/settingsStore', () => ({
  fetchLabels: vi.fn(() => Promise.resolve()),
}));

// Track calls to mailbox store actions
const mockLoadMessages = vi.fn();
const mockLoadFolders = vi.fn();
const mockInvalidateFolderInMemCache = vi.fn();
const mockUpdateFolderUnreadCounts = vi.fn();
const mockResolveRealtimeFolder = vi.fn();
const mockRemoveRemoteMessages = vi.fn();
const mockApplyRemoteFlags = vi.fn();
const mockApplyRemoteLabels = vi.fn();
const mockApplyRemoteMailboxChange = vi.fn();
const mockIsCurrentViewFresh = vi.fn(() => false);

// Create writable stores for the mock mailbox state
const selectedFolderStore = writable('INBOX');
const foldersStore = writable([
  { path: 'INBOX', name: 'Inbox' },
  { path: 'Sent', name: 'Sent' },
  { path: 'Drafts', name: 'Drafts' },
  { path: 'Trash', name: 'Trash' },
]);

vi.mock('../../src/stores/mailboxStore', () => ({
  mailboxStore: {
    state: {
      selectedFolder: {
        subscribe: (fn) => selectedFolderStore.subscribe(fn),
      },
      folders: {
        subscribe: (fn) => foldersStore.subscribe(fn),
      },
    },
    actions: {
      loadMessages: (...args) => mockLoadMessages(...args),
      loadFolders: (...args) => mockLoadFolders(...args),
      invalidateFolderInMemCache: (...args) => mockInvalidateFolderInMemCache(...args),
      updateFolderUnreadCounts: (...args) => mockUpdateFolderUnreadCounts(...args),
      resolveRealtimeFolder: (...args) => mockResolveRealtimeFolder(...args),
      removeRemoteMessages: (...args) => mockRemoveRemoteMessages(...args),
      applyRemoteFlags: (...args) => mockApplyRemoteFlags(...args),
      applyRemoteLabels: (...args) => mockApplyRemoteLabels(...args),
      applyRemoteMailboxChange: (...args) => mockApplyRemoteMailboxChange(...args),
      isCurrentViewFresh: (...args) => mockIsCurrentViewFresh(...args),
    },
  },
}));

// Mock websocket-manager — the updater now uses the manager, not raw clients
const mgrEventHandlers = new Map();
const mockMgrReconcile = vi.fn();
const mockMgrReconnectAll = vi.fn();
const mockMgrDestroy = vi.fn();
const mockMgrOn = vi.fn((event, handler) => {
  if (!mgrEventHandlers.has(event)) mgrEventHandlers.set(event, []);
  mgrEventHandlers.get(event).push(handler);
  return vi.fn(); // unsub
});

const mockGetClient = vi.fn(() => ({ connected: true }));
const mockManager = {
  reconcile: mockMgrReconcile,
  reconnectAll: mockMgrReconnectAll,
  destroy: mockMgrDestroy,
  on: mockMgrOn,
  off: vi.fn(),
  removeAccount: vi.fn(),
  getClients: vi.fn(() => new Map()),
  getClient: (...args) => mockGetClient(...args),
  get anyConnected() {
    return true;
  },
  get connectionCount() {
    return 1;
  },
};

const mockDestroyWebSocketManager = vi.fn();
vi.mock('../../src/utils/websocket-manager.js', () => ({
  getWebSocketManager: () => mockManager,
  destroyWebSocketManager: (...args) => mockDestroyWebSocketManager(...args),
}));

// Mock websocket-client (still needed for createReleaseWatcher and WS_EVENTS)
const mockReleaseOn = vi.fn(() => vi.fn());
const mockReleaseConnect = vi.fn();
const mockReleaseDestroy = vi.fn();
const mockWsConnect = vi.fn();

vi.mock('../../src/utils/websocket-client', () => ({
  WS_EVENTS: {
    NEW_MESSAGE: 'newMessage',
    MESSAGES_MOVED: 'messagesMoved',
    MESSAGES_COPIED: 'messagesCopied',
    FLAGS_UPDATED: 'flagsUpdated',
    LABELS_UPDATED: 'labelsUpdated',
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
    ADDRESS_BOOK_UPDATED: 'addressBookUpdated',
    ADDRESS_BOOK_DELETED: 'addressBookDeleted',
    CONTACT_CREATED: 'contactCreated',
    CONTACT_UPDATED: 'contactUpdated',
    CONTACT_DELETED: 'contactDeleted',
    NEW_RELEASE: 'newRelease',
  },
  createWebSocketClient: vi.fn(() => ({
    on: vi.fn(() => vi.fn()),
    connect: mockWsConnect,
    destroy: vi.fn(),
    connected: true,
  })),
  createReleaseWatcher: vi.fn(() => ({
    on: mockReleaseOn,
    connect: mockReleaseConnect,
    destroy: mockReleaseDestroy,
  })),
}));

// Now import the module under test
import { Accounts, Local } from '../../src/utils/storage';
import { createInboxUpdater, FOLDER_REFRESH_WINDOW_MS } from '../../src/utils/websocket-updater.js';
import { PUSH_COALESCE_MS } from '../../src/utils/realtime-event-coalescer.js';
import { listFreshness } from '../../src/utils/list-freshness';

// ── Helpers ───────────────────────────────────────────────────────────────

function setupCredentials() {
  vi.mocked(Local.get).mockImplementation((key) => {
    if (key === 'email') return 'user@example.com';
    if (key === 'alias_auth') return 'user@example.com:secret123';
    return null;
  });
}

/**
 * Simulate a WebSocket event coming through the manager.
 * The manager dispatches events to handlers registered via mgr.on(eventName, handler).
 */
function simulateWsEvent(eventName, data) {
  const handlers = mgrEventHandlers.get(eventName) || [];
  for (const handler of handlers) {
    handler(data);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('createInboxUpdater', () => {
  beforeEach(() => {
    mgrEventHandlers.clear();
    mockLoadMessages.mockReset();
    mockLoadFolders.mockReset();
    mockSyncFolderForEvent.mockReset();
    mockInvalidateFolderInMemCache.mockReset();
    mockUpdateFolderUnreadCounts.mockReset();
    mockMgrOn.mockClear();
    mockMgrReconcile.mockClear();
    mockMgrReconnectAll.mockClear();
    mockMgrDestroy.mockClear();
    mockReleaseOn.mockClear();
    mockReleaseConnect.mockClear();
    mockReleaseDestroy.mockClear();
    mockConnectMultiAccountNotifications.mockClear();
    mockRequestNotificationPermission.mockClear();
    mockIsDemoMode.mockReset();
    mockIsDemoMode.mockReturnValue(false);
    vi.mocked(Local.get).mockReset();
    selectedFolderStore.set('INBOX');
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an object with start, stop, destroy methods', () => {
    const updater = createInboxUpdater();
    expect(updater).toHaveProperty('start');
    expect(updater).toHaveProperty('stop');
    expect(updater).toHaveProperty('destroy');
    expect(typeof updater.start).toBe('function');
    expect(typeof updater.stop).toBe('function');
    expect(typeof updater.destroy).toBe('function');
  });

  it('calls manager.reconcile() when credentials are available', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();
    expect(mockMgrReconcile).toHaveBeenCalled();
    updater.destroy();
  });

  it('does not call manager.reconcile() without credentials', () => {
    vi.mocked(Local.get).mockReturnValue(null);
    const updater = createInboxUpdater();
    updater.start();
    expect(mockMgrReconcile).not.toHaveBeenCalled();
    updater.destroy();
  });

  it('always starts the release watcher outside demo mode', () => {
    vi.mocked(Local.get).mockReturnValue(null);
    const updater = createInboxUpdater();
    updater.start();
    expect(mockReleaseConnect).toHaveBeenCalled();
    updater.destroy();
  });

  it('skips websocket, release watcher, and notification permission setup in demo mode', () => {
    setupCredentials();
    mockIsDemoMode.mockReturnValue(true);
    const updater = createInboxUpdater();
    updater.start();
    expect(mockMgrReconcile).not.toHaveBeenCalled();
    expect(mockReleaseConnect).not.toHaveBeenCalled();
    expect(mockConnectMultiAccountNotifications).not.toHaveBeenCalled();
    expect(mockRequestNotificationPermission).not.toHaveBeenCalled();
    updater.destroy();
  });

  it('subscribes to all 8 IMAP events + _authFailed via manager.on()', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();

    const subscribedEvents = mockMgrOn.mock.calls.map((call) => call[0]);
    expect(subscribedEvents).toContain('newMessage');
    expect(subscribedEvents).toContain('messagesMoved');
    expect(subscribedEvents).toContain('messagesCopied');
    expect(subscribedEvents).toContain('flagsUpdated');
    expect(subscribedEvents).toContain('messagesExpunged');
    expect(subscribedEvents).toContain('mailboxCreated');
    expect(subscribedEvents).toContain('mailboxDeleted');
    expect(subscribedEvents).toContain('mailboxRenamed');
    expect(subscribedEvents).toContain('_authFailed');

    updater.destroy();
  });

  it("reports a socket auth failure to the app only for the active account's socket", () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();
    const failed = [];
    const onFailed = (event) => failed.push(event.detail.account);
    window.addEventListener('fe:auth-failed', onFailed);

    // e.g. another account is an alias without IMAP (4403)
    simulateWsEvent('_authFailed', { code: 4403, _account: 'other@example.com' });
    simulateWsEvent('_authFailed', { code: 4401, _account: 'user@example.com' });

    window.removeEventListener('fe:auth-failed', onFailed);
    updater.destroy();
    expect(failed).toEqual(['user@example.com']);
  });

  it('subscribes to all 6 CalDAV events via manager.on()', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();

    const subscribedEvents = mockMgrOn.mock.calls.map((call) => call[0]);
    expect(subscribedEvents).toContain('calendarCreated');
    expect(subscribedEvents).toContain('calendarUpdated');
    expect(subscribedEvents).toContain('calendarDeleted');
    expect(subscribedEvents).toContain('calendarEventCreated');
    expect(subscribedEvents).toContain('calendarEventUpdated');
    expect(subscribedEvents).toContain('calendarEventDeleted');

    updater.destroy();
  });

  it('subscribes to all 6 CardDAV events via manager.on()', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();

    const subscribedEvents = mockMgrOn.mock.calls.map((call) => call[0]);
    expect(subscribedEvents).toContain('addressBookCreated');
    expect(subscribedEvents).toContain('addressBookUpdated');
    expect(subscribedEvents).toContain('addressBookDeleted');
    expect(subscribedEvents).toContain('contactCreated');
    expect(subscribedEvents).toContain('contactUpdated');
    expect(subscribedEvents).toContain('contactDeleted');

    updater.destroy();
  });

  it('connects multi-account notifications to the manager', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();
    expect(mockConnectMultiAccountNotifications).toHaveBeenCalledWith(mockManager);
    updater.destroy();
  });

  it('retries refused sockets on resume or unlock but not on a visibility change', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(mockMgrReconnectAll).toHaveBeenCalledTimes(1);
      expect(mockMgrReconnectAll).toHaveBeenLastCalledWith();

      globalThis.dispatchEvent(new CustomEvent('fe:force-reconnect'));
      expect(mockMgrReconnectAll).toHaveBeenCalledTimes(2);
      expect(mockMgrReconnectAll).toHaveBeenLastCalledWith({ force: true });
    } finally {
      updater.destroy();
    }
  });
});

// ── Core Bug Fix: refreshFolder calls loadMessages ────────────────────────

describe('refreshFolder (core sync bug fix)', () => {
  let updater;

  beforeEach(() => {
    mgrEventHandlers.clear();
    mockLoadMessages.mockReset();
    mockLoadFolders.mockReset();
    mockSyncFolderForEvent.mockReset();
    mockInvalidateFolderInMemCache.mockReset();
    mockUpdateFolderUnreadCounts.mockReset();
    mockMgrOn.mockClear();
    mockMgrReconcile.mockClear();
    mockReleaseOn.mockClear();
    mockReleaseConnect.mockClear();
    mockReleaseDestroy.mockClear();
    mockConnectMultiAccountNotifications.mockClear();
    mockRequestNotificationPermission.mockClear();
    mockIsDemoMode.mockReset();
    mockIsDemoMode.mockReturnValue(false);
    vi.mocked(Local.get).mockReset();
    selectedFolderStore.set('INBOX');
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      writable: true,
      configurable: true,
    });

    setupCredentials();
    updater = createInboxUpdater();
    updater.start();
  });

  afterEach(() => {
    updater.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls loadMessages() when newMessage arrives for the current folder', () => {
    simulateWsEvent('newMessage', { mailbox: 'INBOX' });
    expect(mockLoadMessages).toHaveBeenCalled();
  });

  it('calls syncFolderForEvent() when newMessage arrives', () => {
    simulateWsEvent('newMessage', { mailbox: 'INBOX' });
    expect(mockSyncFolderForEvent).toHaveBeenCalled();
  });

  it('calls invalidateFolderInMemCache() before loadMessages()', () => {
    simulateWsEvent('newMessage', { mailbox: 'INBOX' });
    expect(mockInvalidateFolderInMemCache).toHaveBeenCalled();
  });

  it('calls updateFolderUnreadCounts() on any folder event', () => {
    simulateWsEvent('newMessage', { mailbox: 'INBOX' });
    expect(mockUpdateFolderUnreadCounts).toHaveBeenCalled();
  });

  it('does NOT call loadMessages() when event is for a different folder', () => {
    selectedFolderStore.set('INBOX');
    simulateWsEvent('newMessage', { mailbox: 'Sent' });
    expect(mockLoadMessages).not.toHaveBeenCalled();
    // But sync should still run
    expect(mockSyncFolderForEvent).toHaveBeenCalled();
  });

  // A batch of deliveries asked the server again for the folder once per
  // message: a sync and the list, each a list of the folder on the server.
  it('asks the server once at once and once more for a burst of events in one folder', async () => {
    vi.useFakeTimers();
    for (let uid = 1; uid <= 5; uid++) simulateWsEvent('newMessage', { mailbox: 'INBOX', uid });
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(1);
    expect(mockLoadMessages).toHaveBeenCalledTimes(1);
    // each event still drops the cached pages of the folder at once
    expect(mockInvalidateFolderInMemCache).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(FOLDER_REFRESH_WINDOW_MS);
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(2);
    expect(mockLoadMessages).toHaveBeenCalledTimes(2);

    // another folder is not held back by it
    simulateWsEvent('newMessage', { mailbox: 'Sent', uid: 9 });
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(3);

    // and an event after the window asks at once again
    await vi.advanceTimersByTimeAsync(FOLDER_REFRESH_WINDOW_MS);
    simulateWsEvent('newMessage', { mailbox: 'INBOX', uid: 6 });
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(4);
    expect(mockLoadMessages).toHaveBeenCalledTimes(3);
  });

  it('does not reload a list the user left before the end of the window', async () => {
    vi.useFakeTimers();
    simulateWsEvent('newMessage', { mailbox: 'INBOX', uid: 1 });
    simulateWsEvent('newMessage', { mailbox: 'INBOX', uid: 2 });
    selectedFolderStore.set('Sent');
    await vi.advanceTimersByTimeAsync(FOLDER_REFRESH_WINDOW_MS);
    // the folder is still synced, the list on screen is another one
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(2);
    expect(mockLoadMessages).toHaveBeenCalledTimes(1);
  });

  // syncFolderForEvent for another account resets the sync queue to it
  it('does not sync the folder of an account switched away from at the end of the window', async () => {
    vi.useFakeTimers();
    simulateWsEvent('newMessage', { mailbox: 'INBOX', uid: 1 });
    simulateWsEvent('newMessage', { mailbox: 'INBOX', uid: 2 });
    vi.mocked(Local.get).mockImplementation((key) =>
      key === 'email' ? 'other@example.com' : null,
    );
    await vi.advanceTimersByTimeAsync(FOLDER_REFRESH_WINDOW_MS);
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(1);
    expect(mockSyncFolderForEvent).toHaveBeenCalledWith('user@example.com', expect.anything());
  });

  it('asks at once after the clock was set back', async () => {
    vi.useFakeTimers();
    simulateWsEvent('newMessage', { mailbox: 'INBOX', uid: 1 });
    vi.setSystemTime(Date.now() - 60_000);
    simulateWsEvent('newMessage', { mailbox: 'INBOX', uid: 2 });
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(2);
    expect(mockLoadMessages).toHaveBeenCalledTimes(2);
  });

  it('drops a refresh still waiting for the end of the window when stopped', async () => {
    vi.useFakeTimers();
    simulateWsEvent('newMessage', { mailbox: 'INBOX', uid: 1 });
    simulateWsEvent('newMessage', { mailbox: 'INBOX', uid: 2 });
    updater.stop();
    await vi.advanceTimersByTimeAsync(FOLDER_REFRESH_WINDOW_MS);
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(1);
  });

  it('calls loadMessages() for flagsUpdated on current folder', () => {
    simulateWsEvent('flagsUpdated', { mailbox: 'INBOX' });
    expect(mockLoadMessages).toHaveBeenCalled();
  });

  it('calls loadMessages() for messagesExpunged on current folder', () => {
    simulateWsEvent('messagesExpunged', { mailbox: 'INBOX' });
    expect(mockLoadMessages).toHaveBeenCalled();
  });

  it('refreshes both source and destination for messagesMoved', () => {
    selectedFolderStore.set('INBOX');
    simulateWsEvent('messagesMoved', {
      sourceMailbox: 'INBOX',
      destinationMailbox: 'Trash',
    });
    // loadMessages called for INBOX (current folder)
    expect(mockLoadMessages).toHaveBeenCalled();
    // syncFolderForEvent called for both folders
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(2);
  });

  it('refreshes destination for messagesCopied', () => {
    selectedFolderStore.set('Sent');
    simulateWsEvent('messagesCopied', {
      destinationMailbox: 'Sent',
    });
    expect(mockLoadMessages).toHaveBeenCalled();
  });

  it('calls loadFolders() for mailboxCreated', () => {
    simulateWsEvent('mailboxCreated', { _account: 'user@example.com' });
    expect(mockLoadFolders).toHaveBeenCalled();
  });

  it('calls loadFolders() for mailboxDeleted', () => {
    simulateWsEvent('mailboxDeleted', { _account: 'user@example.com' });
    expect(mockLoadFolders).toHaveBeenCalled();
  });

  it('calls loadFolders() for mailboxRenamed', () => {
    simulateWsEvent('mailboxRenamed', { _account: 'user@example.com' });
    expect(mockLoadFolders).toHaveBeenCalled();
  });

  it('handles case-insensitive folder matching', () => {
    selectedFolderStore.set('inbox');
    simulateWsEvent('newMessage', { mailbox: 'INBOX' });
    expect(mockLoadMessages).toHaveBeenCalled();
  });

  it('defaults to INBOX when newMessage has no mailbox field', () => {
    selectedFolderStore.set('INBOX');
    simulateWsEvent('newMessage', {});
    expect(mockLoadMessages).toHaveBeenCalled();
  });

  it('runs refresh work once when push arrives before the matching WebSocket event', async () => {
    vi.useFakeTimers();
    const notificationId = '123e4567-e89b-12d3-a456-426614174100';
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'newMessage',
          notification_id: notificationId,
          mailbox: 'INBOX',
          message: { uid: 100 },
        },
      }),
    );
    // Before coalesce window closes, the WS event arrives (same notification_id)
    simulateWsEvent('newMessage', {
      mailbox: 'INBOX',
      uid: 100,
      notification_id: notificationId,
    });
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);
    // Should only have triggered once (WS wins)
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(1);
    expect(mockLoadMessages).toHaveBeenCalledTimes(1);
  });

  it('uses push refresh as a bounded fallback when WebSocket delivery is absent', async () => {
    vi.useFakeTimers();
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'newMessage',
          notification_id: '123e4567-e89b-12d3-a456-426614174101',
          mailbox: 'INBOX',
          message: { uid: 101 },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS - 1);
    expect(mockSyncFolderForEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(1);
    expect(mockLoadMessages).toHaveBeenCalledTimes(1);
  });

  it('still refreshes data for a push the system displayed', async () => {
    // The system drew the alert (app in the background on iOS or Android);
    // the change it carries must still reach the cache.
    vi.useFakeTimers();
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'newMessage',
          notification_id: '123e4567-e89b-12d3-a456-426614174102',
          mailbox: 'INBOX',
          message: { uid: 102 },
          displayedBySystem: true,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);
    expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(1);
    expect(mockLoadMessages).toHaveBeenCalledTimes(1);
  });
});

// ── CalDAV/CardDAV CustomEvent dispatch ───────────────────────────────────

describe('CalDAV/CardDAV event dispatch', () => {
  let updater;
  let eventsSpy;

  beforeEach(() => {
    mgrEventHandlers.clear();
    mockMgrOn.mockClear();
    vi.mocked(Local.get).mockReset();
    eventsSpy = vi.fn();
    setupCredentials();
    updater = createInboxUpdater();
    updater.start();
  });

  afterEach(() => {
    updater.destroy();
    window.removeEventListener('fe:calendar-changed', eventsSpy);
    window.removeEventListener('fe:calendar-event-changed', eventsSpy);
    window.removeEventListener('fe:contacts-changed', eventsSpy);
    window.removeEventListener('fe:contact-changed', eventsSpy);
  });

  it("ignores another account's calendar and contact changes", () => {
    // The views show the active account and match by iCal or vCard UID,
    // which another account can share.
    for (const name of [
      'fe:calendar-changed',
      'fe:calendar-event-changed',
      'fe:contacts-changed',
      'fe:contact-changed',
    ]) {
      window.addEventListener(name, eventsSpy);
    }
    const other = { _account: 'other@example.com', uid: 'shared-uid' };
    simulateWsEvent('calendarUpdated', { ...other, id: 'cal-1' });
    simulateWsEvent('calendarEventDeleted', { ...other, eventId: 'e1' });
    simulateWsEvent('addressBookUpdated', { ...other, id: 'ab-1' });
    simulateWsEvent('contactDeleted', { ...other, contactId: 'c1' });
    expect(eventsSpy).not.toHaveBeenCalled();

    simulateWsEvent('calendarEventDeleted', { _account: 'user@example.com', eventId: 'e2' });
    expect(eventsSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatches fe:calendar-changed for calendarCreated', () => {
    window.addEventListener('fe:calendar-changed', eventsSpy);
    simulateWsEvent('calendarCreated', { id: 'cal-1' });
    expect(eventsSpy).toHaveBeenCalled();
  });

  it('dispatches fe:calendar-event-changed for calendarEventUpdated', () => {
    window.addEventListener('fe:calendar-event-changed', eventsSpy);
    simulateWsEvent('calendarEventUpdated', { id: 'evt-1' });
    expect(eventsSpy).toHaveBeenCalled();
  });

  it('dispatches fe:contacts-changed for addressBookCreated', () => {
    window.addEventListener('fe:contacts-changed', eventsSpy);
    simulateWsEvent('addressBookCreated', { id: 'ab-1' });
    expect(eventsSpy).toHaveBeenCalled();
  });

  // an address book renamed or recolored in another client (CardDAV PROPPATCH)
  it('dispatches fe:contacts-changed for addressBookUpdated', () => {
    window.addEventListener('fe:contacts-changed', eventsSpy);
    simulateWsEvent('addressBookUpdated', {
      addressBook: { id: 'ab-1', name: 'Renamed', object: 'address_book' },
    });
    expect(eventsSpy).toHaveBeenCalled();
  });

  it('dispatches fe:contact-changed for contactUpdated', () => {
    window.addEventListener('fe:contact-changed', eventsSpy);
    simulateWsEvent('contactUpdated', { id: 'ct-1' });
    expect(eventsSpy).toHaveBeenCalled();
  });

  it('freezes CustomEvent detail to prevent mutation', () => {
    let detail = null;
    const handler = (e) => {
      detail = e.detail;
    };
    window.addEventListener('fe:calendar-changed', handler);
    simulateWsEvent('calendarCreated', { id: 'cal-1' });
    window.removeEventListener('fe:calendar-changed', handler);
    expect(detail).not.toBeNull();
    expect(Object.isFrozen(detail)).toBe(true);
  });

  it('does not dispatch CalDAV events for non-object data', () => {
    window.addEventListener('fe:calendar-changed', eventsSpy);
    simulateWsEvent('calendarCreated', null);
    simulateWsEvent('calendarCreated', 'string');
    simulateWsEvent('calendarCreated', 42);
    expect(eventsSpy).not.toHaveBeenCalled();
  });
});

// ── stop / destroy lifecycle ──────────────────────────────────────────────

describe('stop and destroy lifecycle', () => {
  it('stop is idempotent', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();
    expect(() => {
      updater.stop();
      updater.stop();
    }).not.toThrow();
  });

  it('destroy is idempotent', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();
    expect(() => {
      updater.destroy();
      updater.destroy();
    }).not.toThrow();
  });

  it('start after destroy is a no-op', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();
    const callsAfterFirstStart = mockMgrReconcile.mock.calls.length;
    updater.destroy();
    // Second start should not throw or reconnect
    updater.start();
    // reconcile should not have been called again after destroy
    expect(mockMgrReconcile.mock.calls.length).toBe(callsAfterFirstStart);
  });
});

// ── Applying what an event says changed ───────────────────────────────────

describe('event payloads applied to the store', () => {
  let updater;

  beforeEach(() => {
    mgrEventHandlers.clear();
    for (const fn of [
      mockLoadMessages,
      mockLoadFolders,
      mockSyncFolderForEvent,
      mockInvalidateFolderInMemCache,
      mockUpdateFolderUnreadCounts,
      mockRemoveRemoteMessages,
      mockApplyRemoteFlags,
      mockApplyRemoteLabels,
      mockApplyRemoteMailboxChange,
    ]) {
      fn.mockReset();
    }
    // Mailbox ids resolve to paths the way the store does.
    mockResolveRealtimeFolder.mockReset();
    mockResolveRealtimeFolder.mockImplementation(async (_account, mailbox, path) => {
      if (path) return path;
      return { 'inbox-id': 'INBOX', 'trash-id': 'Trash' }[mailbox] || '';
    });
    mockRemoveRemoteMessages.mockResolvedValue([]);
    mockApplyRemoteFlags.mockResolvedValue([]);
    mockGetClient.mockReset();
    mockGetClient.mockReturnValue({ connected: true });
    mockIsDemoMode.mockReturnValue(false);
    selectedFolderStore.set('INBOX');
    foldersStore.set([
      { id: 'inbox-id', path: 'INBOX', name: 'Inbox' },
      { id: 'trash-id', path: 'Trash', name: 'Trash' },
    ]);
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    setupCredentials();
    updater = createInboxUpdater();
    updater.start();
  });

  afterEach(() => {
    updater.destroy();
    vi.useRealTimers();
  });

  it('removes expunged messages, then reloads the folder from the server', async () => {
    simulateWsEvent('messagesExpunged', {
      _account: 'user@example.com',
      mailbox: 'inbox-id',
      uids: [3, 4],
    });

    await vi.waitFor(() => expect(mockLoadMessages).toHaveBeenCalledWith({ refresh: true }));
    expect(mockRemoveRemoteMessages).toHaveBeenCalledWith({
      account: 'user@example.com',
      folder: 'INBOX',
      uids: [3, 4],
      ids: [],
    });
    expect(mockRemoveRemoteMessages.mock.invocationCallOrder[0]).toBeLessThan(
      mockLoadMessages.mock.invocationCallOrder[0],
    );
  });

  it('keeps only valid UIDs from an untrusted payload', async () => {
    simulateWsEvent('messagesExpunged', {
      mailbox: 'inbox-id',
      uids: [1, 'x', -2, 1.5, '3', { uid: 4 }, 1],
      ids: ['m1', 42, { id: 'x' }],
    });

    await vi.waitFor(() => expect(mockRemoveRemoteMessages).toHaveBeenCalled());
    expect(mockRemoveRemoteMessages).toHaveBeenCalledWith(
      expect.objectContaining({ uids: [1, 3], ids: ['m1', '42'] }),
    );
  });

  it('reads the UIDs of a push copy, where lists arrive as strings', async () => {
    vi.useFakeTimers();
    window.dispatchEvent(
      new CustomEvent('fe:push-notification', {
        detail: {
          event: 'messagesExpunged',
          notification_id: '123e4567-e89b-12d3-a456-426614174200',
          mailbox: 'inbox-id',
          uids: '[7,8]',
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(PUSH_COALESCE_MS);
    vi.useRealTimers();

    await vi.waitFor(() =>
      expect(mockRemoveRemoteMessages).toHaveBeenCalledWith(
        expect.objectContaining({ folder: 'INBOX', uids: [7, 8] }),
      ),
    );
  });

  it('removes moved messages from the source and refreshes both folders', async () => {
    simulateWsEvent('messagesMoved', {
      sourceMailbox: 'inbox-id',
      destinationMailbox: 'trash-id',
      destinationPath: 'Trash',
      sourceUid: [5],
      destinationUid: [105],
    });

    await vi.waitFor(() => expect(mockSyncFolderForEvent).toHaveBeenCalledTimes(2));
    expect(mockRemoveRemoteMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: 'INBOX',
        uids: [5],
        destinationFolder: 'Trash',
        destinationUids: [105],
      }),
    );
    expect(mockSyncFolderForEvent.mock.calls.map(([, folder]) => folder.path)).toEqual([
      'INBOX',
      'Trash',
    ]);
    expect(mockLoadMessages).toHaveBeenCalledTimes(1);
  });

  it('applies a flag change and still refreshes', async () => {
    simulateWsEvent('flagsUpdated', {
      mailbox: 'inbox-id',
      action: 'add',
      flags: ['\\Deleted'],
      uids: [9],
    });

    await vi.waitFor(() => expect(mockLoadMessages).toHaveBeenCalled());
    expect(mockApplyRemoteFlags).toHaveBeenCalledWith({
      account: 'user@example.com',
      folder: 'INBOX',
      uids: [9],
      ids: [],
      action: 'add',
      flags: ['\\Deleted'],
    });
  });

  it('does not apply an unknown flag action but still refreshes', () => {
    simulateWsEvent('flagsUpdated', {
      mailbox: 'inbox-id',
      action: 'toggle',
      flags: ['\\Seen'],
      uids: [9],
    });

    expect(mockApplyRemoteFlags).not.toHaveBeenCalled();
    expect(mockLoadMessages).toHaveBeenCalledWith({ refresh: true });
  });

  it('applies the first of two server copies of one flag change only', async () => {
    const change = {
      mailbox: 'inbox-id',
      action: 'add',
      flags: ['\\Seen'],
      uids: [9],
      timestamp: 1000,
    };
    simulateWsEvent('flagsUpdated', { ...change, notificationId: 'copy-1' });
    simulateWsEvent('flagsUpdated', { ...change, notificationId: 'copy-2' });

    await vi.waitFor(() => expect(mockLoadMessages).toHaveBeenCalled());
    expect(mockApplyRemoteFlags).toHaveBeenCalledTimes(1);
  });

  it('does not clear labels or flags for a set that does not name them', async () => {
    // Older servers send STORE FLAGS replacements as action 'set' without
    // the list; that says nothing about the new labels.
    simulateWsEvent('labelsUpdated', { mailbox: 'inbox-id', action: 'set', uids: [2] });
    simulateWsEvent('flagsUpdated', { mailbox: 'inbox-id', action: 'set', uids: [3] });

    expect(mockLoadMessages).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockApplyRemoteLabels).not.toHaveBeenCalled();
    expect(mockApplyRemoteFlags).not.toHaveBeenCalled();
  });

  it('applies a set to an empty list when the list is there', async () => {
    simulateWsEvent('labelsUpdated', { mailbox: 'inbox-id', action: 'set', uids: [2], labels: [] });
    simulateWsEvent('flagsUpdated', { mailbox: 'inbox-id', action: 'set', uids: [3], flags: '[]' });

    await vi.waitFor(() => expect(mockApplyRemoteFlags).toHaveBeenCalled());
    expect(mockApplyRemoteLabels).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'set', labels: [], uids: [2] }),
    );
    expect(mockApplyRemoteFlags).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'set', flags: [], uids: [3] }),
    );
  });

  it('marks a move as a move for the store', async () => {
    simulateWsEvent('messagesMoved', {
      sourceMailbox: 'inbox-id',
      destinationMailbox: 'trash-id',
      sourceUid: [5],
      destinationUid: [105],
    });

    await vi.waitFor(() => expect(mockRemoveRemoteMessages).toHaveBeenCalled());
    expect(mockRemoveRemoteMessages).toHaveBeenCalledWith(expect.objectContaining({ moved: true }));
  });

  it('passes a created folder to the store', () => {
    simulateWsEvent('mailboxCreated', { path: 'Trash', mailbox: 't' });
    expect(mockApplyRemoteMailboxChange).toHaveBeenCalledWith({
      account: 'user@example.com',
      type: 'created',
      path: 'Trash',
    });
  });

  it('applies labels with their action', async () => {
    simulateWsEvent('labelsUpdated', {
      mailbox: 'inbox-id',
      action: 'remove',
      labels: ['work'],
      uids: [2],
    });

    await vi.waitFor(() => expect(mockApplyRemoteLabels).toHaveBeenCalled());
    expect(mockApplyRemoteLabels).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'INBOX', action: 'remove', labels: ['work'], uids: [2] }),
    );
  });

  it('only refreshes for an untagged push while several accounts are signed in', async () => {
    // The alias map is incomplete, so the push may be about another account
    // whose INBOX shares the path.
    vi.mocked(Accounts.getAll).mockReturnValue([
      { email: 'user@example.com' },
      { email: 'other@example.com' },
    ]);
    simulateWsEvent('messagesExpunged', { mailbox: 'inbox-id', path: 'INBOX', uids: [1] });
    simulateWsEvent('flagsUpdated', {
      mailbox: 'inbox-id',
      action: 'add',
      flags: ['\\Seen'],
      uids: [1],
    });

    expect(mockLoadMessages).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(mockRemoveRemoteMessages).not.toHaveBeenCalled();
    expect(mockApplyRemoteFlags).not.toHaveBeenCalled();
    vi.mocked(Accounts.getAll).mockReturnValue([]);
  });

  it('applies an untagged push when one account is signed in', async () => {
    vi.mocked(Accounts.getAll).mockReturnValue([{ email: 'user@example.com' }]);
    simulateWsEvent('messagesExpunged', { mailbox: 'inbox-id', uids: [1] });

    await vi.waitFor(() =>
      expect(mockRemoveRemoteMessages).toHaveBeenCalledWith(
        expect.objectContaining({ account: 'user@example.com', uids: [1] }),
      ),
    );
    vi.mocked(Accounts.getAll).mockReturnValue([]);
  });

  it("keeps another account's cache current without touching the view", async () => {
    simulateWsEvent('messagesExpunged', {
      _account: 'other@example.com',
      mailbox: 'inbox-id',
      uids: [1],
    });

    await vi.waitFor(() => expect(mockRemoveRemoteMessages).toHaveBeenCalled());
    expect(mockRemoveRemoteMessages).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'other@example.com', uids: [1] }),
    );
    expect(mockLoadMessages).not.toHaveBeenCalled();
    expect(mockSyncFolderForEvent).not.toHaveBeenCalled();
  });

  it('applies folder renames and deletes and forces a folder reload', () => {
    simulateWsEvent('mailboxRenamed', { oldPath: 'Work', newPath: 'Projects', mailbox: 'w' });
    simulateWsEvent('mailboxDeleted', { path: 'Old', mailbox: 'o' });
    simulateWsEvent('mailboxCreated', { path: 'New', mailbox: 'n' });

    expect(mockApplyRemoteMailboxChange).toHaveBeenCalledWith({
      account: 'user@example.com',
      type: 'renamed',
      oldPath: 'Work',
      newPath: 'Projects',
    });
    expect(mockApplyRemoteMailboxChange).toHaveBeenCalledWith({
      account: 'user@example.com',
      type: 'deleted',
      path: 'Old',
    });
    expect(mockLoadFolders).toHaveBeenCalledTimes(3);
    for (const call of mockLoadFolders.mock.calls) expect(call[0]).toEqual({ force: true });
  });

  it('catches up after a reconnect, but not on the first connection', async () => {
    vi.useFakeTimers();
    simulateWsEvent('_authenticated', { _account: 'user@example.com' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockLoadMessages).not.toHaveBeenCalled();

    simulateWsEvent('_disconnected', { _account: 'user@example.com' });
    simulateWsEvent('_authenticated', { _account: 'user@example.com' });
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockLoadFolders).toHaveBeenCalledWith({ force: true });
    expect(mockLoadMessages).toHaveBeenCalledWith({ refresh: true });
  });

  it('catches up when the socket dropped a message', async () => {
    vi.useFakeTimers();
    simulateWsEvent('_messageDropped', { _account: 'user@example.com', reason: 'rate-limit' });
    simulateWsEvent('_messageDropped', { _account: 'user@example.com', reason: 'size' });
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockLoadMessages).toHaveBeenCalledTimes(1);
    expect(mockLoadFolders).toHaveBeenCalledWith({ force: true });
  });

  it("polls while the active account's socket is down, even if another is up", async () => {
    vi.useFakeTimers();
    updater.destroy();
    updater = createInboxUpdater();
    updater.start();
    mockGetClient.mockReturnValue({ connected: false });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockLoadMessages).toHaveBeenCalledWith({ refresh: true });
  });
});

describe('cached pages the socket keeps current', () => {
  // The real freshness tracker, fed by the updater: a shared inbox depends
  // on another person's changes reaching here, so every way the socket can
  // miss one has to make the cached pages stale.
  const ME = 'user@example.com';
  const PAGE = 'p1|newest|50';
  let updater;
  let calendarSpy;

  const syncPage = (folder, ids = []) =>
    listFreshness.mark(listFreshness.begin(ME), { folder, key: PAGE, rows: 1, ids });
  const fresh = (folder) => listFreshness.isFresh(ME, folder, PAGE, 1);
  const returnToApp = () => document.dispatchEvent(new Event('visibilitychange'));

  beforeEach(() => {
    mgrEventHandlers.clear();
    mockMgrOn.mockClear();
    mockLoadMessages.mockReset();
    mockIsCurrentViewFresh.mockReset();
    mockIsCurrentViewFresh.mockReturnValue(false);
    vi.mocked(Local.get).mockReset();
    mockGetClient.mockImplementation(() => ({
      connected: true,
      authenticated: true,
      lastHeardAt: Date.now(),
    }));
    selectedFolderStore.set('INBOX');
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    calendarSpy = vi.fn();
    window.addEventListener('fe:calendar-changed', calendarSpy);
    setupCredentials();
    updater = createInboxUpdater();
    updater.start();
  });

  afterEach(() => {
    updater.destroy();
    window.removeEventListener('fe:calendar-changed', calendarSpy);
    mockGetClient.mockImplementation(() => ({ connected: true }));
  });

  it('an event naming a folder makes that folder stale and leaves others alone', () => {
    syncPage('INBOX', ['mbx-inbox']);
    syncPage('Sent', ['mbx-sent']);
    simulateWsEvent('flagsUpdated', {
      _account: ME,
      mailbox: 'mbx-inbox',
      action: 'set',
      flags: ['\\Seen'],
      uids: [7],
    });
    expect(fresh('INBOX')).toBe(false);
    expect(fresh('Sent')).toBe(true);
  });

  it('a move makes both its folders stale', () => {
    syncPage('INBOX', ['mbx-inbox']);
    syncPage('Archive', ['mbx-archive']);
    simulateWsEvent('messagesMoved', {
      _account: ME,
      sourceMailbox: 'mbx-inbox',
      destinationMailbox: 'mbx-archive',
      sourceUid: [7],
      destinationUid: [70],
    });
    expect(fresh('INBOX')).toBe(false);
    expect(fresh('Archive')).toBe(false);
  });

  it('a disconnect or a dropped event makes every folder of that account stale', () => {
    syncPage('INBOX');
    simulateWsEvent('_disconnected', { _account: ME, code: 1006 });
    expect(fresh('INBOX')).toBe(false);

    syncPage('INBOX');
    simulateWsEvent('_messageDropped', { _account: ME, reason: 'rate-limit' });
    expect(fresh('INBOX')).toBe(false);
  });

  it('stopping realtime drops every cached page', () => {
    syncPage('INBOX');
    updater.stop();
    expect(fresh('INBOX')).toBe(false);
  });

  it('returning to the app refetches the folder only when it is not current', () => {
    mockIsCurrentViewFresh.mockReturnValue(true);
    returnToApp();
    expect(mockLoadMessages).not.toHaveBeenCalled();

    mockIsCurrentViewFresh.mockReturnValue(false);
    returnToApp();
    expect(mockLoadMessages).toHaveBeenCalledWith({ refresh: true });
  });

  it('calendars reload on return only after the socket may have missed a change', () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    try {
      returnToApp();
      expect(calendarSpy).toHaveBeenCalledTimes(1);

      // Past the 30 s throttle, with the socket delivering everything since.
      vi.setSystemTime(Date.now() + 60_000);
      returnToApp();
      expect(calendarSpy).toHaveBeenCalledTimes(1);

      simulateWsEvent('_disconnected', { _account: ME, code: 1006 });
      vi.setSystemTime(Date.now() + 60_000);
      returnToApp();
      expect(calendarSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
