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
  noContent: false,
  listRequests: [] as Array<Record<string, unknown>>,
  folderRequests: 0,
  holdNextList: null as null | ((release: () => void) => void),
  removeFromIndex: vi.fn(),
  search: vi.fn(),
  pageSize: 3,
  syncComplete: [] as Array<(data: Record<string, unknown>) => void>,
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
    request: async (action: string, params: Record<string, unknown> = {}) => {
      if (action === 'Folders') {
        h.folderRequests += 1;
        return [...h.folderTotals.entries()].map(([path, total]) => ({
          id: `id-${path}`,
          path,
          name: path,
          total,
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
      return null;
    },
  },
}));
vi.mock('../../src/utils/mutation-queue', () => ({
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
const { mailboxStore } = await import('../../src/stores/mailboxStore');
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
  h.noContent = false;
  h.listRequests = [];
  h.folderRequests = 0;
  h.holdNextList = null;
  h.pageSize = 3;
  h.removeFromIndex.mockReset();
  h.search.mockReset();
  await db.messages.clear();
  await db.messageBodies.clear();
  await db.folders.clear();
  mailboxStore.actions.resetForAccount();
  mailboxStore.actions.clearFolderMessageCache();
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
