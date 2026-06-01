/**
 * Regression guard: demo mode must stay IndexedDB-free.
 *
 * WebKitGTK (Tauri's Linux WebView) stalls IndexedDB under the tauri:// scheme,
 * so any awaited db op in a demo path can hang the UI — that's what kept the
 * Linux e2e red. The fix made the demo data paths operate purely on the
 * in-memory svelte stores. This test pins that invariant: with `db` spied so any
 * access is recorded, `markFolderAsRead` in demo mode must flip the rendered
 * messages WITHOUT touching `db.messages`. If a future change reintroduces a db
 * op in a demo path, this fails fast instead of Linux silently going flaky.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const dbAccess = vi.hoisted(() => ({ messageReads: 0, messageWrites: 0, transactions: 0 }));

// --- demo mode is ON for every test here ---
vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => true,
  interceptDemoRequest: () => ({ handled: false }),
}));

// --- db spy: record any message read/write/transaction so we can assert none ---
vi.mock('../../src/utils/db', () => {
  const messageQuery = {
    equals: () => ({
      toArray: () => {
        dbAccess.messageReads += 1;
        return Promise.resolve([]);
      },
      count: () => {
        dbAccess.messageReads += 1;
        return Promise.resolve(0);
      },
      modify: () => {
        dbAccess.messageWrites += 1;
        return Promise.resolve(0);
      },
    }),
    between: () => ({ reverse: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }) }),
  };
  const messages = {
    where: () => messageQuery,
    bulkPut: () => {
      dbAccess.messageWrites += 1;
      return Promise.resolve();
    },
    bulkDelete: () => {
      dbAccess.messageWrites += 1;
      return Promise.resolve();
    },
    toArray: () => {
      dbAccess.messageReads += 1;
      return Promise.resolve([]);
    },
  };
  return {
    db: {
      messages,
      messageBodies: { get: vi.fn(), delete: vi.fn(), bulkDelete: vi.fn() },
      folders: { where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }) },
      transaction: () => {
        dbAccess.transactions += 1;
        return Promise.resolve();
      },
    },
  };
});

// --- break the mailboxStore ↔ mailboxActions circular import cheaply ---
vi.mock('../../src/stores/mailboxActions', () => ({ selectedConversation: writable(null) }));

// --- heavy / side-effecting deps stubbed so the store module imports ---
vi.mock('../../src/utils/remote', () => ({ Remote: { request: vi.fn().mockResolvedValue({}) } }));
vi.mock('../../src/utils/auth', () => ({ getAuthHeader: vi.fn(() => 'auth') }));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => 'demo@forwardemail.net'), set: vi.fn(), remove: vi.fn() },
  Session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  Accounts: { getAll: () => [], getActive: () => null, setActive: vi.fn() },
}));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: vi.fn().mockRejectedValue(new Error('no worker')),
  onSyncTaskComplete: vi.fn(),
}));
vi.mock('../../src/utils/cache-manager', () => ({ cacheManager: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../src/utils/sync-settings', () => ({ getSyncSettings: vi.fn(() => ({})) }));
vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: () => ({ stage: vi.fn(), end: vi.fn() }),
}));
vi.mock('../../src/utils/mutation-queue', () => ({
  queueMutation: vi.fn(),
  getQueuedMessageIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => true }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn(), log: vi.fn(), error: vi.fn() }));
vi.mock('../../src/utils/sync-helpers', () => ({
  getMessageApiId: (m: { id?: string }) => m?.id ?? null,
  normalizeMessageForCache: (m: unknown) => m,
}));
vi.mock('../../src/stores/searchStore', () => ({
  searchStore: {
    actions: { indexMessages: vi.fn(), removeFromIndex: vi.fn(), setIncludeBody: vi.fn() },
  },
}));
vi.mock('../../src/stores/settingsStore', () => ({
  getEffectiveSettingValue: vi.fn(() => undefined),
  effectiveLayoutMode: writable('list'),
}));
vi.mock('../../src/stores/settingsRegistry', () => ({
  normalizeLayoutMode: (m: string) => m ?? 'list',
}));

import { mailboxStore } from '../../src/stores/mailboxStore';
import { messages } from '../../src/stores/messageStore';

describe('demo mode is IndexedDB-free', () => {
  beforeEach(() => {
    dbAccess.messageReads = 0;
    dbAccess.messageWrites = 0;
    dbAccess.transactions = 0;
  });

  it('markFolderAsRead flips the rendered rows without touching db.messages', async () => {
    messages.set([
      { account: 'demo@forwardemail.net', id: 'm1', folder: 'INBOX', is_unread: true, flags: [] },
      { account: 'demo@forwardemail.net', id: 'm2', folder: 'INBOX', is_unread: true, flags: [] },
      {
        account: 'demo@forwardemail.net',
        id: 'm3',
        folder: 'INBOX',
        is_unread: false,
        flags: ['\\Seen'],
      },
    ] as never);

    const result = await mailboxStore.actions.markFolderAsRead('INBOX');

    // Marked the two unread rows...
    expect(result).toMatchObject({ success: true, count: 2 });
    // ...purely in the store, with zero IndexedDB access.
    expect(dbAccess.messageReads).toBe(0);
    expect(dbAccess.messageWrites).toBe(0);
    expect(dbAccess.transactions).toBe(0);
    // ...and the rendered list reflects every message read.
    const after = get(messages) as Array<{ is_unread?: boolean }>;
    expect(after.every((m) => m.is_unread === false)).toBe(true);
  });

  it('updateFolderUnreadCounts is a no-op in demo (no db count queries)', async () => {
    await mailboxStore.actions.updateFolderUnreadCounts();
    expect(dbAccess.messageReads).toBe(0);
  });
});
