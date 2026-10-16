/**
 * A draft is created on the server once. Saves of one draft can overlap
 * (autosave, closing the composer) and the sync worker's draft task can run
 * at the same time; each used to POST its own copy, leaving duplicate drafts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  drafts: new Map<string, Record<string, unknown>>(),
  request: vi.fn(),
  sendSyncTask: vi.fn(),
}));

vi.mock('../../src/utils/storage', () => ({ Local: { get: () => 'me@test.com' } }));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.request(...a) },
}));
vi.mock('../../src/utils/sync-worker-client', () => ({
  sendSyncTask: (...a: unknown[]) => h.sendSyncTask(...a),
}));
vi.mock('../../src/stores/settingsStore', () => ({ getEffectiveSettingValue: () => undefined }));
vi.mock('../../src/utils/demo-mode', () => ({ isDemoMode: () => false }));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => true }));
vi.mock('../../src/utils/db', () => ({
  db: {
    drafts: {
      put: async (d: Record<string, unknown>) => {
        h.drafts.set(String(d.id), { ...d });
      },
      get: async ([, id]: [string, string]) => h.drafts.get(id),
      delete: async ([, id]: [string, string]) => {
        h.drafts.delete(id);
      },
      where: () => ({ between: () => ({ toArray: async () => [...h.drafts.values()] }) }),
    },
  },
}));

const { saveDraft, syncPendingDrafts } = await import('../../src/utils/draft-service.js');

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

let created = 0;

beforeEach(() => {
  h.drafts.clear();
  created = 0;
  h.request.mockReset().mockImplementation(async (action: string) => {
    if (action === 'MessageCreate') {
      created += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { id: `srv-${created}` };
    }
    return {};
  });
  h.sendSyncTask.mockReset().mockResolvedValue(undefined);
});

const actions = () =>
  h.request.mock.calls.map(([action, , options]) => [action, options.pathOverride]);

describe('one server draft per draft', () => {
  it('updates the draft the first of two overlapping saves created', async () => {
    await Promise.all([
      saveDraft({ id: 'd1', subject: 'Hello', body: 'one' }),
      saveDraft({ id: 'd1', subject: 'Hello', body: 'one two' }),
    ]);

    expect(actions()).toEqual([
      ['MessageCreate', '/v1/messages'],
      ['MessageUpdate', '/v1/messages/srv-1'],
    ]);
    expect(h.drafts.get('d1')).toMatchObject({ serverId: 'srv-1', body: 'one two' });
  });

  it('waits for the sync worker, then updates the draft it created', async () => {
    h.drafts.set('d2', { id: 'd2', account: 'me@test.com', subject: 'Hi', syncStatus: 'pending' });
    const worker = deferred();
    h.sendSyncTask.mockImplementation(async () => {
      await worker.promise;
      // what the sync worker's draft task stores after its POST
      h.drafts.set('d2', { ...h.drafts.get('d2'), serverId: 'srv-worker', syncStatus: 'synced' });
    });

    const sync = syncPendingDrafts();
    await Promise.resolve();
    const save = saveDraft({ id: 'd2', subject: 'Hi', body: 'more' });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.request).not.toHaveBeenCalled();
    worker.resolve();
    await Promise.all([sync, save]);

    expect(actions()).toEqual([['MessageUpdate', '/v1/messages/srv-worker']]);
  });

  it('starts the sync worker only after a save in flight has finished', async () => {
    const save = saveDraft({ id: 'd3', subject: 'Hi', body: 'x' });
    const sync = syncPendingDrafts();
    await Promise.all([save, sync]);

    expect(h.sendSyncTask).toHaveBeenCalledTimes(1);
    // by then the draft is stored with its server id, so the worker skips it
    expect(h.drafts.get('d3')).toMatchObject({ serverId: 'srv-1', syncStatus: 'synced' });
    expect(h.request.mock.invocationCallOrder[0]).toBeLessThan(
      h.sendSyncTask.mock.invocationCallOrder[0],
    );
  });
});
