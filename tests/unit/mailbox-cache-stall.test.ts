/**
 * The message list must not wait on the local cache forever.
 *
 * After iOS suspends or kills the web process, IndexedDB can stop answering
 * without failing. loadMessages read the cache first and awaited it with no
 * deadline, so the inbox stayed on its loading skeleton and nothing loaded
 * (seen after switching accounts on iOS).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  activeEmail: 'a@test.com',
  remoteRequest: vi.fn(),
  cache: new Map<string, Record<string, unknown>[]>(),
  lastAccount: '',
  stall: false,
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
  const rows = () =>
    h.stall ? new Promise<never>(() => {}) : Promise.resolve(h.cache.get(h.lastAccount) || []);
  const ordered = {
    reverse: () => ordered,
    offset: () => ordered,
    limit: () => ordered,
    toArray: () => rows(),
  };
  const equalsChain = {
    toArray: () => rows(),
    count: () => rows().then((r) => r.length),
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

beforeEach(() => {
  h.activeEmail = 'a@test.com';
  h.cache.clear();
  h.stall = false;
  h.remoteRequest.mockReset();
  folders.set([{ path: 'INBOX', name: 'INBOX' }] as never);
  selectedFolder.set('INBOX');
  messages.set([] as never);
  loading.set(true);
  mailboxStore.actions.resetForAccount?.();
  mailboxStore.actions.clearFolderMessageCache?.();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('message list when the local cache stops answering', () => {
  it('falls back to the network instead of staying on the skeleton', async () => {
    // After iOS suspends or kills the web process, IndexedDB can stop
    // answering without failing. The list used to wait on it forever.
    vi.useFakeTimers();
    h.stall = true;
    h.remoteRequest.mockResolvedValue(serverList('net-1'));

    const pending = mailboxStore.actions.loadMessages();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    expect(idsOnScreen()).toEqual(['net-1']);
    expect(get(loading)).toBe(false);
  });

  it('reports whether a list load is in flight', async () => {
    let answer!: (v: unknown) => void;
    h.remoteRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const pending = mailboxStore.actions.loadMessages();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(mailboxStore.actions.hasInFlightMessageLoad()).toBe(true);
    answer(serverList('x-1'));
    await pending;
    expect(mailboxStore.actions.hasInFlightMessageLoad()).toBe(false);
  });
});
