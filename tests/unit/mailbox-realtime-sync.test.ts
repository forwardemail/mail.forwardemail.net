/**
 * Changes made by another client (Thunderbird, a phone) reach the webmail as
 * realtime events. These tests drive the real mailbox store against a real
 * IndexedDB (fake-indexeddb + Dexie, same indexes as production) and a fake
 * API, and check what the user would see: the list, the open reader, search
 * results, unread counts, and what stays cached.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  activeEmail: 'me@test.com',
  // folder -> server messages, newest first
  server: new Map<string, Record<string, unknown>[]>(),
  // folder path -> total reported by the folder list
  folderTotals: new Map<string, number>(),
  // folder path -> unseen_count reported by the folder list
  folderUnseen: new Map<string, number>(),
  folderAuth: [] as unknown[],
  noContent: false,
  listRequests: [] as Array<Record<string, unknown>>,
  folderRequests: 0,
  holdNextList: null as null | ((release: () => void) => void),
  removeFromIndex: vi.fn(),
  search: vi.fn(),
  pageSize: 3,
  syncComplete: [] as Array<(data: Record<string, unknown>) => void>,
  // message id -> request; ids in failWrites get a 500
  writes: [] as Array<{ action: string; id: string; body: Record<string, unknown> }>,
  failWrites: new Set<string>(),
  onWrite: null as null | ((id: string) => Promise<void> | void),
}));

vi.mock('../../src/utils/db', async () => {
  await import('fake-indexeddb/auto');
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('mailbox-realtime-sync-test');
  // Same indexes as the production schema (src/utils/db-engine.ts).
  db.version(1).stores({
    messages:
      '[account+id],account,folder,[account+folder],[account+folder+date],[account+folder+is_unread_index],from',
    messageBodies: '[account+id],account,[account+folder]',
    folders: '[account+path],account',
  });
  return { db };
});

vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  isDemoBlockedError: () => false,
  interceptDemoRequest: () => ({ handled: false }),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => true }));

const serverMessage = (folder: string, raw: Record<string, unknown>) => ({
  folder_path: folder,
  from: [{ address: 'sender@elsewhere.test', name: 'Sender' }],
  subject: `Subject ${raw.id}`,
  ...raw,
});

vi.mock('../../src/utils/remote', () => ({
  Remote: {
    request: async (
      action: string,
      params: Record<string, unknown> = {},
      options: Record<string, unknown> = {},
    ) => {
      if (action === 'Folders') {
        h.folderRequests += 1;
        h.folderAuth.push(options.authHeader);
        return [...h.folderTotals.entries()].map(([path, total]) => ({
          id: `id-${path}`,
          path,
          name: path,
          total,
          ...(h.folderUnseen.has(path) ? { unseen_count: h.folderUnseen.get(path) } : {}),
        }));
      }
      if (action === 'MessageList') {
        if (params.folder === 'Sent') return [];
        h.listRequests.push(params);
        if (h.holdNextList) {
          const hold = h.holdNextList;
          h.holdNextList = null;
          await new Promise<void>((resolve) => hold(resolve));
        }
        if (h.noContent) return null;
        let list = h.server.get(String(params.folder)) || [];
        if (params.is_unread) list = list.filter((m) => !(m.flags as string[]).includes('\\Seen'));
        const limit = Number(params.limit);
        const page = Number(params.page) || 1;
        return list
          .slice((page - 1) * limit, page * limit)
          .map((m) => serverMessage(String(params.folder), m));
      }
      if (action === 'MessageUpdate' || action === 'MessageDelete') {
        const id = decodeURIComponent(
          String(options.pathOverride || '')
            .split('/')
            .pop()
            ?.split('?')[0] || '',
        );
        h.writes.push({ action, id, body: params });
        if (h.onWrite) await h.onWrite(id);
        if (h.failWrites.has(id)) throw Object.assign(new Error('Server error'), { status: 500 });
        const added = (params.flags_add as string[] | undefined) || [];
        for (const list of h.server.values()) {
          for (const m of list) {
            if (m.id === id && added.length) {
              m.flags = [...new Set([...((m.flags as string[]) || []), ...added])];
            }
          }
        }
        return {};
      }
      return null;
    },
  },
}));
vi.mock('../../src/utils/mutation-queue', () => ({
  mutationQueueCount: { subscribe: () => () => {} },
  queueMutation: vi.fn().mockResolvedValue(undefined),
  getQueuedMessageIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('../../src/stores/mailboxActions', () => ({ selectedConversation: writable(null) }));
vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: vi.fn(() => 'auth'),
  getAuthHeaderForAccount: vi.fn((email: string) => `auth:${email}`),
}));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn((key: string) => (key === 'email' ? h.activeEmail : null)), set: vi.fn() },
  Session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  Accounts: { getAll: () => [], getActive: () => null, setActive: vi.fn() },
}));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: vi.fn().mockRejectedValue(new Error('no worker')),
  onSyncTaskComplete: (cb: (data: Record<string, unknown>) => void) => {
    h.syncComplete.push(cb);
  },
}));
vi.mock('../../src/utils/cache-manager', () => ({
  cacheManager: { checkQuotaAndEvict: vi.fn().mockResolvedValue(0) },
}));
vi.mock('../../src/utils/sync-settings', () => ({
  getSyncSettings: vi.fn(() => ({ pageSize: h.pageSize })),
}));
vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: () => ({ stage: vi.fn(), end: vi.fn() }),
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn(), log: vi.fn(), error: vi.fn() }));
vi.mock('../../src/utils/notification-manager.js', () => ({ setBadgeCount: vi.fn() }));
vi.mock('../../src/stores/searchStore', () => ({
  searchStore: {
    actions: {
      indexMessages: vi.fn().mockResolvedValue(undefined),
      removeFromIndex: (...args: unknown[]) => {
        h.removeFromIndex(...args);
        return Promise.resolve();
      },
      search: (...args: unknown[]) => h.search(...args),
      setIncludeBody: vi.fn(),
    },
  },
}));
vi.mock('../../src/stores/settingsStore', () => ({
  getEffectiveSettingValue: vi.fn(() => undefined),
  effectiveLayoutMode: writable('full'),
}));
vi.mock('../../src/stores/settingsRegistry', () => ({
  normalizeLayoutMode: (m: string) => m ?? 'full',
}));

const { db } = (await import('../../src/utils/db')) as unknown as {
  db: {
    messages: {
      clear: () => Promise<void>;
      bulkPut: (rows: unknown[]) => Promise<unknown>;
      get: (key: unknown) => Promise<Record<string, unknown> | undefined>;
      where: (index: string) => {
        equals: (key: unknown) => { toArray: () => Promise<Record<string, unknown>[]> };
      };
    };
    messageBodies: {
      clear: () => Promise<void>;
      bulkPut: (rows: unknown[]) => Promise<unknown>;
      get: (key: unknown) => Promise<Record<string, unknown> | undefined>;
    };
    folders: { clear: () => Promise<void>; bulkPut: (rows: unknown[]) => Promise<unknown> };
  };
};
const { mailboxStore, __resetUnreadTrackingForTests } =
  await import('../../src/stores/mailboxStore');
const { queueMutation } = (await import('../../src/utils/mutation-queue')) as unknown as {
  queueMutation: ReturnType<typeof vi.fn>;
};
const { messages, selectedMessage, searchResults, searchActive, page, filteredMessages } =
  await import('../../src/stores/messageStore');
const { folders, selectedFolder } = await import('../../src/stores/folderStore');
const { unreadOnly } = await import('../../src/stores/viewStore');

const ME = 'me@test.com';
const OTHER = 'other@test.com';

// Server message n in INBOX: id m<n>, uid n, newer for higher n.
const msg = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `m${n}`,
  uid: n,
  date: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  flags: ['\\Seen'],
  ...extra,
});
const cached = (
  n: number,
  account = ME,
  folder = 'INBOX',
  extra: Record<string, unknown> = {},
) => ({
  id: `m${n}`,
  uid: n,
  account,
  folder,
  subject: `Subject m${n}`,
  from: 'Sender <sender@elsewhere.test>',
  date: Date.UTC(2026, 0, 1, 0, n),
  dateMs: Date.UTC(2026, 0, 1, 0, n),
  flags: ['\\Seen'],
  is_unread: false,
  is_unread_index: 0,
  ...extra,
});

const flushRaf = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await flushRaf();
  }
};
const ids = (list: Array<{ id?: unknown }>) => list.map((m) => String(m.id));
const shownIds = () => ids(get(filteredMessages));
const cachedIds = async (account = ME, folder = 'INBOX') =>
  ids(await db.messages.where('[account+folder]').equals([account, folder]).toArray()).sort();

const setFolders = (list: Array<{ path: string; total?: number }>) => {
  folders.set(
    list.map((f) => ({
      id: `id-${f.path}`,
      path: f.path,
      name: f.path,
      count: 0,
      totalCount: f.total ?? null,
    })) as never,
  );
};

beforeEach(async () => {
  h.activeEmail = ME;
  h.server.clear();
  h.folderTotals.clear();
  h.folderUnseen.clear();
  h.folderAuth = [];
  h.noContent = false;
  h.listRequests = [];
  h.folderRequests = 0;
  h.holdNextList = null;
  h.pageSize = 3;
  h.writes = [];
  h.failWrites.clear();
  h.onWrite = null;
  queueMutation.mockClear();
  h.removeFromIndex.mockReset();
  h.search.mockReset();
  await db.messages.clear();
  await db.messageBodies.clear();
  await db.folders.clear();
  mailboxStore.actions.resetForAccount();
  mailboxStore.actions.clearFolderMessageCache();
  __resetUnreadTrackingForTests();
  unreadOnly.set(false);
  searchActive.set(false);
  searchResults.set([]);
  setFolders([{ path: 'INBOX' }, { path: 'Trash' }, { path: 'Work' }]);
  selectedFolder.set('INBOX');
  page.set(1);
  messages.setImmediate([]);
  selectedMessage.set(null);
  await settle();
});

describe('messages expunged elsewhere', () => {
  it('removes them from every loaded page, the cache, search and the open reader', async () => {
    // Two pages on screen, the open message is on the second.
    const rows = [6, 5, 4, 3, 2, 1].map((n) => cached(n));
    await db.messages.bulkPut(rows);
    await db.messageBodies.bulkPut([{ account: ME, id: 'm2', folder: 'INBOX', body: '<p>hi</p>' }]);
    messages.setImmediate(rows as never);
    selectedMessage.set(rows[4] as never);

    const removed = await mailboxStore.actions.removeRemoteMessages({
      account: ME,
      folder: 'INBOX',
      uids: [2, 5],
    });
    await settle();

    expect(removed.sort()).toEqual(['m2', 'm5']);
    expect(shownIds()).toEqual(['m6', 'm4', 'm3', 'm1']);
    expect(get(selectedMessage)).toBeNull();
    expect(await cachedIds()).toEqual(['m1', 'm3', 'm4', 'm6']);
    expect(await db.messageBodies.get([ME, 'm2'])).toBeUndefined();
    expect(h.removeFromIndex).toHaveBeenCalledWith(expect.arrayContaining(['m2', 'm5']));
  });

  it('does not touch messages with the same UID in another folder', async () => {
    await db.messages.bulkPut([cached(2), cached(2, ME, 'Work', { id: 'w2' })]);

    await mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'INBOX', uids: [2] });

    expect(await cachedIds(ME, 'INBOX')).toEqual([]);
    expect(await cachedIds(ME, 'Work')).toEqual(['w2']);
  });

  it('removes by message id when the folder is unknown', async () => {
    await db.messages.bulkPut([cached(1), cached(2)]);
    messages.setImmediate([cached(1), cached(2)] as never);

    await mailboxStore.actions.removeRemoteMessages({ account: ME, ids: ['m1'] });
    await settle();

    expect(shownIds()).toEqual(['m2']);
    expect(await cachedIds()).toEqual(['m2']);
  });

  it('drops a removed message from active search results', async () => {
    searchResults.set([cached(1), cached(2)] as never);
    searchActive.set(true);

    await mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'INBOX', uids: [1] });

    expect(ids(get(searchResults))).toEqual(['m2']);
  });

  it('keeps the cache of an account that is not on screen current, without touching the view', async () => {
    await db.messages.bulkPut([cached(1), cached(1, OTHER), cached(2, OTHER)]);
    messages.setImmediate([cached(1)] as never);

    await mailboxStore.actions.removeRemoteMessages({ account: OTHER, folder: 'INBOX', uids: [1] });
    await settle();

    expect(await cachedIds(OTHER)).toEqual(['m2']);
    expect(await cachedIds(ME)).toEqual(['m1']);
    expect(shownIds()).toEqual(['m1']);
  });
});

describe('flags changed elsewhere', () => {
  it('updates rows beyond the first page and in the cache', async () => {
    const rows = [6, 5, 4, 3, 2, 1].map((n) => cached(n));
    await db.messages.bulkPut(rows);
    messages.setImmediate(rows as never);

    await mailboxStore.actions.applyRemoteFlags({
      account: ME,
      folder: 'INBOX',
      uids: [1],
      action: 'remove',
      flags: ['\\Seen'],
    });

    const shown = get(messages).find((m) => m.id === 'm1');
    expect(shown?.is_unread).toBe(true);
    const row = await db.messages.get([ME, 'm1']);
    expect(row?.is_unread).toBe(true);
    expect(row?.is_unread_index).toBe(1);
    expect(row?.flags).toEqual([]);
  });

  it('hides a message flagged \\Deleted and leaves it out of the unread count', async () => {
    const rows = [
      cached(1, ME, 'INBOX', { flags: [], is_unread: true, is_unread_index: 1 }),
      cached(2),
    ];
    await db.messages.bulkPut(rows);
    messages.setImmediate(rows as never);

    await mailboxStore.actions.applyRemoteFlags({
      account: ME,
      folder: 'INBOX',
      uids: [1],
      action: 'add',
      flags: ['\\Deleted'],
    });
    await mailboxStore.actions.updateFolderUnreadCounts();

    expect(shownIds()).toEqual(['m2']);
    expect(get(folders).find((f) => f.path === 'INBOX')?.count).toBe(0);
  });

  it('wins over a pending local flag change for the same message', async () => {
    // A local "mark read" is pending; then another client marks it unread.
    h.server.set('INBOX', [msg(1, { flags: [] })]);
    await db.messages.bulkPut([cached(1)]);
    messages.setImmediate([cached(1)] as never);
    mailboxStore.actions.addPendingFlagMutation('m1', {
      is_unread: false,
      is_unread_index: 0,
      flags: ['\\Seen'],
    });

    await mailboxStore.actions.applyRemoteFlags({
      account: ME,
      folder: 'INBOX',
      uids: [1],
      action: 'remove',
      flags: ['\\Seen'],
    });
    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();

    expect(get(messages).find((m) => m.id === 'm1')?.is_unread).toBe(true);
  });

  it('patches labels the same way', async () => {
    await db.messages.bulkPut([cached(1, ME, 'INBOX', { labels: ['a'] })]);
    messages.setImmediate([cached(1, ME, 'INBOX', { labels: ['a'] })] as never);

    await mailboxStore.actions.applyRemoteLabels({
      account: ME,
      folder: 'INBOX',
      uids: [1],
      action: 'add',
      labels: ['b'],
    });

    expect(get(messages)[0].labels).toEqual(['a', 'b']);
    expect((await db.messages.get([ME, 'm1']))?.labels).toEqual(['a', 'b']);
  });
});

describe('refresh after a change elsewhere', () => {
  it('with several pages loaded, reloads the first page and keeps the rest', async () => {
    // Six messages, two pages of three on screen. m5 was deleted elsewhere
    // and m6 was marked unread.
    h.server.set('INBOX', [msg(6, { flags: [] }), msg(4), msg(3), msg(2), msg(1)]);
    h.folderTotals.set('INBOX', 5);
    const rows = [6, 5, 4, 3, 2, 1].map((n) => cached(n));
    await db.messages.bulkPut(rows);
    messages.setImmediate(rows as never);
    page.set(2);

    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();

    expect(h.listRequests.at(-1)).toMatchObject({ folder: 'INBOX', page: 1 });
    expect(shownIds()).toEqual(['m6', 'm4', 'm3', 'm2', 'm1']);
    expect(get(messages).find((m) => m.id === 'm6')?.is_unread).toBe(true);
    expect(get(page)).toBe(2);
    expect(await cachedIds()).not.toContain('m5');
  });

  it('clears the folder when its last message was deleted elsewhere', async () => {
    // The folder list still says one message; the server now lists none.
    setFolders([{ path: 'INBOX', total: 1 }]);
    h.folderTotals.set('INBOX', 0);
    h.server.set('INBOX', []);
    await db.messages.bulkPut([cached(1)]);
    messages.setImmediate([cached(1)] as never);
    selectedMessage.set(cached(1) as never);

    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();

    expect(shownIds()).toEqual([]);
    expect(get(selectedMessage)).toBeNull();
    expect(await cachedIds()).toEqual([]);
  });

  it('clears the folder when the server answers 204 for it', async () => {
    setFolders([{ path: 'INBOX', total: 1 }]);
    h.folderTotals.set('INBOX', 0);
    h.noContent = true;
    await db.messages.bulkPut([cached(1)]);
    messages.setImmediate([cached(1)] as never);

    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();

    expect(shownIds()).toEqual([]);
    expect(await cachedIds()).toEqual([]);
  });

  it('still keeps the list on an empty answer when the folder is not empty', async () => {
    h.folderTotals.set('INBOX', 1);
    h.server.set('INBOX', []);
    await db.messages.bulkPut([cached(1)]);
    messages.setImmediate([cached(1)] as never);

    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();

    expect(shownIds()).toEqual(['m1']);
  });

  it('runs again after a load that was already in flight', async () => {
    // Thunderbird stores \Deleted, then expunges a moment later: the second
    // event arrives while the reload for the first is still waiting.
    h.server.set('INBOX', [msg(2), msg(1)]);
    let release!: () => void;
    h.holdNextList = (r) => {
      release = r;
    };
    const first = mailboxStore.actions.loadMessages();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    h.server.set('INBOX', [msg(2)]);
    const second = mailboxStore.actions.loadMessages({ refresh: true });
    release();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(h.listRequests).toHaveLength(2));
    await settle();

    expect(shownIds()).toEqual(['m2']);
  });

  it('closes the reader when the open message is gone from the fresh page', async () => {
    h.server.set('INBOX', [msg(3), msg(1)]);
    h.folderTotals.set('INBOX', 2);
    const rows = [3, 2, 1].map((n) => cached(n));
    await db.messages.bulkPut(rows);
    messages.setImmediate(rows as never);
    selectedMessage.set(rows[1] as never);

    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();

    expect(get(selectedMessage)).toBeNull();
  });

  it('does not prune cached messages a filtered list leaves out', async () => {
    // Unread-only view: the server returns only m3; m1 and m2 are read, not
    // deleted, and must stay cached.
    h.server.set('INBOX', [msg(3, { flags: [] }), msg(2), msg(1)]);
    await db.messages.bulkPut([3, 2, 1].map((n) => cached(n)));
    unreadOnly.set(true);
    await settle();

    await mailboxStore.actions.loadMessages();
    await settle();

    expect(await cachedIds()).toEqual(['m1', 'm2', 'm3']);
    unreadOnly.set(false);
    await settle();
  });
});

describe('folders changed elsewhere', () => {
  it('follows a rename of the folder on screen and moves its cached messages', async () => {
    await db.messages.bulkPut([cached(1, ME, 'Work'), cached(2, ME, 'Work')]);
    selectedFolder.set('Work');
    messages.setImmediate([cached(1, ME, 'Work'), cached(2, ME, 'Work')] as never);

    await mailboxStore.actions.applyRemoteMailboxChange({
      account: ME,
      type: 'renamed',
      oldPath: 'Work',
      newPath: 'Projects',
    });
    await settle();

    expect(get(selectedFolder)).toBe('Projects');
    expect(shownIds()).toEqual(['m2', 'm1']);
    expect(await cachedIds(ME, 'Work')).toEqual([]);
    expect(await cachedIds(ME, 'Projects')).toEqual(['m1', 'm2']);
  });

  it('leaves a deleted folder on screen for the inbox and drops its cache', async () => {
    h.server.set('INBOX', [msg(9)]);
    await db.messages.bulkPut([cached(1, ME, 'Work')]);
    selectedFolder.set('Work');
    messages.setImmediate([cached(1, ME, 'Work')] as never);
    selectedMessage.set(cached(1, ME, 'Work') as never);

    await mailboxStore.actions.applyRemoteMailboxChange({
      account: ME,
      type: 'deleted',
      path: 'Work',
    });
    await settle();

    expect(get(selectedFolder)).toBe('INBOX');
    expect(get(selectedMessage)).toBeNull();
    expect(get(folders).map((f) => f.path)).not.toContain('Work');
    expect(await cachedIds(ME, 'Work')).toEqual([]);
  });

  it('fetches the folder list again when a change arrives during a fetch', async () => {
    h.folderTotals.set('INBOX', 0);
    const first = mailboxStore.actions.loadFolders({ force: true });
    h.folderTotals.set('Created', 0);
    await mailboxStore.actions.loadFolders({ force: true });
    await first;
    await vi.waitFor(() => expect(h.folderRequests).toBe(2));
    await vi.waitFor(() => expect(get(folders).map((f) => f.path)).toContain('Created'));
  });
});

describe('which cached rows an event may change', () => {
  const INBOX_ID = 'a'.repeat(24);

  it('does not resolve an unknown mailbox id by its path', async () => {
    // Another account's INBOX has its own id; its path is INBOX too.
    folders.set([{ id: INBOX_ID, path: 'INBOX', name: 'INBOX' }] as never);

    expect(await mailboxStore.actions.resolveRealtimeFolder(ME, INBOX_ID, 'INBOX')).toBe('INBOX');
    expect(await mailboxStore.actions.resolveRealtimeFolder(ME, 'b'.repeat(24), 'INBOX')).toBe('');
  });

  it('compares folder paths case-sensitively except INBOX', async () => {
    selectedFolder.set('Work');
    messages.setImmediate([cached(1, ME, 'Work')] as never);

    await mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'work', uids: [1] });
    await settle();

    expect(shownIds()).toEqual(['m1']);
  });

  it('drops the source UID on a local move, so the target UID names nothing here', async () => {
    await db.messages.bulkPut([cached(50)]);

    await mailboxStore.actions.moveMessage(cached(50), 'Work');
    await settle();
    expect((await db.messages.get([ME, 'm50']))?.uid).toBeNull();

    // Thunderbird expunges Work UID 50, a different message.
    await mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'Work', uids: [50] });
    expect(await cachedIds(ME, 'Work')).toEqual(['m50']);
  });

  it('leaves a row with a local move still pending alone', async () => {
    // The echo of a move undone here must not remove the restored row.
    await db.messages.bulkPut([cached(50)]);
    mailboxStore.actions.addPendingDeletes(['m50']);

    await mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'INBOX', uids: [50] });

    expect(await cachedIds()).toEqual(['m50']);
  });

  it('moves cached rows to the destination with their new UID', async () => {
    await db.messages.bulkPut([cached(5), cached(6)]);
    await db.messageBodies.bulkPut([{ account: ME, id: 'm5', folder: 'INBOX', body: 'x' }]);

    await mailboxStore.actions.removeRemoteMessages({
      account: ME,
      folder: 'INBOX',
      uids: [6, 5],
      destinationFolder: 'Trash',
      destinationUids: [106, 105],
    });

    expect(await cachedIds()).toEqual([]);
    expect(await db.messages.get([ME, 'm5'])).toMatchObject({ folder: 'Trash', uid: 105 });
    expect(await db.messages.get([ME, 'm6'])).toMatchObject({ folder: 'Trash', uid: 106 });
    expect((await db.messageBodies.get([ME, 'm5']))?.folder).toBe('Trash');
  });

  it('reads rows by id without reading the whole folder', async () => {
    await db.messages.bulkPut([cached(1), cached(2)]);
    const where = vi.spyOn(db.messages, 'where');

    await mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'INBOX', ids: ['m1'] });

    expect(where.mock.calls.filter(([index]) => index === '[account+folder]')).toHaveLength(0);
    expect(await cachedIds()).toEqual(['m2']);
    where.mockRestore();
  });

  it('reads a folder once for a burst of events', async () => {
    await db.messages.bulkPut([cached(1), cached(2), cached(3)]);
    const where = vi.spyOn(db.messages, 'where');

    await Promise.all([
      mailboxStore.actions.applyRemoteFlags({
        account: ME,
        folder: 'INBOX',
        uids: [1],
        action: 'add',
        flags: ['\\Deleted'],
      }),
      mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'INBOX', uids: [1, 2] }),
    ]);

    expect(where.mock.calls.filter(([index]) => index === '[account+folder]')).toHaveLength(1);
    expect(await cachedIds()).toEqual(['m3']);
    where.mockRestore();
  });

  it('keeps removed messages out when a page fetched before the removal arrives', async () => {
    h.server.set('INBOX', [msg(2), msg(1)]);
    await db.messages.bulkPut([cached(2), cached(1)]);

    await mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'INBOX', uids: [2] });
    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();

    expect(shownIds()).toEqual(['m1']);
    expect(await cachedIds()).toEqual(['m1']);
  });

  it('removes rows again that a sync wrote back from an older page', async () => {
    await db.messages.bulkPut([cached(2), cached(1)]);
    await mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'INBOX', uids: [2] });

    // The sync worker writes m2 back from a page fetched before the expunge.
    await db.messages.bulkPut([cached(2)]);
    for (const cb of h.syncComplete) cb({ taskType: 'backfill', folder: 'INBOX', account: ME });

    await vi.waitFor(async () => expect(await cachedIds()).toEqual(['m1']));
  });
});

describe('removal notes', () => {
  it('shows a message moved away and back again (delete, then undo)', async () => {
    // The server keeps the message id on a move; it returns to INBOX with
    // a new UID.
    await db.messages.bulkPut([cached(5)]);
    await mailboxStore.actions.removeRemoteMessages({
      account: ME,
      folder: 'INBOX',
      uids: [5],
      destinationFolder: 'Trash',
      destinationUids: [105],
      moved: true,
    });
    h.server.set('INBOX', [{ ...msg(5), uid: 9 }]);

    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();
    for (const cb of h.syncComplete) cb({ taskType: 'metadata', folder: 'INBOX', account: ME });
    await new Promise((r) => setTimeout(r, 50));

    expect(shownIds()).toEqual(['m5']);
    expect(await cachedIds()).toEqual(['m5']);
  });

  it('forgets a folder deleted and created again, whose UIDs start over', async () => {
    selectedFolder.set('Trash');
    await mailboxStore.actions.removeRemoteMessages({ account: ME, folder: 'Trash', uids: [1] });
    await mailboxStore.actions.applyRemoteMailboxChange({
      account: ME,
      type: 'created',
      path: 'Trash',
    });
    h.server.set('Trash', [{ ...msg(1), id: 'new-1' }]);

    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();

    expect(shownIds()).toEqual(['new-1']);
  });
});

describe('refresh of a filtered list', () => {
  it('keeps the reader open on a message that only stopped matching the filter', async () => {
    // Unread only: the open message was just read, so the server leaves it out.
    unreadOnly.set(true);
    await settle();
    const rows = [3, 2].map((n) => cached(n, ME, 'INBOX', { flags: [], is_unread: true }));
    messages.setImmediate(rows as never);
    selectedMessage.set(rows[0] as never);
    h.server.set('INBOX', [msg(3), msg(2, { flags: [] })]);

    await mailboxStore.actions.loadMessages({ refresh: true });
    await settle();

    expect(get(selectedMessage)?.id).toBe('m3');
    unreadOnly.set(false);
    await settle();
  });
});

describe('search while changes arrive', () => {
  it('re-runs the search without moving the selection', async () => {
    searchActive.set(true);
    searchResults.set([cached(1)] as never);
    selectedMessage.set(cached(1) as never);
    h.search.mockResolvedValue([cached(2), cached(1)]);
    mailboxStore.state.query.set('report');

    await mailboxStore.actions.refreshSearch();

    expect(ids(get(searchResults))).toEqual(['m2', 'm1']);
    expect(get(selectedMessage)?.id).toBe('m1');
  });

  it('re-runs the search once a sync of the folder on screen finishes', async () => {
    searchActive.set(true);
    searchResults.set([cached(1)] as never);
    h.search.mockResolvedValue([cached(3), cached(1)]);
    mailboxStore.state.query.set('report');

    for (const cb of h.syncComplete) cb({ taskType: 'metadata', folder: 'INBOX', account: ME });

    await vi.waitFor(() => expect(ids(get(searchResults))).toEqual(['m3', 'm1']));
  });
});

describe('unread counts and read state from another device', () => {
  const unread = { flags: [], is_unread: true, is_unread_index: 1 };
  const inboxCount = () => get(folders).find((f) => f.path === 'INBOX')?.count;
  const cachedUnread = async () =>
    ids(
      await db.messages
        .where('[account+folder+is_unread_index]')
        .equals([ME, 'INBOX', 1])
        .toArray(),
    ).sort();

  it('shows the server count and marks read what was read while this device was closed', async () => {
    // Six messages, all unread when this device last synced. Since then five
    // were read on another device; the server has one unread.
    h.server.set(
      'INBOX',
      [6, 5, 4, 3, 2, 1].map((n) => msg(n, n === 6 ? { flags: [] } : {})),
    );
    h.folderTotals.set('INBOX', 6);
    h.folderUnseen.set('INBOX', 1);
    const stale = [1, 2, 3, 4, 5, 6].map((n) => cached(n, ME, 'INBOX', unread));
    await db.messages.bulkPut(stale);
    messages.setImmediate(stale as never);

    await mailboxStore.actions.loadFolders({ force: true });

    await vi.waitFor(() => expect(inboxCount()).toBe(1));
    await vi.waitFor(async () => expect(await cachedUnread()).toEqual(['m6']));
    expect(
      get(messages)
        .filter((m) => m.is_unread)
        .map((m) => m.id),
    ).toEqual(['m6']);
    expect(h.listRequests.at(-1)).toMatchObject({ folder: 'INBOX', is_unread: true });
    expect(inboxCount()).toBe(1);
  });

  it('counts unread mail this device has not cached yet', async () => {
    // Three unread on the server; only the newest is cached here.
    h.server.set(
      'INBOX',
      [3, 2, 1].map((n) => msg(n, { flags: [] })),
    );
    h.folderTotals.set('INBOX', 3);
    h.folderUnseen.set('INBOX', 3);
    const row = cached(3, ME, 'INBOX', unread);
    await db.messages.bulkPut([row]);
    messages.setImmediate([row] as never);

    await mailboxStore.actions.loadFolders({ force: true });
    await vi.waitFor(() => expect(inboxCount()).toBe(3));

    // Reading it here takes the badge down at once.
    mailboxStore.actions.addPendingFlagMutation('m3', {
      is_unread: false,
      is_unread_index: 0,
      flags: ['\\Seen'],
    });
    await mailboxStore.actions.updateFolderUnreadCounts();
    expect(inboxCount()).toBe(2);

    // The request returns, and the next folder list counts the read. It is
    // not taken off a second time.
    mailboxStore.actions.settleUnreadChange('m3');
    h.folderUnseen.set('INBOX', 2);
    await new Promise((r) => setTimeout(r, 2));
    await mailboxStore.actions.loadFolders({ force: true });
    await vi.waitFor(() => expect(h.folderRequests).toBeGreaterThan(1));
    await mailboxStore.actions.updateFolderUnreadCounts();
    expect(inboxCount()).toBe(2);
  });

  it('keeps a read made here while its request is still out', async () => {
    h.folderTotals.set('INBOX', 5);
    h.folderUnseen.set('INBOX', 5);
    const row = cached(5, ME, 'INBOX', unread);
    await db.messages.bulkPut([row]);
    messages.setImmediate([row] as never);
    await mailboxStore.actions.loadFolders({ force: true });
    await vi.waitFor(() => expect(inboxCount()).toBe(5));

    mailboxStore.actions.addPendingFlagMutation('m5', {
      is_unread: false,
      is_unread_index: 0,
      flags: ['\\Seen'],
    });
    // A folder list fetched before the server has the read still says 5.
    await mailboxStore.actions.loadFolders({ force: true });
    await mailboxStore.actions.updateFolderUnreadCounts();
    expect(inboxCount()).toBe(4);
  });

  it('keeps the badge when sync caches older unread mail the server already counted', async () => {
    h.folderTotals.set('INBOX', 40);
    h.folderUnseen.set('INBOX', 30);
    await db.messages.bulkPut([cached(40, ME, 'INBOX', unread)]);
    await mailboxStore.actions.loadFolders({ force: true });
    await vi.waitFor(() => expect(inboxCount()).toBe(30));

    // Backfill writes ten older unread messages.
    await db.messages.bulkPut(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => cached(n, ME, 'INBOX', unread)),
    );
    await mailboxStore.actions.updateFolderUnreadCounts();

    expect(inboxCount()).toBe(30);
  });

  it('takes a moved unread message off one badge and onto the other', async () => {
    h.folderTotals.set('INBOX', 4);
    h.folderTotals.set('Archive', 10);
    h.folderUnseen.set('INBOX', 4);
    h.folderUnseen.set('Archive', 1);
    const row = cached(4, ME, 'INBOX', unread);
    await db.messages.bulkPut([row]);
    messages.setImmediate([row] as never);
    await mailboxStore.actions.loadFolders({ force: true });
    await vi.waitFor(() => expect(inboxCount()).toBe(4));

    await mailboxStore.actions.moveMessage(row, 'Archive');
    await mailboxStore.actions.updateFolderUnreadCounts();
    expect(inboxCount()).toBe(3);
    expect(get(folders).find((f) => f.path === 'Archive')?.count).toBe(2);
  });

  it('does not act on an unread listing that comes back without a list', async () => {
    h.server.set('INBOX', [msg(2, { flags: [] }), msg(1, { flags: [] })]);
    h.folderTotals.set('INBOX', 2);
    h.folderUnseen.set('INBOX', 1);
    h.noContent = true;
    await db.messages.bulkPut([cached(1, ME, 'INBOX', unread), cached(2, ME, 'INBOX', unread)]);

    await mailboxStore.actions.loadFolders({ force: true });
    await vi.waitFor(() => expect(h.listRequests.some((p) => p.is_unread)).toBe(true));
    await new Promise((r) => setTimeout(r, 20));

    expect(await cachedUnread()).toEqual(['m1', 'm2']);
  });

  it('does not act on an unread listing shorter than the count', async () => {
    // The server says three unread but the pages only held two: one moved
    // between pages while they were read. Neither m1 nor m4 may be marked
    // read, since either could be the one that was skipped.
    h.server.set('INBOX', [msg(3, { flags: [] }), msg(2, { flags: [] })]);
    h.folderTotals.set('INBOX', 4);
    h.folderUnseen.set('INBOX', 3);
    await db.messages.bulkPut([1, 2, 3, 4].map((n) => cached(n, ME, 'INBOX', unread)));

    await mailboxStore.actions.loadFolders({ force: true });
    await vi.waitFor(() => expect(h.listRequests.some((p) => p.is_unread)).toBe(true));
    await new Promise((r) => setTimeout(r, 20));

    expect(await cachedUnread()).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('leaves alone a message marked unread here while the server list was loading', async () => {
    h.server.set('INBOX', [msg(2), msg(1)]);
    h.folderTotals.set('INBOX', 2);
    h.folderUnseen.set('INBOX', 0);
    await db.messages.bulkPut([cached(1, ME, 'INBOX', unread), cached(2)]);

    let release = () => {};
    h.holdNextList = (r) => {
      release = r;
    };
    await mailboxStore.actions.loadFolders({ force: true });
    await vi.waitFor(() => expect(h.listRequests).toHaveLength(1));

    // The list the server is sending predates this.
    mailboxStore.actions.addPendingFlagMutation('m2', unread);
    await db.messages.bulkPut([cached(2, ME, 'INBOX', unread)]);
    release();

    await vi.waitFor(async () => expect(await cachedUnread()).toEqual(['m2']));
  });

  it("does not put one account's folders back after a switch to another", async () => {
    setFolders([{ path: 'INBOX', total: 5 }]);
    await db.messages.bulkPut([cached(1, ME, 'INBOX', unread)]);

    const counting = mailboxStore.actions.updateFolderUnreadCounts();
    h.activeEmail = OTHER;
    setFolders([{ path: 'INBOX', total: 9 }, { path: 'Receipts' }]);
    await counting;

    expect(get(folders).map((f) => f.path)).toEqual(['INBOX', 'Receipts']);
    expect(inboxCount()).toBe(0);
  });

  it('fetches the folder list with the credentials of the account it is for', async () => {
    h.folderTotals.set('INBOX', 0);
    await mailboxStore.actions.loadFolders({ force: true });
    expect(h.folderAuth).toEqual([`auth:${ME}`]);
  });
});

describe('mark a folder read', () => {
  const unread = { flags: [], is_unread: true, is_unread_index: 1 };

  it('marks read on the server the unread mail this device never cached', async () => {
    h.server.set(
      'INBOX',
      [3, 2, 1].map((n) => msg(n, { flags: [] })),
    );
    h.folderTotals.set('INBOX', 3);
    h.folderUnseen.set('INBOX', 3);
    await db.messages.bulkPut([cached(3, ME, 'INBOX', unread)]);
    await mailboxStore.actions.loadFolders({ force: true });

    const result = await mailboxStore.actions.markFolderAsRead('INBOX');

    expect(h.writes.map((w) => w.id).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(result).toMatchObject({ success: true, count: 3 });
    expect(get(folders).find((f) => f.path === 'INBOX')?.count).toBe(0);
  });

  it('queues a message the server would not mark, instead of dropping it', async () => {
    h.server.set('INBOX', [msg(2, { flags: [] }), msg(1, { flags: [] })]);
    h.folderTotals.set('INBOX', 2);
    h.folderUnseen.set('INBOX', 2);
    await db.messages.bulkPut([cached(2, ME, 'INBOX', unread), cached(1, ME, 'INBOX', unread)]);
    h.failWrites.add('m1');

    await mailboxStore.actions.markFolderAsRead('INBOX');

    expect(queueMutation).toHaveBeenCalledWith(
      'toggleRead',
      expect.objectContaining({ internalId: 'm1', isUnread: true }),
      { account: ME },
    );
  });

  it('keeps a move made while it ran', async () => {
    h.server.set('INBOX', [msg(2, { flags: [] }), msg(1, { flags: [] })]);
    h.folderTotals.set('INBOX', 2);
    h.folderUnseen.set('INBOX', 2);
    await db.messages.bulkPut([cached(2, ME, 'INBOX', unread), cached(1, ME, 'INBOX', unread)]);
    // m2 is moved to Work while the folder is being marked.
    h.onWrite = async (id) => {
      if (id !== 'm1') return;
      const row = await db.messages.get([ME, 'm2']);
      await db.messages.bulkPut([{ ...row, folder: 'Work' }]);
      const inbox = h.server.get('INBOX') || [];
      h.server.set(
        'INBOX',
        inbox.filter((m) => m.id !== 'm2'),
      );
      h.server.set('Work', [...inbox.filter((m) => m.id === 'm2')]);
    };

    await mailboxStore.actions.markFolderAsRead('INBOX');

    expect((await db.messages.get([ME, 'm2']))?.folder).toBe('Work');
    expect((await db.messages.get([ME, 'm1']))?.is_unread).toBe(false);
  });
});

describe('a change that failed for good', () => {
  it('puts back only the read state, keeping a star added after it', async () => {
    const row = cached(1, ME, 'INBOX', {
      flags: ['\\Seen', '\\Flagged'],
      is_unread: false,
      is_unread_index: 0,
      is_starred: true,
    });
    await db.messages.bulkPut([row]);
    messages.setImmediate([row] as never);

    await mailboxStore.actions.revertFailedMutation({
      type: 'toggleRead',
      payload: { internalId: 'm1', messageId: 'm1', isUnread: true, flags: [] },
    });

    const after = await db.messages.get([ME, 'm1']);
    expect(after).toMatchObject({ is_unread: true, is_starred: true, flags: ['\\Flagged'] });
    expect(get(messages)[0]).toMatchObject({ is_unread: true, flags: ['\\Flagged'] });
  });
});

describe('moves and deletes the server did not take', () => {
  it('moves the cached rows of a bulk move that was queued', async () => {
    const rows = [cached(1), cached(2)];
    await db.messages.bulkPut(rows);
    messages.setImmediate(rows as never);
    h.failWrites.add('m1');
    h.failWrites.add('m2');

    await mailboxStore.actions.bulkMoveMessages(rows, 'Work');

    expect((await db.messages.get([ME, 'm1']))?.folder).toBe('Work');
    expect((await db.messages.get([ME, 'm2']))?.folder).toBe('Work');
    expect(queueMutation).toHaveBeenCalledTimes(2);
  });

  it('removes the cached rows of a permanent bulk delete, keeping a snapshot to restore', async () => {
    const rows = [cached(1, ME, 'Trash'), cached(2, ME, 'Trash')];
    await db.messages.bulkPut(rows);
    h.failWrites.add('m2');

    await mailboxStore.actions.bulkDeleteMessages(rows, { permanent: true });

    expect(await db.messages.get([ME, 'm1'])).toBeUndefined();
    expect(await db.messages.get([ME, 'm2'])).toBeUndefined();
    expect(queueMutation).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({
        internalId: 'm2',
        snapshot: expect.objectContaining({ id: 'm2' }),
      }),
      { account: ME },
    );
  });
});
