/**
 * draft-service unit tests.
 *
 * Drafts are user data — losing or duplicating them is a real bug. This covers
 * the persistence + server-sync branches of saveDraft, the list/delete helpers,
 * and (most importantly) the autosave timer's change-detection + in-flight
 * serialization, which exists specifically to avoid duplicate server drafts
 * when a debounce tick and an interval tick race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  online: true,
  demo: false,
  draftsStore: new Map<string, Record<string, unknown>>(),
  remoteRequest: vi.fn(),
  sendSyncTask: vi.fn().mockResolvedValue(undefined),
  draftsListResult: null as Record<string, unknown>[] | null,
  listThrows: false,
}));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => 'me@test.com') },
}));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/sync-worker-client', () => ({
  sendSyncTask: (...a: unknown[]) => h.sendSyncTask(...a),
}));
vi.mock('../../src/stores/settingsStore', () => ({
  getEffectiveSettingValue: vi.fn(() => undefined),
}));
vi.mock('../../src/utils/demo-mode', () => ({ isDemoMode: () => h.demo }));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => h.online }));
vi.mock('../../src/utils/db', () => ({
  db: {
    drafts: {
      put: vi.fn(async (d: Record<string, unknown>) => {
        h.draftsStore.set(String(d.id), d);
      }),
      get: vi.fn(async ([, id]: [string, string]) => h.draftsStore.get(id)),
      delete: vi.fn(async ([, id]: [string, string]) => {
        h.draftsStore.delete(id);
      }),
      where: () => ({
        between: () => ({
          toArray: async () => {
            if (h.listThrows) throw new Error('idb boom');
            return h.draftsListResult ?? [...h.draftsStore.values()];
          },
        }),
      }),
    },
  },
}));

import {
  saveDraft,
  listDrafts,
  deleteDraft,
  clearDrafts,
  syncPendingDrafts,
  createAutosaveTimer,
  draftHasContent,
} from '../../src/utils/draft-service.js';

beforeEach(() => {
  h.online = true;
  h.demo = false;
  h.draftsStore.clear();
  h.draftsListResult = null;
  h.listThrows = false;
  h.remoteRequest.mockReset();
  h.sendSyncTask.mockClear();
});

const content = { to: ['a@b.com'], subject: 'Hi', body: 'Hello there' };

describe('saveDraft', () => {
  it('persists locally and stays "local" when offline (no server call)', async () => {
    h.online = false;
    const saved = await saveDraft(content);
    expect(saved.syncStatus).toBe('local');
    expect(saved.id).toMatch(/^draft_/);
    expect(h.draftsStore.size).toBe(1);
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });

  it('skips server sync in demo mode', async () => {
    h.demo = true;
    const saved = await saveDraft(content);
    expect(saved.syncStatus).toBe('local');
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });

  it('POSTs a new draft online and returns "synced" with serverId', async () => {
    h.remoteRequest.mockResolvedValue({ id: 'srv-1' });
    const saved = await saveDraft(content);
    expect(h.remoteRequest).toHaveBeenCalledWith(
      'MessageCreate',
      expect.anything(),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(saved).toMatchObject({ syncStatus: 'synced', serverId: 'srv-1' });
  });

  it('PUTs an update when the draft already has a serverId', async () => {
    h.remoteRequest.mockResolvedValue({ id: 'srv-1' });
    await saveDraft({ ...content, id: 'draft_1', serverId: 'srv-1' });
    expect(h.remoteRequest).toHaveBeenCalledWith(
      'MessageUpdate',
      expect.anything(),
      expect.objectContaining({ method: 'PUT', pathOverride: '/v1/messages/srv-1' }),
    );
  });

  it('falls back to "pending" with lastError when the server sync fails', async () => {
    h.remoteRequest.mockRejectedValue(new Error('500'));
    const saved = await saveDraft(content);
    expect(saved.syncStatus).toBe('pending');
    expect(saved.lastError).toBe('500');
    // the failed record is still persisted
    expect((h.draftsStore.get(saved.id) as { syncStatus?: string })?.syncStatus).toBe('pending');
  });

  it('does not sync when sync:false is passed', async () => {
    const saved = await saveDraft(content, { sync: false });
    expect(saved.syncStatus).toBe('local');
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });
});

describe('list/delete/clear', () => {
  it('listDrafts returns newest-first', async () => {
    h.draftsListResult = [
      { id: 'a', updatedAt: 100 },
      { id: 'b', updatedAt: 300 },
      { id: 'c', updatedAt: 200 },
    ];
    expect((await listDrafts()).map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('listDrafts returns [] on a db error instead of throwing', async () => {
    h.listThrows = true;
    expect(await listDrafts()).toEqual([]);
  });

  it('deleteDraft surfaces a wrapped error on failure', async () => {
    const { db } = await import('../../src/utils/db');
    (db.drafts.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('locked'));
    await expect(deleteDraft('x')).rejects.toThrow(/Failed to delete draft: locked/);
  });

  it('clearDrafts removes every draft and returns the count', async () => {
    h.draftsStore.set('a', { id: 'a' });
    h.draftsStore.set('b', { id: 'b' });
    const n = await clearDrafts();
    expect(n).toBe(2);
    expect(h.draftsStore.size).toBe(0);
  });

  it('syncPendingDrafts swallows scheduling failures', async () => {
    h.sendSyncTask.mockRejectedValueOnce(new Error('no worker'));
    await expect(syncPendingDrafts()).resolves.toBeUndefined();
  });
});

describe('draftHasContent', () => {
  it('treats a blank draft as empty', () => {
    expect(draftHasContent({ to: [], cc: [], bcc: [], subject: '', body: '' })).toBe(false);
  });

  it('treats empty rich-text markup as empty', () => {
    // TipTap reports an empty document as wrapper markup, not an empty string.
    for (const body of ['<p></p>', '<p><br></p>', '<p>&nbsp;</p>', '<p> </p><p></p>']) {
      expect(draftHasContent({ to: [], subject: '', body, isPlainText: false })).toBe(false);
    }
  });

  it('counts real body text, even inside markup', () => {
    expect(draftHasContent({ to: [], subject: '', body: '<p>hi</p>' })).toBe(true);
    expect(draftHasContent({ to: [], subject: '', body: 'hi', isPlainText: true })).toBe(true);
  });

  it('counts an image-only rich body as content', () => {
    expect(draftHasContent({ to: [], subject: '', body: '<p><img src="x.png"></p>' })).toBe(true);
  });

  it('counts recipients, subject, or attachments alone as content', () => {
    expect(draftHasContent({ to: ['a@b.com'], subject: '', body: '' })).toBe(true);
    expect(draftHasContent({ to: [], subject: 'Hi', body: '' })).toBe(true);
    expect(draftHasContent({ to: [], subject: '', body: '', attachments: [{ name: 'f' }] })).toBe(
      true,
    );
  });
});

describe('createAutosaveTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not save empty/meaningless content', async () => {
    const onSave = vi.fn();
    const t = createAutosaveTimer(() => ({ to: [], subject: '', body: '' }), { onSave });
    t.markDirty();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not save a rich-text body that is only empty markup', async () => {
    // Typing a character and deleting it leaves "<p></p>" in the body, which
    // used to slip past the emptiness check and persist a blank draft.
    const onSave = vi.fn();
    const t = createAutosaveTimer(
      () => ({ to: [], subject: '', body: '<p></p>', isPlainText: false }),
      { onSave },
    );
    t.markDirty();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves an attachment-only draft', async () => {
    h.online = false;
    const onSave = vi.fn();
    const t = createAutosaveTimer(
      () => ({ to: [], subject: '', body: '', attachments: [{ name: 'f.txt', size: 1 }] }),
      { onSave },
    );
    t.markDirty();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('saves once after the debounce window when content is meaningful', async () => {
    h.online = false; // keep it local, no server round-trip
    const onSave = vi.fn();
    const t = createAutosaveTimer(() => content, { onSave });
    t.markDirty();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('does not re-save unchanged content (hash guard)', async () => {
    h.online = false;
    const onSave = vi.fn();
    const t = createAutosaveTimer(() => content, { onSave });
    await t.saveNow();
    await t.saveNow();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('markBaseline locks current content so an untouched compose does not autosave', async () => {
    h.online = false;
    const onSave = vi.fn();
    const t = createAutosaveTimer(() => content, { onSave });
    t.markBaseline();
    await t.saveNow();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('serializes concurrent saves so a second POST cannot race the first', async () => {
    vi.useRealTimers(); // this test drives saveNow() directly, no debounce timers
    h.online = true;
    let resolveFirst: (v: unknown) => void = () => {};
    h.remoteRequest.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveFirst = r;
        }),
    );
    h.remoteRequest.mockResolvedValue({ id: 'srv-1' }); // any subsequent call
    const data: Record<string, unknown> = { ...content };
    // Mirror the compose component: onSave feeds the assigned id/serverId back
    // so the follow-up save is an update of the same draft, not a new one.
    const t = createAutosaveTimer(() => data, {
      onSave: (saved: { id?: string; serverId?: string }) => {
        data.id = saved.id;
        data.serverId = saved.serverId;
      },
    });
    const p1 = t.saveNow(); // starts, blocks on the (still-pending) remote POST
    await vi.waitFor(() => expect(h.remoteRequest).toHaveBeenCalledTimes(1));
    data.body = 'edited while in-flight';
    const p2 = t.saveNow(); // dedupes onto the in-flight save instead of POSTing again
    resolveFirst({ id: 'srv-1' });
    await Promise.all([p1, p2]);
    // first POST (create) + one follow-up (a PUT now that serverId is known) =
    // exactly 2 calls, never two concurrent creates.
    expect(h.remoteRequest).toHaveBeenCalledTimes(2);
    expect(h.remoteRequest.mock.calls[0][0]).toBe('MessageCreate');
    expect(h.remoteRequest.mock.calls[1][0]).toBe('MessageUpdate');
  });
});
