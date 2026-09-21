/**
 * What must be forgotten when the active account changes.
 *
 * resetForAccount() clears the optimistic-mutation trackers so one account's
 * in-flight state cannot bleed into the next. The pending-INSERT tracker was
 * missing from that list, and it is the one that matters most: unlike the
 * delete and flag trackers, which hold ids and overrides, it holds a complete
 * message envelope and re-injects it into any Sent load for 60 seconds. Left
 * uncleared, a message just sent from account A appears inside account B's Sent
 * folder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  online: true,
  activeEmail: 'a@test.com',
  remoteRequest: vi.fn().mockResolvedValue({ Result: { List: [] } }),
  syncRequest: vi.fn().mockRejectedValue(new Error('no worker')),
  cachedMessages: [] as Record<string, unknown>[],
}));

vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  isDemoBlockedError: () => false,
  interceptDemoRequest: () => ({ handled: false }),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => h.online }));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/mutation-queue', () => ({
  queueMutation: vi.fn().mockResolvedValue(undefined),
  getQueuedMessageIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('../../src/utils/db', () => {
  const ordered = {
    reverse: () => ordered,
    offset: () => ordered,
    limit: () => ordered,
    toArray: async () => h.cachedMessages,
  };
  const equalsChain = {
    toArray: async () => h.cachedMessages,
    count: async () => h.cachedMessages.length,
    delete: vi.fn().mockResolvedValue(undefined),
    modify: vi.fn().mockResolvedValue(0),
  };
  return {
    db: {
      messages: {
        where: () => ({ between: () => ordered, equals: () => equalsChain }),
        put: vi.fn().mockResolvedValue(undefined),
        bulkPut: vi.fn().mockResolvedValue(undefined),
        bulkGet: vi.fn().mockResolvedValue([]),
        bulkDelete: vi.fn().mockResolvedValue(undefined),
      },
      messageBodies: {
        where: () => ({ equals: () => equalsChain }),
        bulkDelete: vi.fn().mockResolvedValue(undefined),
      },
      folders: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
      transaction: vi.fn(async (_mode: string, ..._args: unknown[]) => {
        const fn = _args[_args.length - 1] as () => Promise<void>;
        if (typeof fn === 'function') await fn();
      }),
    },
  };
});
vi.mock('../../src/stores/mailboxActions', () => ({ selectedConversation: writable(null) }));
vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: vi.fn(() => 'auth'),
  // Credentials keyed by the account a load was started for, not the active one.
  getAuthHeaderForAccount: vi.fn((email: string) => `auth:${email}`),
}));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => h.activeEmail), set: vi.fn(), remove: vi.fn() },
  Session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  Accounts: { getAll: () => [], getActive: () => null, setActive: vi.fn() },
}));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: (...a: unknown[]) => h.syncRequest(...a),
  onSyncTaskComplete: vi.fn(),
}));
vi.mock('../../src/utils/cache-manager', () => ({
  cacheManager: { get: vi.fn(), set: vi.fn(), checkQuotaAndEvict: vi.fn().mockResolvedValue(0) },
}));
vi.mock('../../src/utils/sync-settings', () => ({ getSyncSettings: vi.fn(() => ({})) }));
vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: () => ({ stage: vi.fn(), end: vi.fn() }),
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn(), log: vi.fn(), error: vi.fn() }));
vi.mock('../../src/stores/searchStore', () => ({
  searchStore: {
    actions: {
      indexMessages: vi.fn().mockResolvedValue(undefined),
      removeFromIndex: vi.fn().mockResolvedValue(undefined),
      setIncludeBody: vi.fn(),
    },
  },
}));
vi.mock('../../src/stores/settingsStore', () => ({
  getEffectiveSettingValue: vi.fn(() => undefined),
  effectiveLayoutMode: writable('list'),
}));
vi.mock('../../src/stores/settingsRegistry', () => ({
  normalizeLayoutMode: (m: string) => m ?? 'list',
}));

const { mailboxStore } = await import('../../src/stores/mailboxStore');
const { db } = await import('../../src/utils/db');
const { messages } = await import('../../src/stores/messageStore');
const { folders, selectedFolder } = await import('../../src/stores/folderStore');

// A Sent folder must exist for getSentFolderPath() to resolve, and it has to be
// the folder on screen for the tracker's re-injection to be observable.
const SENT = 'Sent';

const sentMessage = (id: string, account: string) => ({
  id,
  account,
  folder: SENT,
  subject: `Message ${id}`,
  from: account,
  date: Date.now(),
  dateMs: Date.now(),
  flags: ['\\Seen'],
});

// The server list must be NON-EMPTY for these assertions to mean anything. On
// an empty page-1 response loadMessages deliberately keeps whatever is already
// on screen (a guard against flaky backends returning [] for a full folder), so
// an empty response would leave the optimistic row in place for a reason that
// has nothing to do with the tracker under test.
const serverListWith = (id: string) => ({
  Result: {
    List: [
      {
        id,
        subject: `Server ${id}`,
        from: 'someone@elsewhere.test',
        date: new Date().toISOString(),
        flags: ['\\Seen'],
      },
    ],
  },
});

const idsOnScreen = () => get(messages).map((m: { id: string }) => String(m.id));

// `messages` is a deferredWritable: a set that SHRINKS the array is deferred to
// requestAnimationFrame, so a synchronous read after clearing still sees the
// old contents.
const flushRaf = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

beforeEach(() => {
  h.online = true;
  h.activeEmail = 'a@test.com';
  h.cachedMessages = [];
  h.remoteRequest.mockReset().mockResolvedValue({ Result: { List: [] } });
  h.syncRequest.mockReset().mockRejectedValue(new Error('no worker'));
  folders.set([{ path: SENT, name: SENT, specialUse: '\\Sent' }] as never);
  selectedFolder.set(SENT);
  messages.set([] as never);
  mailboxStore.actions.resetForAccount?.();
  mailboxStore.actions.clearFolderMessageCache?.();
});

describe('optimistic Sent insert across an account change', () => {
  it('keeps a just-sent message visible while its own account is active', async () => {
    // Baseline: this is the behaviour the tracker exists to provide. The server
    // list comes back WITHOUT the just-sent message (the indexer has not caught
    // up), and the tracker puts it back so the user does not watch their own
    // mail disappear from Sent.
    h.remoteRequest.mockResolvedValue(serverListWith('older-1'));

    const envelope = await mailboxStore.actions.applyOptimisticSentMessage(
      sentMessage('sent-1', 'a@test.com'),
    );
    expect(envelope?.id).toBe('sent-1');

    await mailboxStore.actions.loadMessages();
    await flushRaf();

    expect(idsOnScreen()).toContain('sent-1');
    expect(idsOnScreen()).toContain('older-1');
  });

  it('does not re-inject it into another account after resetForAccount', async () => {
    await mailboxStore.actions.applyOptimisticSentMessage(sentMessage('sent-1', 'a@test.com'));

    // The account switch: trackers reset, caches dropped, active account moves.
    mailboxStore.actions.resetForAccount?.();
    mailboxStore.actions.clearFolderMessageCache?.();
    h.activeEmail = 'b@test.com';
    messages.set([] as never);
    await flushRaf();

    // Account B's own Sent folder, with its own server response.
    h.remoteRequest.mockResolvedValue(serverListWith('b-1'));
    await mailboxStore.actions.loadMessages();
    await flushRaf();

    expect(idsOnScreen()).toEqual(['b-1']);
    expect(idsOnScreen()).not.toContain('sent-1');
  });
});

describe('main-thread message list fallback across an account change', () => {
  it('authenticates as the account the load was started for', async () => {
    // The race: the sync worker attempt is still pending (it can wait up to
    // 30s) when the user switches accounts, then it fails and loadMessages
    // falls back to a main-thread Remote.request. That request is built while
    // B is active, but it must authenticate as A, the account this load is
    // for, because its rows are cached under A.
    let failWorker!: (e: unknown) => void;
    h.syncRequest.mockImplementation(
      () =>
        new Promise((_, reject) => {
          failWorker = reject;
        }),
    );
    h.remoteRequest.mockResolvedValue(serverListWith('a-1'));

    const pending = mailboxStore.actions.loadMessages();
    await vi.waitFor(() => expect(h.syncRequest).toHaveBeenCalled());
    h.activeEmail = 'b@test.com';
    failWorker(new Error('no worker'));
    await pending;

    // Every list request this load makes (the page and any address-shape
    // retry) must carry A's credentials, never the now-active B's.
    expect(h.remoteRequest).toHaveBeenCalled();
    for (const call of h.remoteRequest.mock.calls) {
      const [, , options] = call as [string, unknown, { authHeader?: string }];
      expect(options.authHeader).toBe('auth:a@test.com');
    }
  });
});

describe('optimistic Sent copy sent as a different account', () => {
  it('is cached under the sender and kept off the active account screen', async () => {
    const put = (db.messages.put as unknown as { mock: { calls: unknown[][] } }).mock;
    put.calls.length = 0;

    const envelope = await mailboxStore.actions.applyOptimisticSentMessage(
      sentMessage('sent-b', 'b@test.com'),
      { account: 'b@test.com', sentFolder: SENT },
    );
    expect(envelope?.id).toBe('sent-b');

    await flushRaf();
    expect(idsOnScreen()).not.toContain('sent-b');
    expect(put.calls).toHaveLength(1);
    expect((put.calls[0][0] as { account: string }).account).toBe('b@test.com');

    // Nor may the tracker re-inject it into the active account's next load.
    h.remoteRequest.mockResolvedValue(serverListWith('a-1'));
    await mailboxStore.actions.loadMessages();
    await flushRaf();
    expect(idsOnScreen()).toEqual(['a-1']);
  });

  it('needs the sender-side Sent folder when the sender is not active', async () => {
    const envelope = await mailboxStore.actions.applyOptimisticSentMessage(
      sentMessage('sent-b', 'b@test.com'),
      { account: 'b@test.com' },
    );
    expect(envelope).toBeNull();
  });
});
