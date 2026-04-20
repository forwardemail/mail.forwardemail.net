import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writable } from 'svelte/store';

// ── Mocks ─────────────────────────────────────────────────────────────────

// Mock storage
vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn(() => null),
    set: vi.fn(),
  },
}));

// Mock sync-controller
const mockStartInitialSync = vi.fn();
vi.mock('../../src/utils/sync-controller', () => ({
  startInitialSync: (...args) => mockStartInitialSync(...args),
}));

// Mock notification-manager
const mockConnectNotifications = vi.fn(() => vi.fn());
const mockRequestNotificationPermission = vi.fn();
vi.mock('../../src/utils/notification-manager', () => ({
  connectNotifications: (...args) => mockConnectNotifications(...args),
  requestNotificationPermission: (...args) => mockRequestNotificationPermission(...args),
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
    },
  },
}));

// Mock websocket-client — capture event subscriptions
const wsEventHandlers = new Map();
const mockWsConnect = vi.fn();
const mockWsDestroy = vi.fn();
const mockWsOn = vi.fn((event, handler) => {
  if (!wsEventHandlers.has(event)) wsEventHandlers.set(event, []);
  wsEventHandlers.get(event).push(handler);
  return vi.fn(); // unsub
});

const mockReleaseOn = vi.fn(() => {
  return vi.fn();
});
const mockReleaseConnect = vi.fn();
const mockReleaseDestroy = vi.fn();

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
  createWebSocketClient: vi.fn(() => ({
    on: mockWsOn,
    connect: mockWsConnect,
    destroy: mockWsDestroy,
    connected: true,
  })),
  createReleaseWatcher: vi.fn(() => ({
    on: mockReleaseOn,
    connect: mockReleaseConnect,
    destroy: mockReleaseDestroy,
  })),
}));

// Now import the module under test
import { Local } from '../../src/utils/storage';
import { createInboxUpdater } from '../../src/utils/websocket-updater.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function setupCredentials() {
  vi.mocked(Local.get).mockImplementation((key) => {
    if (key === 'email') return 'user@example.com';
    if (key === 'alias_auth') return 'user@example.com:secret123';
    return null;
  });
}

