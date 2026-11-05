/**
 * Opening a folder asks the sync controller to sync that folder next, for the
 * account on screen. Without it the folder waited behind every queued sync
 * task while the header said "Syncing" some other folder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  activeEmail: 'a@test.com',
  remoteRequest: vi.fn(),
  syncFolderOnDemand: vi.fn(),
}));

vi.mock('../../src/utils/sync-controller.js', () => ({
  syncFolderOnDemand: (...a: unknown[]) => h.syncFolderOnDemand(...a),
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
  mutationQueueCount: { subscribe: () => () => {} },
  queueMutation: vi.fn().mockResolvedValue(undefined),
  getQueuedMessageIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('../../src/utils/db', () => {
  const ordered = {
    reverse: () => ordered,
    offset: () => ordered,
    limit: () => ordered,
    toArray: async () => [],
  };
  const equalsChain = {
    toArray: async () => [],
    count: async () => 0,
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const where = () => ({ between: () => ordered, equals: () => equalsChain });
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
      transaction: vi.fn().mockResolvedValue(undefined),
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
const { folders } = await import('../../src/stores/folderStore');

afterEach(async () => {
  // loadMessages schedules a quota check with setTimeout(0); let it run.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('selectFolder', () => {
  it('syncs the opened folder next for the account on screen', async () => {
    folders.set([{ path: 'INBOX' }, { path: 'Work' }] as never);
    h.remoteRequest.mockImplementation(() => new Promise(() => {}));

    mailboxStore.actions.selectFolder('Work');

    await vi.waitFor(() =>
      expect(h.syncFolderOnDemand).toHaveBeenCalledWith('Work', 'a@test.com', { metadata: true }),
    );
  });
});
