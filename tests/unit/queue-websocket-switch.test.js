/**
 * Realtime events during an account switch, and folder renames.
 *
 * Switching sets the new account active before its list replaces the old
 * one on screen. An event of the new account arriving then must not be
 * applied to the old account's rows. A folder renamed elsewhere takes the
 * folders inside it along.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  active: 'b@example.com',
  handlers: new Map(),
  dbFolders: [],
}));

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: (key) => {
      if (key === 'email') return h.active;
      if (key === 'alias_auth') return `${h.active}:secret`;
      return null;
    },
    set: vi.fn(),
  },
  Accounts: { getAll: () => [{ email: 'a@example.com' }, { email: 'b@example.com' }] },
}));
vi.mock('../../src/utils/crypto-store.js', () => ({ isVaultLocked: () => false }));
vi.mock('../../src/utils/sync-controller', () => ({ syncFolderForEvent: vi.fn() }));
vi.mock('../../src/utils/notification-manager', () => ({
  connectMultiAccountNotifications: vi.fn(() => vi.fn()),
  initNotificationPermission: () => Promise.resolve(false),
}));
vi.mock('../../src/utils/demo-mode.js', () => ({ isDemoMode: () => false }));
vi.mock('../../src/stores/settingsStore', () => ({ fetchLabels: vi.fn(() => Promise.resolve()) }));
vi.mock('../../src/utils/db', () => ({
  db: {
    folders: {
      where: () => ({ equals: () => ({ toArray: async () => h.dbFolders }) }),
    },
  },
}));

const messagesStore = writable([]);
const foldersStore = writable([]);
const selectedFolderStore = writable('INBOX');
const actions = {
  loadMessages: vi.fn(),
  loadFolders: vi.fn(),
  invalidateFolderInMemCache: vi.fn(),
  updateFolderUnreadCounts: vi.fn(),
  resolveRealtimeFolder: vi.fn(async (_account, _mailbox, path) => path || 'INBOX'),
  removeRemoteMessages: vi.fn(async () => []),
  applyRemoteFlags: vi.fn(async () => []),
  applyRemoteLabels: vi.fn(async () => []),
  applyRemoteMailboxChange: vi.fn(async () => {}),
};
vi.mock('../../src/stores/mailboxStore', () => ({
  mailboxStore: {
    state: {
      messages: messagesStore,
      folders: foldersStore,
      selectedFolder: selectedFolderStore,
      searchActive: writable(false),
    },
    actions,
  },
}));
vi.mock('../../src/utils/websocket-manager.js', () => ({
  getWebSocketManager: () => ({
    reconcile: vi.fn(),
    reconnectAll: vi.fn(),
    on: (event, handler) => {
      if (!h.handlers.has(event)) h.handlers.set(event, []);
      h.handlers.get(event).push(handler);
      return vi.fn();
    },
    getClient: () => ({ connected: true }),
  }),
  destroyWebSocketManager: vi.fn(),
}));
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
    NEW_RELEASE: 'newRelease',
  },
  createReleaseWatcher: () => ({ on: vi.fn(), connect: vi.fn(), destroy: vi.fn() }),
}));

const { createInboxUpdater } = await import('../../src/utils/websocket-updater.js');

const emit = (event, data) => {
  for (const handler of h.handlers.get(event) || []) handler(data);
};

let updater;

beforeEach(() => {
  h.active = 'b@example.com';
  h.handlers.clear();
  h.dbFolders = [];
  for (const fn of Object.values(actions)) fn.mockClear();
  messagesStore.set([]);
  foldersStore.set([]);
  selectedFolderStore.set('INBOX');
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  updater = createInboxUpdater();
  updater.start();
});

afterEach(() => {
  updater.destroy();
  vi.useRealTimers();
});

describe('events during an account switch', () => {
  it("holds the new account's flag change until its list replaces the old one", async () => {
    // b is active, but a's list is still on screen
    messagesStore.set([{ id: 'a-1', account: 'a@example.com', folder: 'INBOX', uid: 7 }]);

    emit('flagsUpdated', {
      _account: 'b@example.com',
      path: 'INBOX',
      action: 'add',
      flags: ['\\Seen'],
      uids: [7],
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(actions.applyRemoteFlags).not.toHaveBeenCalled();

    messagesStore.set([{ id: 'b-1', account: 'b@example.com', folder: 'INBOX', uid: 3 }]);
    await vi.waitFor(() =>
      expect(actions.applyRemoteFlags).toHaveBeenCalledWith(
        expect.objectContaining({ account: 'b@example.com', uids: [7] }),
      ),
    );
  });

  it("applies another account's change to its cache right away", async () => {
    messagesStore.set([{ id: 'a-1', account: 'a@example.com', folder: 'INBOX', uid: 7 }]);
    h.active = 'a@example.com';
    emit('messagesExpunged', { _account: 'b@example.com', path: 'INBOX', uids: [7] });
    await vi.waitFor(() =>
      expect(actions.removeRemoteMessages).toHaveBeenCalledWith(
        expect.objectContaining({ account: 'b@example.com' }),
      ),
    );
  });

  it('keeps the order of held changes', async () => {
    messagesStore.set([{ id: 'a-1', account: 'a@example.com', folder: 'INBOX', uid: 7 }]);
    const flag = (action) => ({
      _account: 'b@example.com',
      notification_id: `n-${action}`,
      timestamp: action === 'add' ? '1' : '2',
      path: 'INBOX',
      action,
      flags: ['\\Seen'],
      uids: [7],
    });
    emit('flagsUpdated', flag('add'));
    emit('flagsUpdated', flag('remove'));
    messagesStore.set([]);

    await vi.waitFor(() => expect(actions.applyRemoteFlags).toHaveBeenCalledTimes(2));
    expect(actions.applyRemoteFlags.mock.calls.map(([change]) => change.action)).toEqual([
      'add',
      'remove',
    ]);
  });
});

describe('a folder renamed elsewhere', () => {
  it('renames the folders inside it too', async () => {
    foldersStore.set([
      { path: 'INBOX', delimiter: '/' },
      { path: 'Clients', delimiter: '/' },
      { path: 'Clients/Acme', delimiter: '/' },
      { path: 'Clients/Acme/2024', delimiter: '/' },
      { path: 'ClientsOld', delimiter: '/' },
    ]);

    emit('mailboxRenamed', { _account: 'b@example.com', oldPath: 'Clients', newPath: 'Customers' });

    await vi.waitFor(() => expect(actions.applyRemoteMailboxChange).toHaveBeenCalledTimes(3));
    expect(actions.applyRemoteMailboxChange.mock.calls.map(([change]) => change)).toEqual([
      { account: 'b@example.com', type: 'renamed', oldPath: 'Clients', newPath: 'Customers' },
      {
        account: 'b@example.com',
        type: 'renamed',
        oldPath: 'Clients/Acme',
        newPath: 'Customers/Acme',
      },
      {
        account: 'b@example.com',
        type: 'renamed',
        oldPath: 'Clients/Acme/2024',
        newPath: 'Customers/Acme/2024',
      },
    ]);
  });

  it("renames the folders inside it for another account from that account's cached folders", async () => {
    h.dbFolders = [
      { account: 'a@example.com', path: 'Work', delimiter: '.' },
      { account: 'a@example.com', path: 'Work.Q1', delimiter: '.' },
    ];

    emit('mailboxRenamed', { _account: 'a@example.com', oldPath: 'Work', newPath: 'Jobs' });

    await vi.waitFor(() =>
      expect(actions.applyRemoteMailboxChange).toHaveBeenCalledWith({
        account: 'a@example.com',
        type: 'renamed',
        oldPath: 'Work.Q1',
        newPath: 'Jobs.Q1',
      }),
    );
  });
});
