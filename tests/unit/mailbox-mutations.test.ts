/**
 * mailboxStore mutation tests — data-integrity paths.
 *
 * deleteMessage applies an OPTIMISTIC removal from the store + IDB, then syncs
 * to the server, and on failure queues a retry mutation. Getting this wrong
 * loses or resurrects mail. Pin the four branches: optimistic remove, online
 * success (no queue), offline (queue, no network), server-error (queue retry),
 * and the 404-as-success special case (no queue).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  online: true,
  remoteRequest: vi.fn().mockResolvedValue({}),
  queueMutation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  interceptDemoRequest: () => ({ handled: false }),
}));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => h.online }));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/mutation-queue', () => ({
  queueMutation: (...a: unknown[]) => h.queueMutation(...a),
  getQueuedMessageIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('../../src/utils/db', () => {
  const messagesChain = {
    delete: vi.fn().mockResolvedValue(undefined),
    modify: vi.fn().mockResolvedValue(undefined),
  };
  const bodiesChain = { delete: vi.fn().mockResolvedValue(undefined) };
  return {
    db: {
      messages: {
        where: () => ({ equals: () => messagesChain }),
        // deleteMessage snapshots the row (for a permanently-failed-mutation
        // revert) before the optimistic delete below — no existing row in
        // most of these tests, so null is the correct "nothing to snapshot"
        // case unless a test overrides it.
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
      messageBodies: {
        where: () => ({ equals: () => bodiesChain }),
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
      folders: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
      transaction: vi.fn().mockResolvedValue(undefined),
    },
  };
});
// shared boilerplate to make the store module importable
vi.mock('../../src/stores/mailboxActions', () => ({ selectedConversation: writable(null) }));
vi.mock('../../src/utils/auth', () => ({ getAuthHeader: vi.fn(() => 'auth') }));
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
vi.mock('../../src/utils/sync-helpers', () => ({
  getMessageApiId: (m: { id?: string; apiId?: string }) => m?.apiId ?? m?.id ?? null,
  normalizeMessageForCache: (m: unknown) => m,
}));
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

import { mailboxStore, getPendingDeleteIds } from '../../src/stores/mailboxStore';
import { messages, selectedMessage } from '../../src/stores/messageStore';
import { selectedFolder } from '../../src/stores/folderStore';
import { db } from '../../src/utils/db';

// A message already in Trash so deleteMessage takes the DELETE-API path
// (otherwise it delegates to a move-to-Trash).
const trashMsg = () => ({
  id: 'm1',
  apiId: 'api-1',
  account: 'me@test.com',
  folder: 'TRASH',
  is_unread: false,
});

beforeEach(() => {
  h.online = true;
  h.remoteRequest.mockReset().mockResolvedValue({});
  h.queueMutation.mockClear();
  messages.set([trashMsg(), { id: 'm2', account: 'me@test.com', folder: 'TRASH' }] as never);
  selectedMessage.set(trashMsg() as never);
});

// `messages` is a deferredWritable: when the array SHRINKS (a removal) the set
// is deferred to requestAnimationFrame (a macOS-WebKit use-after-free
// workaround), so flush one frame before reading it.
const flushRaf = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

describe('deleteMessage (permanent / already in Trash)', () => {
  it('optimistically removes the message and clears selection', async () => {
    await mailboxStore.actions.deleteMessage(trashMsg(), { permanent: true });
    await flushRaf();
    expect((get(messages) as Array<{ id: string }>).map((m) => m.id)).toEqual(['m2']);
    expect(get(selectedMessage)).toBeNull();
  });

  it('online success calls MessageDelete and does NOT queue', async () => {
    await mailboxStore.actions.deleteMessage(trashMsg(), { permanent: true });
    expect(h.remoteRequest).toHaveBeenCalledWith(
      'MessageDelete',
      {},
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(h.queueMutation).not.toHaveBeenCalled();
  });

  it('offline queues the delete and skips the network', async () => {
    h.online = false;
    await mailboxStore.actions.deleteMessage(trashMsg(), { permanent: true });
    expect(h.remoteRequest).not.toHaveBeenCalled();
    expect(h.queueMutation).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({ messageId: 'api-1', permanent: true }),
    );
  });

  it('a server error queues the delete for retry', async () => {
    h.remoteRequest.mockRejectedValue(Object.assign(new Error('500'), { status: 500 }));
    await mailboxStore.actions.deleteMessage(trashMsg(), { permanent: true });
    expect(h.queueMutation).toHaveBeenCalledWith('delete', expect.anything());
  });

  it('a 404 is treated as already-deleted (no queue)', async () => {
    h.remoteRequest.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    await mailboxStore.actions.deleteMessage(trashMsg(), { permanent: true });
    expect(h.remoteRequest).toHaveBeenCalled();
    expect(h.queueMutation).not.toHaveBeenCalled();
  });

  it('a server error queues a snapshot of the pre-delete row so a permanently failed mutation can restore it', async () => {
    const existingRow = { id: 'm1', account: 'me@test.com', folder: 'TRASH', subject: 'Hi' };
    (db.messages.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existingRow);
    h.remoteRequest.mockRejectedValue(Object.assign(new Error('500'), { status: 500 }));

    await mailboxStore.actions.deleteMessage(trashMsg(), { permanent: true });

    expect(h.queueMutation).toHaveBeenCalledWith(
      'delete',
      expect.objectContaining({ snapshot: existingRow, internalId: 'm1' }),
    );
  });
});

describe('revertFailedMutation', () => {
  const toastsMock = { show: vi.fn() };

  beforeEach(() => {
    toastsMock.show.mockClear();
    (db.messages.put as ReturnType<typeof vi.fn>).mockClear();
    (db.messages.get as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(null);
    (db.messages.where().equals().modify as ReturnType<typeof vi.fn>).mockClear();
    mailboxStore.actions.setToasts(toastsMock);
    selectedFolder.set('INBOX');
  });

  it('delete: restores the snapshotted row, un-suppresses the id, and toasts', async () => {
    const snapshot = { id: 'm1', account: 'me@test.com', folder: 'TRASH', subject: 'Hi' };
    mailboxStore.actions.addPendingDeletes(['m1']);
    expect(getPendingDeleteIds()).toContain('m1');

    await mailboxStore.actions.revertFailedMutation({
      type: 'delete',
      payload: { internalId: 'm1', subject: 'Hi', account: 'me@test.com', snapshot },
    });

    expect(db.messages.put).toHaveBeenCalledWith(snapshot);
    expect(getPendingDeleteIds()).not.toContain('m1');
    expect(toastsMock.show).toHaveBeenCalledWith(expect.stringContaining('"Hi"'), 'error');
  });

  it('delete: a bulk-failure entry with no snapshot still un-suppresses (nothing to restore, IDB was never touched)', async () => {
    mailboxStore.actions.addPendingDeletes(['m2']);

    await mailboxStore.actions.revertFailedMutation({
      type: 'delete',
      payload: { internalId: 'm2', subject: 'Bulk item', account: 'me@test.com', snapshot: null },
    });

    expect(db.messages.put).not.toHaveBeenCalled();
    expect(getPendingDeleteIds()).not.toContain('m2');
  });

  it('move: restores the row to sourceFolder when it still sits at targetFolder', async () => {
    // Not the currently viewed folder, so revertFailedMutation doesn't also
    // fire a live loadMessages() reload — this test only cares about the IDB
    // restore.
    selectedFolder.set('Somewhere else');
    const existing = { id: 'm3', account: 'me@test.com', folder: 'Archive', subject: 'Moved' };
    (db.messages.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existing);

    await mailboxStore.actions.revertFailedMutation({
      type: 'move',
      payload: {
        internalId: 'm3',
        subject: 'Moved',
        account: 'me@test.com',
        sourceFolder: 'INBOX',
        targetFolder: 'Archive',
      },
    });

    expect(db.messages.put).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm3', folder: 'INBOX' }),
    );
  });

  it('move: skips the restore when the row has since moved elsewhere (not stuck at targetFolder)', async () => {
    selectedFolder.set('Somewhere else');
    const existing = { id: 'm4', account: 'me@test.com', folder: 'Spam', subject: 'Reclassified' };
    (db.messages.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(existing);

    await mailboxStore.actions.revertFailedMutation({
      type: 'move',
      payload: {
        internalId: 'm4',
        subject: 'Reclassified',
        account: 'me@test.com',
        sourceFolder: 'INBOX',
        targetFolder: 'Archive',
      },
    });

    expect(db.messages.put).not.toHaveBeenCalled();
  });

  it('toggleRead: writes back the pre-toggle flags and patches the live row', async () => {
    // Shrinking the outer beforeEach's 2-item list to 1 defers through rAF
    // (deferredWritable) — flush before acting so the read below sees it.
    messages.set([
      { id: 'm5', account: 'me@test.com', folder: 'INBOX', is_unread: false, flags: ['\\Seen'] },
    ] as never);
    await flushRaf();

    await mailboxStore.actions.revertFailedMutation({
      type: 'toggleRead',
      payload: {
        internalId: 'm5',
        subject: 'Read toggle',
        account: 'me@test.com',
        isUnread: true,
        flags: [],
      },
    });

    expect(db.messages.where().equals().modify).toHaveBeenCalledWith(
      expect.objectContaining({ is_unread: true, is_unread_index: 1, flags: [] }),
    );
    const [restored] = get(messages) as Array<{ id: string; is_unread: boolean }>;
    expect(restored.is_unread).toBe(true);
  });

  it('label: writes back previousLabels', async () => {
    messages.set([
      { id: 'm6', account: 'me@test.com', folder: 'INBOX', labels: ['work'] },
    ] as never);
    await flushRaf();

    await mailboxStore.actions.revertFailedMutation({
      type: 'label',
      payload: {
        internalId: 'm6',
        subject: 'Labeled',
        account: 'me@test.com',
        labels: ['work'],
        previousLabels: [],
      },
    });

    expect(db.messages.where().equals().modify).toHaveBeenCalledWith(
      expect.objectContaining({ labels: [] }),
    );
    const [restored] = get(messages) as Array<{ id: string; labels: string[] }>;
    expect(restored.labels).toEqual([]);
  });
});
