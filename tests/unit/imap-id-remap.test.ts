/**
 * On an IMAP server a moved message gets a new id: the id names the folder
 * and the message's number in it. The cached row was already moved under its
 * old id, so it is renamed, or the next sync lists the message a second time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  remoteRequest: vi.fn().mockResolvedValue({}),
  sendSyncRequest: vi.fn(),
  backendReady: true,
  messages: new Map<string, Record<string, unknown>>(),
  bodies: new Map<string, Record<string, unknown>>(),
  indexed: vi.fn().mockResolvedValue(undefined),
  unindexed: vi.fn().mockResolvedValue(undefined),
  moveMessage: vi.fn(),
}));

vi.mock('../../src/backends', () => {
  const backend = {
    kind: 'imap',
    isReady: () => h.backendReady,
    moveMessage: (...a: unknown[]) => h.moveMessage(...a),
  };
  return { getMailBackend: () => backend, requireMailBackend: () => backend };
});
vi.mock('../../src/backends/imap-watch', () => ({ ensureInboxWatch: vi.fn(async () => {}) }));

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
  const table = (rows: Map<string, Record<string, unknown>>) => ({
    get: vi.fn(async ([, id]: [string, string]) => rows.get(id) ?? null),
    put: vi.fn(async (row: Record<string, unknown>) => {
      rows.set(String(row.id), row);
    }),
    bulkGet: vi.fn(async (keys: Array<[string, string]>) => keys.map(([, id]) => rows.get(id))),
    bulkPut: vi.fn(async (list: Array<Record<string, unknown>>) => {
      // The real table hands rows to a worker, which refuses what it cannot copy.
      for (const row of structuredClone(list)) rows.set(String(row.id), row);
    }),
    where: () => ({
      equals: ([, id]: [string, string]) => ({
        delete: vi.fn(async () => {
          rows.delete(id);
        }),
        toArray: async () => [],
        modify: vi.fn(),
      }),
    }),
  });
  return {
    db: {
      folders: table(new Map()),
      messages: table(h.messages),
      messageBodies: table(h.bodies),
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
vi.mock('../../src/utils/cache-manager', () => ({ cacheManager: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../src/utils/sync-settings', () => ({ getSyncSettings: vi.fn(() => ({})) }));
vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: () => ({ stage: vi.fn(), end: vi.fn() }),
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn(), log: vi.fn(), error: vi.fn() }));
vi.mock('../../src/stores/searchStore', () => ({
  searchStore: {
    actions: {
      indexMessages: (...a: unknown[]) => h.indexed(...a),
      removeFromIndex: (...a: unknown[]) => h.unindexed(...a),
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
import { imapMessageId } from '../../src/backends/imap-mapping';

const ME = 'me@example.org';
const inInbox = imapMessageId({ uidValidity: 7, uid: 12, folder: 'INBOX' });
const inArchive = imapMessageId({ uidValidity: 40, uid: 3, folder: 'Archive' });

// The row as the optimistic move left it: already in Archive, under the id
// it had in the inbox.
const movedRow = () => ({
  id: inInbox,
  account: ME,
  folder: 'Archive',
  uid: null,
  subject: 'Lease',
  from: 'Zoe <zoe@example.net>',
  flags: ['\\Seen'],
});

beforeEach(() => {
  h.messages.clear();
  h.bodies.clear();
  h.indexed.mockClear();
  h.unindexed.mockClear();
  h.moveMessage.mockReset();
  mailboxStore.state.messages.setImmediate([]);
  mailboxStore.state.selectedMessage.set(null);
});

describe('applyIdRemap', () => {
  it('renames the cached row, its body and its search entry', async () => {
    h.messages.set(inInbox, movedRow());
    h.bodies.set(inInbox, { id: inInbox, account: ME, folder: 'Archive', body: '<p>Signed.</p>' });

    await mailboxStore.actions.applyIdRemap(ME, { [inInbox]: inArchive });

    expect([...h.messages.keys()]).toEqual([inArchive]);
    expect(h.messages.get(inArchive)).toMatchObject({
      id: inArchive,
      uid: 3,
      folder: 'Archive',
      subject: 'Lease',
    });
    expect([...h.bodies.keys()]).toEqual([inArchive]);
    expect(h.bodies.get(inArchive)).toMatchObject({ id: inArchive, body: '<p>Signed.</p>' });
    expect(h.unindexed).toHaveBeenCalledWith([inInbox]);
    expect(h.indexed.mock.calls[0][0][0]).toMatchObject({ id: inArchive });
  });

  it('renames the row on screen and the open message', async () => {
    const other = {
      id: imapMessageId({ uidValidity: 40, uid: 2, folder: 'Archive' }),
      subject: 'Older',
    };
    mailboxStore.state.messages.setImmediate([movedRow(), other] as never);
    mailboxStore.state.selectedMessage.set(movedRow() as never);

    await mailboxStore.actions.applyIdRemap(ME, { [inInbox]: inArchive });

    const list = get(mailboxStore.state.messages) as Array<{ id: string; uid?: number }>;
    expect(list.map((m) => m.id)).toEqual([inArchive, other.id]);
    expect(list[0].uid).toBe(3);
    expect((get(mailboxStore.state.selectedMessage) as { id: string }).id).toBe(inArchive);
  });

  it('drops the old row when a sync already listed the message under its new id', async () => {
    const synced = {
      id: inArchive,
      account: ME,
      folder: 'Archive',
      uid: 3,
      subject: 'Lease',
      flags: [],
    };
    h.messages.set(inInbox, movedRow());
    h.messages.set(inArchive, synced);
    mailboxStore.state.messages.setImmediate([synced, movedRow()] as never);

    await mailboxStore.actions.applyIdRemap(ME, { [inInbox]: inArchive });

    expect([...h.messages.keys()]).toEqual([inArchive]);
    // The synced copy's flags are the newer ones.
    expect(h.messages.get(inArchive)?.flags).toEqual([]);
    // A list that gets shorter is applied on the next frame (deferred-store.ts).
    await vi.waitFor(() => expect((get(mailboxStore.state.messages) as unknown[]).length).toBe(1));
  });

  it('leaves the list of another account alone', async () => {
    mailboxStore.state.messages.setImmediate([movedRow()] as never);

    await mailboxStore.actions.applyIdRemap('someone@else.example', { [inInbox]: inArchive });

    expect((get(mailboxStore.state.messages) as Array<{ id: string }>)[0].id).toBe(inInbox);
  });

  it('does nothing for a server whose ids do not change', async () => {
    h.messages.set('66f1a0c2', { id: '66f1a0c2', account: ME, folder: 'Archive' });

    await mailboxStore.actions.applyIdRemap(ME, {});
    await mailboxStore.actions.applyIdRemap(ME, undefined);

    expect([...h.messages.keys()]).toEqual(['66f1a0c2']);
    expect(h.indexed).not.toHaveBeenCalled();
  });
});

// Dragging messages to a folder goes through the bulk move, which updates the
// cache after the server has answered.
describe('a bulk move on a server where the id changes', () => {
  it('leaves one row, in the new folder, under the new id', async () => {
    const cached = {
      id: inInbox,
      account: ME,
      folder: 'INBOX',
      uid: 12,
      subject: 'Lease',
      labels: ['work'],
    };
    h.messages.set(inInbox, cached);
    h.moveMessage.mockResolvedValue({ [inInbox]: inArchive });
    mailboxStore.state.messages.setImmediate([{ ...cached }] as never);

    const result = await mailboxStore.actions.bulkMoveMessages([{ ...cached }], 'Archive');

    expect(result).toEqual({ success: 1, failed: 0 });
    expect(h.moveMessage).toHaveBeenCalledWith(inInbox, 'Archive');
    // Not a second row left behind in the inbox under the old id.
    expect([...h.messages.keys()]).toEqual([inArchive]);
    expect(h.messages.get(inArchive)).toMatchObject({
      folder: 'Archive',
      uid: 3,
      labels: ['work'],
    });
  });

  it('can store a row that was never cached, taken from the list on screen', async () => {
    // The list hands over reactive objects; a Proxy stands in for one here.
    const onScreen = new Proxy(
      { id: inInbox, folder: 'INBOX', subject: 'Lease', labels: new Proxy(['work'], {}) },
      {},
    );
    h.moveMessage.mockResolvedValue({ [inInbox]: inArchive });

    const result = await mailboxStore.actions.bulkMoveMessages([onScreen], 'Archive');

    expect(result).toEqual({ success: 1, failed: 0 });
    expect([...h.messages.keys()]).toEqual([inArchive]);
  });
});
