/**
 * A list load that finishes after the view moved on must not leave the new view
 * settled on an empty list.
 *
 * loadMessages drops a response whose account or folder is no longer on screen,
 * then clears `loading` as a backstop when nothing newer is in flight. That
 * backstop assumed someone else would load the new view. On a cold launch over a
 * slow link nobody had yet: load() was still waiting on the network folder list,
 * so the inbox showed "Inbox Zero" over cached mail until that request returned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  activeEmail: 'a@test.com',
  remoteRequest: vi.fn(),
  cache: new Map<string, Record<string, unknown>[]>(),
  lastAccount: '',
}));

vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  isDemoBlockedError: () => false,
  interceptDemoRequest: () => ({ handled: false }),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => true }));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/mutation-queue', () => ({
  queueMutation: vi.fn().mockResolvedValue(undefined),
  getQueuedMessageIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('../../src/utils/db', () => {
  const rows = () => h.cache.get(h.lastAccount) || [];
  const ordered = {
    reverse: () => ordered,
    offset: () => ordered,
    limit: () => ordered,
    toArray: async () => rows(),
  };
  const equalsChain = {
    toArray: async () => rows(),
    count: async () => rows().length,
    delete: vi.fn().mockResolvedValue(undefined),
  };
  // The cache is read per account: remember which one the query named.
  const where = () => ({
    between: (lower: unknown[]) => {
      h.lastAccount = String(lower[0]);
      return ordered;
    },
    equals: (key: unknown[]) => {
      h.lastAccount = String(key[0]);
      return equalsChain;
    },
  });
  return {
    db: {
      messages: {
        where,
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
      transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
        const fn = args[args.length - 1] as () => Promise<void>;
        if (typeof fn === 'function') await fn();
      }),
    },
  };
});
vi.mock('../../src/stores/mailboxActions', () => ({ selectedConversation: writable(null) }));
vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: vi.fn(() => 'auth'),
  getAuthHeaderForAccount: vi.fn((email: string) => `auth:${email}`),
}));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => h.activeEmail), set: vi.fn(), remove: vi.fn() },
  Session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  Accounts: { getAll: () => [], getActive: () => null, setActive: vi.fn() },
}));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: vi.fn().mockRejectedValue(new Error('no worker')),
  onSyncTaskComplete: vi.fn(),
}));
vi.mock('../../src/utils/cache-manager', () => ({
  cacheManager: { checkQuotaAndEvict: vi.fn().mockResolvedValue(0) },
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
const { messages, loading } = await import('../../src/stores/messageStore');
const { folders, selectedFolder } = await import('../../src/stores/folderStore');

const cachedRow = (id: string, account: string) => ({
  id,
  account,
  folder: 'INBOX',
  subject: `Cached ${id}`,
  from: 'someone@elsewhere.test',
  date: Date.now(),
  flags: ['\\Seen'],
});

const serverList = (id: string) => ({
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
const flushRaf = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

beforeEach(() => {
  h.activeEmail = 'a@test.com';
  h.cache.clear();
  h.remoteRequest.mockReset();
  folders.set([{ path: 'INBOX', name: 'INBOX' }] as never);
  selectedFolder.set('INBOX');
  messages.set([] as never);
  loading.set(true);
  mailboxStore.actions.resetForAccount?.();
  mailboxStore.actions.clearFolderMessageCache?.();
});

describe('list load superseded by an account change', () => {
  it('loads the view now on screen instead of settling it empty', async () => {
    // The new account has mail cached locally; the old one has none, so its
    // load goes to the network and waits there.
    h.cache.set('b@test.com', [cachedRow('b-cached', 'b@test.com')]);
    let answerA!: (v: unknown) => void;
    h.remoteRequest.mockImplementation(
      (_action: string, _params: unknown, options: { authHeader?: string }) =>
        options.authHeader === 'auth:a@test.com'
          ? new Promise((resolve) => {
              answerA = resolve;
            })
          : new Promise(() => {}),
    );

    const pending = mailboxStore.actions.loadMessages();
    await vi.waitFor(() => expect(answerA).toBeTypeOf('function'));

    // The active account moves on, and nothing has loaded its list yet.
    h.activeEmail = 'b@test.com';
    answerA(serverList('a-1'));
    await pending;
    await vi.waitFor(() => expect(idsOnScreen()).toEqual(['b-cached']));
    await flushRaf();

    expect(get(loading)).toBe(false);
    expect(idsOnScreen()).not.toContain('a-1');
  });
});
