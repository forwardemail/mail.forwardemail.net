/**
 * Account switching and signing out of one account, run against the real
 * account storage (storage.js) so the session-only and multi-account rules
 * are exercised end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const hoisted = vi.hoisted(() => ({
  tables: new Map<string, Array<Record<string, unknown>>>(),
  toastShow: vi.fn(),
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../../src/utils/mutation-queue', () => ({
  queueMutation: vi.fn().mockResolvedValue({}),
  initMutationQueue: vi.fn(),
  mutationQueueCount: writable(0),
  mutationQueueProcessing: writable(false),
  processMutationQueue: vi.fn(),
  getMutationQueueCount: vi.fn().mockResolvedValue(0),
  clearCompletedMutations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/utils/network-status', () => ({ isOnline: () => true }));

vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn(), log: vi.fn(), error: vi.fn() }));

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMacOS: false,
  isTauri: false,
  isTauriDesktop: false,
  isTauriMobile: false,
  swReadyWithTimeout: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/utils/push-notifications.js', () => ({
  syncPushNotifications: vi.fn().mockResolvedValue(undefined),
  initPushNotifications: vi.fn(),
  deregisterAccountPush: vi.fn().mockResolvedValue(true),
  cleanupPushNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/main', () => ({ cleanupCustomEventListeners: vi.fn() }));

vi.mock('../../src/utils/websocket-manager.js', () => ({
  getWebSocketManager: () => ({ removeAccount: vi.fn(), reconcile: vi.fn() }),
}));

vi.mock('../../src/utils/websocket-updater', () => ({
  createInboxUpdater: vi.fn(() => ({ start: vi.fn(), destroy: vi.fn() })),
}));

vi.mock('../../src/utils/sync-controller', () => ({
  startInitialSync: vi.fn(),
  queueBodiesForFolder: vi.fn(),
}));

vi.mock('../../src/utils/sync-worker-client.js', () => ({
  resetSyncWorkerReady: vi.fn(),
  revokeSyncWorkerAuth: vi.fn(),
}));

vi.mock('../../src/utils/download', () => ({ downloadFile: vi.fn() }));

vi.mock('../../src/utils/sw-cache.js', () => ({ clearAllSWCaches: vi.fn() }));
vi.mock('../../src/utils/db-recovery.js', () => ({ forceDeleteAllDatabases: vi.fn() }));
vi.mock('../../src/utils/db-worker-client.js', () => ({
  closeDatabase: vi.fn(),
  terminateDbWorker: vi.fn(),
}));

vi.mock('dexie', () => {
  class Dexie {
    static minKey = -Infinity;
    static maxKey = Infinity;
  }
  return { default: Dexie };
});

vi.mock('../../src/stores/mailboxStore', () => {
  const state = {
    folders: writable<unknown[]>([]),
    messages: writable<unknown[]>([]),
    loading: writable(false),
    error: writable<string | null>(null),
    selectedFolder: writable<string | null>(null),
    selectedMessage: writable<unknown>(null),
    messageBody: writable(''),
    attachments: writable<unknown[]>([]),
    page: writable(1),
    query: writable(''),
    searchResults: writable<unknown[]>([]),
    searchActive: writable(false),
    messageLoading: writable(false),
    hasNextPage: writable(false),
    unreadOnly: writable(false),
    hasAttachmentsOnly: writable(false),
    starredOnly: writable(false),
    selectedConversationIds: writable<string[]>([]),
    filterByLabel: writable<string[]>([]),
  };
  return {
    mailboxStore: {
      state,
      actions: {
        loadFolders: vi.fn().mockResolvedValue(undefined),
        hydrateFoldersFromCache: vi.fn().mockResolvedValue(false),
        loadMessages: vi.fn().mockResolvedValue(undefined),
        resetForAccount: vi.fn(),
        clearFolderMessageCache: vi.fn(),
        buildFolderList: (f: unknown) => f,
      },
    },
  };
});

vi.mock('../../src/stores/searchStore', () => ({
  searchStore: {
    actions: {
      setIncludeBody: vi.fn().mockResolvedValue(undefined),
      resetSearchConnection: vi.fn(),
      terminateWorker: vi.fn(),
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../src/stores/mailService', () => ({ clearMailServiceState: vi.fn() }));
vi.mock('../../src/stores/tabStore', () => ({ resetTabs: vi.fn() }));

vi.mock('../../src/stores/settingsStore', () => ({
  syncSettings: vi.fn().mockResolvedValue(undefined),
  clearSettings: vi.fn(),
  applySettings: vi.fn(),
  fetchLabels: vi.fn().mockResolvedValue([]),
  fetchLabelsWithSource: vi.fn().mockResolvedValue({ labels: [], authoritative: true }),
  settingsActions: { setBodyIndexing: vi.fn() },
  bodyIndexing: writable(false),
  loadProfileName: vi.fn(),
  loadProfileImage: vi.fn(),
  settingsLabels: writable<unknown[]>([]),
  fetchAccountData: vi.fn().mockResolvedValue({}),
  effectiveLayoutMode: writable('default'),
  setSettingValue: vi.fn().mockResolvedValue(undefined),
}));

// In-memory tables shaped like the db worker client.
vi.mock('../../src/utils/db', () => {
  const rows = (name: string) => {
    if (!hoisted.tables.has(name)) hoisted.tables.set(name, []);
    return hoisted.tables.get(name)!;
  };
  const keep = (name: string, predicate: (r: Record<string, unknown>) => boolean) =>
    hoisted.tables.set(name, rows(name).filter(predicate));
  const query = (name: string, match: (r: Record<string, unknown>) => boolean) => {
    const builder = {
      toArray: async () => rows(name).filter(match),
      delete: async () => keep(name, (r) => !match(r)),
      reverse: () => builder,
      limit: () => builder,
    };
    return builder;
  };
  const table = (name: string) => ({
    toArray: async () => [...rows(name)],
    get: async (key: unknown) => rows(name).find((r) => r.key === key || r.account === key),
    put: async (record: Record<string, unknown>) => {
      keep(name, (r) => r.key !== record.key);
      rows(name).push(record);
    },
    bulkPut: async () => {},
    bulkDelete: async (keys: unknown[]) => keep(name, (r) => !keys.includes(r.key)),
    where: (field: string) => ({
      equals: (value: unknown) =>
        query(name, (r) =>
          Array.isArray(value) ? false : (r as Record<string, unknown>)[field] === value,
        ),
      between: () => query(name, () => false),
      startsWith: (prefix: string) =>
        query(name, (r) => String((r as Record<string, unknown>)[field]).startsWith(prefix)),
    }),
  });
  const names = [
    'folders',
    'messages',
    'messageBodies',
    'searchIndex',
    'indexMeta',
    'drafts',
    'settings',
    'settingsLabels',
    'outbox',
    'labels',
    'syncManifests',
    'meta',
  ];
  const db: Record<string, unknown> = {
    transaction: async (_m: unknown, _t: unknown, cb: () => unknown) => cb(),
  };
  for (const name of names) db[name] = table(name);
  return { db };
});

import { Accounts, Local } from '../../src/utils/storage';
import {
  signOut,
  switchAccount,
  currentAccount,
  setToasts,
} from '../../src/stores/mailboxActions.ts';

const flushCooldown = () => new Promise((resolve) => setTimeout(resolve, 320));

const signInSessionOnly = (email: string) => {
  Accounts.add(email, { aliasAuth: `${email}:${email}-pw` }, false);
  Accounts.setActive(email);
  currentAccount.set(email);
};

beforeEach(async () => {
  await flushCooldown();
  localStorage.clear();
  sessionStorage.clear();
  hoisted.tables.clear();
  hoisted.toastShow.mockReset();
  setToasts({ show: hoisted.toastShow });
});

describe('signing out of one session-only account', () => {
  it('keeps the other session-only account in this tab signed in', async () => {
    signInSessionOnly('front-desk@example.com');
    signInSessionOnly('night-shift@example.com');
    hoisted.tables.set('folders', [
      { account: 'front-desk@example.com', path: 'INBOX' },
      { account: 'night-shift@example.com', path: 'INBOX' },
    ]);

    await signOut();

    expect(Accounts.getAll().map((a) => a.email)).toEqual(['front-desk@example.com']);
    expect(Local.get('email')).toBe('front-desk@example.com');
    expect(Local.get('alias_auth')).toBe('front-desk@example.com:front-desk@example.com-pw');
    // No last-account teardown.
    expect(localStorage.getItem('webmail_pending_idb_cleanup')).toBeNull();
    // The signed-out account's cache is gone, the remaining one's is not.
    expect(hoisted.tables.get('folders')).toEqual([
      { account: 'front-desk@example.com', path: 'INBOX' },
    ]);
  });
});

describe('switchAccount', () => {
  it('switches to an account stored with capitals when asked in lowercase', async () => {
    localStorage.setItem(
      'webmail_accounts',
      JSON.stringify([
        { email: 'first@example.com', aliasAuth: 'first@example.com:pw1' },
        { email: 'Alice.Smith@Example.com', aliasAuth: 'Alice.Smith@Example.com:pw2' },
      ]),
    );
    Accounts.setActive('first@example.com');
    currentAccount.set('first@example.com');

    await switchAccount('alice.smith@example.com');

    expect(get(currentAccount)).toBe('Alice.Smith@Example.com');
    expect(Local.get('alias_auth')).toBe('Alice.Smith@Example.com:pw2');
    expect(hoisted.toastShow).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to switch'),
      'error',
    );
  });

  it('ends on the last account requested in a quick burst', async () => {
    localStorage.setItem(
      'webmail_accounts',
      JSON.stringify([
        { email: 'home@example.com', aliasAuth: 'home@example.com:pw1' },
        { email: 'work@example.com', aliasAuth: 'work@example.com:pw2' },
      ]),
    );
    Accounts.setActive('home@example.com');
    currentAccount.set('home@example.com');

    // Work, back to home, then work again, all inside the 300ms cooldown.
    switchAccount('work@example.com');
    switchAccount('home@example.com');
    switchAccount('work@example.com');
    await flushCooldown();
    await vi.waitFor(() => expect(Local.get('email')).toBe('work@example.com'));

    expect(get(currentAccount)).toBe('work@example.com');
  });

  it('returns to the starting account when that was the last request', async () => {
    localStorage.setItem(
      'webmail_accounts',
      JSON.stringify([
        { email: 'home@example.com', aliasAuth: 'home@example.com:pw1' },
        { email: 'work@example.com', aliasAuth: 'work@example.com:pw2' },
      ]),
    );
    Accounts.setActive('home@example.com');
    currentAccount.set('home@example.com');

    switchAccount('work@example.com');
    switchAccount('home@example.com');
    await flushCooldown();
    await vi.waitFor(() => expect(Local.get('email')).toBe('home@example.com'));

    expect(get(currentAccount)).toBe('home@example.com');
  });
});
