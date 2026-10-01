/**
 * Renaming a folder renames the folders inside it too: the server does that,
 * as IMAP requires ("Work/Clients" becomes "Jobs/Clients" when "Work" becomes
 * "Jobs"). The cached folders and messages of those subfolders move with it,
 * or they stay cached under paths that no longer exist.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  remoteRequest: vi.fn().mockResolvedValue({}),
  modified: [] as Array<[string, unknown, unknown]>,
}));

vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
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
  const table = (name: string) => ({
    where: () => ({
      equals: (key: unknown) => ({
        modify: vi.fn(async (changes: unknown) => {
          h.modified.push([name, key, changes]);
        }),
        toArray: async () => [],
        delete: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  });
  return {
    db: {
      folders: table('folders'),
      messages: table('messages'),
      messageBodies: table('messageBodies'),
      transaction: vi.fn().mockResolvedValue(undefined),
    },
  };
});
vi.mock('../../src/stores/mailboxActions', () => ({ selectedConversation: writable(null) }));
// no credentials: the folder reload after the rename stops right away
vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: vi.fn(() => null),
  getAuthHeaderForAccount: vi.fn(() => null),
}));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => 'me@test.com'), set: vi.fn(), remove: vi.fn() },
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

import { mailboxStore } from '../../src/stores/mailboxStore';
import { folders } from '../../src/stores/folderStore';

beforeEach(() => {
  h.modified.length = 0;
  h.remoteRequest.mockReset().mockResolvedValue({});
  folders.set([
    { id: 'f1', path: 'Work', name: 'Work' },
    { id: 'f2', path: 'Work/Clients', name: 'Clients' },
    { id: 'f3', path: 'Work/Clients/Acme', name: 'Acme' },
    { id: 'f4', path: 'Workshop', name: 'Workshop' },
  ] as never);
});

describe('renameFolder', () => {
  it('moves the cached subfolders and their messages with the folder', async () => {
    const result = await mailboxStore.actions.renameFolder('Work', 'Jobs');
    expect(result).toEqual({ success: true, newPath: 'Jobs' });

    expect(h.remoteRequest).toHaveBeenCalledWith(
      'FolderUpdate',
      { path: 'Jobs' },
      expect.objectContaining({ method: 'PUT', pathOverride: '/v1/folders/f1' }),
    );

    expect(h.modified.filter(([table]) => table === 'messages')).toEqual([
      ['messages', ['me@test.com', 'Work'], { folder: 'Jobs' }],
      ['messages', ['me@test.com', 'Work/Clients'], { folder: 'Jobs/Clients' }],
      ['messages', ['me@test.com', 'Work/Clients/Acme'], { folder: 'Jobs/Clients/Acme' }],
    ]);
    expect(h.modified.filter(([table]) => table === 'folders')).toEqual([
      ['folders', ['me@test.com', 'Work'], { path: 'Jobs', name: 'Jobs' }],
      ['folders', ['me@test.com', 'Work/Clients'], { path: 'Jobs/Clients' }],
      ['folders', ['me@test.com', 'Work/Clients/Acme'], { path: 'Jobs/Clients/Acme' }],
    ]);
  });
});