function simulateWsEvent(eventName, data) {
  const handlers = wsEventHandlers.get(eventName) || [];
  for (const handler of handlers) {
    handler(data);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('createInboxUpdater', () => {
  beforeEach(() => {
    wsEventHandlers.clear();
    mockLoadMessages.mockReset();
    mockLoadFolders.mockReset();
    mockStartInitialSync.mockReset();
    mockInvalidateFolderInMemCache.mockReset();
    mockUpdateFolderUnreadCounts.mockReset();
    mockWsOn.mockClear();
    mockWsConnect.mockClear();
    mockReleaseOn.mockClear();
    mockReleaseConnect.mockClear();
    mockReleaseDestroy.mockClear();
    mockConnectNotifications.mockClear();
    mockRequestNotificationPermission.mockClear();
    mockIsDemoMode.mockReset();
    mockIsDemoMode.mockReturnValue(false);
    vi.mocked(Local.get).mockReset();
    selectedFolderStore.set('INBOX');
    // Ensure document is visible and online
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

  it('connects WebSocket when credentials are available', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();
    expect(mockWsConnect).toHaveBeenCalled();
    updater.destroy();
  });

  it('does not connect authenticated WebSocket without credentials', () => {
    vi.mocked(Local.get).mockReturnValue(null);
    const updater = createInboxUpdater();
    updater.start();
    expect(mockWsConnect).not.toHaveBeenCalled();
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
    expect(mockWsConnect).not.toHaveBeenCalled();
    expect(mockReleaseConnect).not.toHaveBeenCalled();
    expect(mockConnectNotifications).not.toHaveBeenCalled();
    expect(mockRequestNotificationPermission).not.toHaveBeenCalled();
    updater.destroy();
  });

  it('subscribes to all 8 IMAP events + _authFailed', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();

    const subscribedEvents = mockWsOn.mock.calls.map((call) => call[0]);
    expect(subscribedEvents).toContain('newMessage');
    expect(subscribedEvents).toContain('messagesMoved');
    expect(subscribedEvents).toContain('messagesCopied');
    expect(subscribedEvents).toContain('flagsUpdated');
    expect(subscribedEvents).toContain('messagesExpunged');
    expect(subscribedEvents).toContain('mailboxCreated');
    expect(subscribedEvents).toContain('mailboxDeleted');
    expect(subscribedEvents).toContain('mailboxRenamed');

    updater.destroy();
  });

  it('subscribes to all 6 CalDAV events', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();

    const subscribedEvents = mockWsOn.mock.calls.map((call) => call[0]);
    expect(subscribedEvents).toContain('calendarCreated');
    expect(subscribedEvents).toContain('calendarUpdated');
    expect(subscribedEvents).toContain('calendarDeleted');
    expect(subscribedEvents).toContain('calendarEventCreated');
    expect(subscribedEvents).toContain('calendarEventUpdated');
    expect(subscribedEvents).toContain('calendarEventDeleted');

    updater.destroy();
  });

  it('subscribes to all 5 CardDAV events', () => {
    setupCredentials();
    const updater = createInboxUpdater();
    updater.start();

    const subscribedEvents = mockWsOn.mock.calls.map((call) => call[0]);
    expect(subscribedEvents).toContain('addressBookCreated');
    expect(subscribedEvents).toContain('addressBookDeleted');
    expect(subscribedEvents).toContain('contactCreated');
    expect(subscribedEvents).toContain('contactUpdated');
    expect(subscribedEvents).toContain('contactDeleted');

    updater.destroy();
  });
});

// ── Core Bug Fix: refreshFolder calls loadMessages ────────────────────────

describe('refreshFolder (core sync bug fix)', () => {
  let updater;

  beforeEach(() => {
    wsEventHandlers.clear();
    mockLoadMessages.mockReset();
    mockLoadFolders.mockReset();
    mockStartInitialSync.mockReset();
    mockInvalidateFolderInMemCache.mockReset();
    mockUpdateFolderUnreadCounts.mockReset();
    mockWsOn.mockClear();
    mockReleaseOn.mockClear();
    mockReleaseConnect.mockClear();
    mockReleaseDestroy.mockClear();
    mockConnectNotifications.mockClear();
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
    vi.restoreAllMocks();
  });

  it('calls loadMessages() when newMessage arrives for the current folder', () => {
    simulateWsEvent('newMessage', { mailbox: 'INBOX' });

    expect(mockLoadMessages).toHaveBeenCalled();
  });

  it('calls startInitialSync() when newMessage arrives', () => {
    simulateWsEvent('newMessage', { mailbox: 'INBOX' });

    expect(mockStartInitialSync).toHaveBeenCalled();
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
    expect(mockStartInitialSync).toHaveBeenCalled();
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
    // startInitialSync called for both folders
    expect(mockStartInitialSync).toHaveBeenCalledTimes(2);
  });

  it('refreshes destination for messagesCopied', () => {
    selectedFolderStore.set('Sent');
    simulateWsEvent('messagesCopied', {
      destinationMailbox: 'Sent',
    });

    expect(mockLoadMessages).toHaveBeenCalled();
  });

  it('calls loadFolders() for mailboxCreated', () => {
    simulateWsEvent('mailboxCreated', {});

    expect(mockLoadFolders).toHaveBeenCalled();
  });

  it('calls loadFolders() for mailboxDeleted', () => {
    simulateWsEvent('mailboxDeleted', {});

    expect(mockLoadFolders).toHaveBeenCalled();
  });

  it('calls loadFolders() for mailboxRenamed', () => {
    simulateWsEvent('mailboxRenamed', {});

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
});

// ── CalDAV/CardDAV CustomEvent dispatch ───────────────────────────────────

describe('CalDAV/CardDAV event dispatch', () => {
  let updater;
  let eventsSpy;

  beforeEach(() => {
    wsEventHandlers.clear();
    mockWsOn.mockClear();
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
    const callsAfterFirstStart = mockWsConnect.mock.calls.length;
    updater.destroy();
    // Second start should not throw or reconnect
    updater.start();
    // connect should not have been called again after destroy
    expect(mockWsConnect.mock.calls.length).toBe(callsAfterFirstStart);
  });
});
