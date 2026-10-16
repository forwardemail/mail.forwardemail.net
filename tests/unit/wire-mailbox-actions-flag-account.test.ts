/**
 * Read, star and label changes from src/stores/mailboxActions.ts against the
 * real offline queue (src/utils/mutation-queue.js, kept in an in-memory meta
 * table here). A change belongs to the account it was made in: it is sent and
 * queued as that account even when the user switches accounts mid-flight, a
 * direct change replaces one to the same message still waiting in the queue,
 * and a read change the server took stops counting in the unread badge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  meta: new Map<string, { key: string; value: unknown; updatedAt: number }>(),
  active: 'alice@example.com' as string | null,
  online: true,
  request: vi.fn(),
  accounts: [] as Array<{ email: string; aliasAuth?: string }>,
  credentials: new Map<string, string>(),
  onModify: null as null | (() => void),
  settleUnreadChange: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: (key: string) => (key === 'email' ? h.active : null),
    set: vi.fn(),
    remove: vi.fn(),
  },
  Session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  Accounts: {
    getAll: () => h.accounts,
    setActive: vi.fn(() => true),
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args: unknown[]) => h.request(...args) },
}));

// Each signed-in account has its own alias credentials; a locked or signed
// out account has none.
vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: () => h.credentials.get(h.active || '') || '',
  getAuthHeaderForAccount: (account: string) => h.credentials.get(account) || '',
}));

vi.mock('../../src/utils/network-status', () => ({ isOnline: () => h.online }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn(), log: vi.fn(), error: vi.fn() }));
vi.mock('../../src/utils/platform.js', () => ({
  isTauriMacOS: false,
  isTauri: false,
  isTauriDesktop: false,
  isTauriMobile: false,
  swReadyWithTimeout: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/utils/push-notifications.js', () => ({
  syncPushNotifications: vi.fn(),
  initPushNotifications: vi.fn(),
  deregisterAccountPush: vi.fn().mockResolvedValue(true),
  cleanupPushNotifications: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/utils/download', () => ({ downloadFile: vi.fn() }));
vi.mock('../../src/utils/sync-controller', () => ({
  startInitialSync: vi.fn(),
  queueBodiesForFolder: vi.fn(),
}));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  resetSyncWorkerReady: vi.fn(),
  revokeSyncWorkerAuth: vi.fn(),
}));
vi.mock('../../src/utils/websocket-updater', () => ({
  createInboxUpdater: vi.fn(() => ({ start: vi.fn(), destroy: vi.fn() })),
}));
vi.mock('../../src/utils/search-body-indexing.js', () => ({
  resolveSearchBodyIndexing: () => false,
}));
vi.mock('../../src/utils/i18n', () => ({ i18n: { getFormattingLocale: () => 'en-US' } }));
vi.mock('../../src/config', () => ({ config: { apiBase: 'https://api.test' } }));
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
    messages: writable<Array<Record<string, unknown>>>([]),
    selectedFolder: writable<string | null>('INBOX'),
    selectedMessage: writable<Record<string, unknown> | null>(null),
    starredOnly: writable(false),
    selectedConversationIds: writable<string[]>([]),
  };
  return {
    mailboxStore: {
      state,
      actions: {
        addPendingFlagMutation: vi.fn(),
        updateFolderUnreadCounts: vi.fn(),
        invalidateFolderInMemCache: vi.fn(),
        settleUnreadChange: (...args: unknown[]) => h.settleUnreadChange(...args),
      },
    },
  };
});
vi.mock('../../src/stores/searchStore', () => ({
  searchStore: { actions: { indexMessages: vi.fn().mockResolvedValue(undefined) } },
}));
vi.mock('../../src/stores/mailService', () => ({ clearMailServiceState: vi.fn() }));
vi.mock('../../src/stores/tabStore', () => ({ resetTabs: vi.fn() }));
vi.mock('../../src/stores/settingsStore', () => ({
  syncSettings: vi.fn(),
  clearSettings: vi.fn(),
  applySettings: vi.fn(),
  createLabel: vi.fn(),
  updateLabel: vi.fn(),
  deleteLabel: vi.fn(),
  settingsActions: {},
  bodyIndexing: writable(false),
  loadProfileName: vi.fn(),
  loadProfileImage: vi.fn(),
  settingsLabels: writable([]),
  fetchLabelsWithSource: vi.fn(),
  fetchAccountData: vi.fn(),
  effectiveLayoutMode: writable('default'),
  setSettingValue: vi.fn(),
  getEffectiveSettingValue: vi.fn(),
}));

// The optimistic IDB write is the first thing the actions wait on, so a
// switch landing there happens while the change is in flight.
vi.mock('../../src/utils/db', () => {
  const where = () => ({
    equals: () => ({
      modify: async () => {
        h.onModify?.();
      },
    }),
  });
  return {
    db: {
      messages: { where },
      meta: {
        get: async (key: string) => h.meta.get(key) ?? null,
        put: async (record: { key: string; value: unknown; updatedAt: number }) => {
          h.meta.set(record.key, structuredClone(record));
        },
      },
    },
  };
});

import { toggleRead, toggleStar, contextLabel } from '../../src/stores/mailboxActions';
import { mailboxStore } from '../../src/stores/mailboxStore';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const ALICE_AUTH = `Basic ${Buffer.from(`${ALICE}:alice-alias-pass`).toString('base64')}`;
const BOB_AUTH = `Basic ${Buffer.from(`${BOB}:bob-alias-pass`).toString('base64')}`;

const queued = (account: string) =>
  (h.meta.get(`mutation_queue_${account}`)?.value ?? []) as Array<{
    type: string;
    authHeader: string;
    payload: Record<string, unknown>;
  }>;

const inboxMessage = (overrides: Record<string, unknown> = {}) => ({
  id: '66f1c0ffee5ad1e000a1b2c3',
  uid: 4182,
  subject: 'Quarterly invoice',
  folder: 'INBOX',
  is_unread: true,
  is_starred: false,
  flags: [] as string[],
  labels: [] as string[],
  ...overrides,
});

const httpError = (status: number, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { status });

const switchTo = (account: string) => {
  h.active = account;
};

beforeEach(() => {
  h.meta.clear();
  h.active = ALICE;
  h.online = true;
  h.onModify = null;
  h.accounts = [{ email: ALICE }, { email: BOB }];
  h.credentials = new Map([
    [ALICE, ALICE_AUTH],
    [BOB, BOB_AUTH],
  ]);
  h.request.mockReset().mockResolvedValue({});
  h.settleUnreadChange.mockReset();
  mailboxStore.state.messages.set([]);
  mailboxStore.state.selectedMessage.set(null);
});

describe('a change made offline, then again once back online', () => {
  it('drops the queued read change so it cannot undo the newer one', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);

    h.online = false;
    await toggleRead(msg); // marked read while offline
    expect(queued(ALICE).map((m) => m.type)).toEqual(['toggleRead']);

    h.online = true;
    const nowRead = inboxMessage({ is_unread: false, flags: ['\\Seen'] });
    mailboxStore.state.messages.set([nowRead]);
    await toggleRead(nowRead); // marked unread again before the queue ran

    expect(h.request).toHaveBeenCalledTimes(1);
    const [, body, options] = h.request.mock.calls[0];
    expect(body).toEqual({ flags: [], flags_remove: ['\\Seen'] });
    expect(options.authHeader).toBe(ALICE_AUTH);
    // Sending the queued "mark read" after this would leave it read
    expect(queued(ALICE)).toEqual([]);
  });

  it('drops the queued star change', async () => {
    const msg = inboxMessage({ is_unread: false, flags: ['\\Seen'] });
    mailboxStore.state.messages.set([msg]);

    h.online = false;
    await toggleStar(msg);
    expect(queued(ALICE).map((m) => m.type)).toEqual(['toggleStar']);

    h.online = true;
    const starred = { ...msg, is_starred: true, flags: ['\\Seen', '\\Flagged'] };
    mailboxStore.state.messages.set([starred]);
    await toggleStar(starred);

    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][1]).toEqual({
      flags: ['\\Seen'],
      flags_remove: ['\\Flagged'],
    });
    expect(queued(ALICE)).toEqual([]);
  });

  it('drops the queued label change but keeps queued changes of another kind', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);

    h.online = false;
    await toggleRead(msg);
    await contextLabel(msg, 'Receipts', { action: 'add', silent: true });
    expect(queued(ALICE).map((m) => m.type)).toEqual(['toggleRead', 'label']);

    h.online = true;
    await contextLabel({ ...msg, labels: ['receipts'] }, 'Receipts', {
      action: 'remove',
      silent: true,
    });

    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][1]).toEqual({ labels: [], labels_remove: ['receipts'] });
    expect(h.request.mock.calls[0][2].authHeader).toBe(ALICE_AUTH);
    expect(queued(ALICE).map((m) => m.type)).toEqual(['toggleRead']);
  });
});

describe('a change in flight when the user switches accounts', () => {
  it('is queued offline under the account it was made in, with its credentials', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);
    h.online = false;
    h.onModify = () => switchTo(BOB);

    await toggleRead(msg);

    expect(queued(BOB)).toEqual([]);
    const [entry] = queued(ALICE);
    expect(entry.type).toBe('toggleRead');
    expect(entry.authHeader).toBe(ALICE_AUTH);
    expect(entry.payload.account).toBe(ALICE);
    expect(entry.payload.messageId).toBe('66f1c0ffee5ad1e000a1b2c3');
  });

  it('is sent as the account it was made in', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);
    h.onModify = () => switchTo(BOB);

    await toggleStar(msg);

    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][2]).toMatchObject({
      method: 'PUT',
      pathOverride: '/v1/messages/66f1c0ffee5ad1e000a1b2c3',
      authHeader: ALICE_AUTH,
    });
  });

  it('is queued for retry under its own account when the request fails', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);
    h.onModify = () => switchTo(BOB);
    h.request.mockRejectedValueOnce(httpError(503));

    await toggleRead(msg);

    expect(queued(BOB)).toEqual([]);
    expect(queued(ALICE).map((m) => [m.type, m.authHeader])).toEqual([['toggleRead', ALICE_AUTH]]);
  });

  it('queues a label change under its own account', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);
    h.online = false;
    h.onModify = () => switchTo(BOB);

    await contextLabel(msg, 'Receipts', { action: 'add', silent: true });

    expect(queued(BOB)).toEqual([]);
    expect(queued(ALICE).map((m) => [m.type, m.authHeader, m.payload.labels])).toEqual([
      ['label', ALICE_AUTH, ['receipts']],
    ]);
  });

  it('is queued rather than sent when its account has no usable credentials', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);
    h.onModify = () => {
      switchTo(BOB);
      // Alice's stored credential is unreadable right now (locked vault)
      h.credentials.delete(ALICE);
    };

    await toggleRead(msg);

    expect(h.request).not.toHaveBeenCalled();
    expect(queued(ALICE).map((m) => m.type)).toEqual(['toggleRead']);
    expect(queued(BOB)).toEqual([]);
    expect(h.settleUnreadChange).not.toHaveBeenCalled();
  });
});

describe('the unread badge after a read change', () => {
  it('stops counting the local change once the server has it', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);

    await toggleRead(msg);

    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.settleUnreadChange).toHaveBeenCalledWith('66f1c0ffee5ad1e000a1b2c3', ALICE);
  });

  it('settles for the account the change was made in after a switch', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);
    h.onModify = () => switchTo(BOB);

    await toggleRead(msg);

    expect(h.settleUnreadChange).toHaveBeenCalledWith('66f1c0ffee5ad1e000a1b2c3', ALICE);
  });

  it('settles when the server no longer has the message, and does not queue it', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);
    h.request.mockRejectedValueOnce(httpError(404, 'Message does not exist'));

    await toggleRead(msg);

    expect(h.settleUnreadChange).toHaveBeenCalledWith('66f1c0ffee5ad1e000a1b2c3', ALICE);
    expect(queued(ALICE)).toEqual([]);
  });

  it('keeps counting it while the change is still queued', async () => {
    const msg = inboxMessage();
    mailboxStore.state.messages.set([msg]);
    h.request.mockRejectedValueOnce(httpError(503));

    await toggleRead(msg);

    expect(h.settleUnreadChange).not.toHaveBeenCalled();
    expect(queued(ALICE).map((m) => m.type)).toEqual(['toggleRead']);
  });
});
