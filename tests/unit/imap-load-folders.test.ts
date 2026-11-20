/**
 * An account on a custom IMAP server has no Forward Email auth header. Its
 * folders still have to load: the gate that keeps the sign-in page from
 * fetching folders must let through an account whose backend is ready.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  remoteRequest: vi.fn().mockResolvedValue({}),
  modified: [] as Array<[string, unknown, unknown]>,
  sendSyncRequest: vi.fn(),
  backendReady: true,
  changeFlags: vi.fn(),
  requestMessageList: vi.fn(),
}));

vi.mock('../../src/backends', () => {
  const backend = {
    kind: 'imap',
    isReady: () => h.backendReady,
    changeFlags: (...a: unknown[]) => h.changeFlags(...a),
    requestMessageList: (...a: unknown[]) => h.requestMessageList(...a),
  };
  return { getMailBackend: () => backend, requireMailBackend: () => backend };
});

vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
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
    bulkGet: vi.fn(async (keys: unknown[]) => keys.map(() => undefined)),
    bulkPut: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../../src/utils/auth', () => ({
  // An account on a custom IMAP server has no Forward Email header.
  getAuthHeader: vi.fn(() => ''),
  getAuthHeaderForAccount: vi.fn(() => ''),
}));
vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => 'me@example.org'), set: vi.fn(), remove: vi.fn() },
  Session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  Accounts: { getAll: () => [], getActive: () => null, setActive: vi.fn() },
}));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: (...a: unknown[]) => h.sendSyncRequest(...a),
  onSyncTaskComplete: vi.fn(),
}));
vi.mock('../../src/utils/cache-manager', () => ({
  cacheManager: {
    get: vi.fn(),
    set: vi.fn(),
    checkQuotaAndEvict: vi.fn().mockResolvedValue(undefined),
  },
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

import { mailboxStore } from '../../src/stores/mailboxStore';
import { folders } from '../../src/stores/folderStore';
import { queueMutation } from '../../src/utils/mutation-queue';

const serverFolders = [
  { id: 'INBOX', path: 'INBOX', name: 'INBOX', special_use: '\\Inbox', unseen_count: 2 },
  { id: 'Sent Mail', path: 'Sent Mail', name: 'Sent Mail', special_use: '\\Sent' },
  { id: 'Projects/2026', path: 'Projects/2026', name: '2026' },
];

beforeEach(() => {
  folders.set([] as never);
  mailboxStore.state.selectedFolder.set('');
  h.backendReady = true;
  h.sendSyncRequest.mockReset().mockResolvedValue({ folders: serverFolders });
  h.changeFlags.mockReset().mockResolvedValue(undefined);
  h.requestMessageList.mockReset().mockResolvedValue([]);
  vi.mocked(queueMutation).mockClear();
});

// The check for "can this account reach its server" used to be "does it have
// a Forward Email auth header". An IMAP account has none, so every message
// was put in the offline queue and sent later one at a time.
describe('marking a folder read for an account on a custom IMAP server', () => {
  const unread = (uid: number) => ({
    id: `imap-7-${uid}-SU5CT1g`,
    uid,
    folder: 'INBOX',
    subject: `Message ${uid}`,
    flags: [],
  });

  it('sends the change to the server now, all of it together', async () => {
    await mailboxStore.actions.loadFolders({ force: true });
    // The server's unread mail, then nothing left once it is marked.
    h.requestMessageList.mockResolvedValueOnce([unread(11), unread(12), unread(13)]);

    const result = await mailboxStore.actions.markFolderAsRead('INBOX');

    expect(result).toMatchObject({ success: true, count: 3 });
    expect(h.changeFlags.mock.calls.map(([id, change]) => [id, change.add])).toEqual([
      ['imap-7-11-SU5CT1g', ['\\Seen']],
      ['imap-7-12-SU5CT1g', ['\\Seen']],
      ['imap-7-13-SU5CT1g', ['\\Seen']],
    ]);
    expect(queueMutation).not.toHaveBeenCalled();
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });

  it('queues the change while the account is signed out of its server', async () => {
    h.backendReady = false;
    // A cached unread message is all it has to go on: the server is not asked.
    const { db } = await import('../../src/utils/db');
    const where = vi.spyOn(db.messages, 'where').mockReturnValueOnce({
      equals: () => ({ toArray: async () => [{ ...unread(11), is_unread: true }] }),
    } as never);

    await mailboxStore.actions.markFolderAsRead('INBOX');
    where.mockRestore();

    expect(h.changeFlags).not.toHaveBeenCalled();
    expect(h.requestMessageList).not.toHaveBeenCalled();
    expect(queueMutation).toHaveBeenCalledWith(
      'toggleRead',
      expect.objectContaining({ messageId: 'imap-7-11-SU5CT1g' }),
      { account: 'me@example.org' },
    );
  });
});

describe('loadFolders for an account on a custom IMAP server', () => {
  it('loads the folders and opens the inbox', async () => {
    await mailboxStore.actions.loadFolders({ force: true });

    expect(h.sendSyncRequest).toHaveBeenCalledWith('folders', { account: 'me@example.org' });
    const paths = (get(folders) as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['INBOX', 'Sent Mail', 'Projects/2026']));
    expect(get(mailboxStore.state.selectedFolder)).toBe('INBOX');
  });

  it('does not ask for folders when the account cannot reach its server', async () => {
    h.backendReady = false;

    await mailboxStore.actions.loadFolders({ force: true });

    expect(h.sendSyncRequest).not.toHaveBeenCalled();
    expect(get(folders)).toEqual([]);
  });
});
