/**
 * db-worker-client against the real engine.
 *
 * The inlined db worker is replaced by an in-process stand-in that runs the
 * real db-engine (on fake-indexeddb) behind postMessage, so the client's
 * request plumbing, query builder and transaction batching are exercised end
 * to end. A "silent" mode drops requests on the floor, the way a dead or
 * replaced worker does.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  instances: [] as Array<{ terminated: boolean; silent: boolean; received: unknown[] }>,
  silentNext: false,
}));

vi.mock('../../src/workers/db.worker.ts?worker&inline', () => {
  class FakeDbWorker {
    terminated = false;
    silent = fake.silentNext;
    received: unknown[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    onmessageerror: unknown = null;
    private listeners = new Set<(event: { data: unknown }) => void>();

    constructor() {
      fake.instances.push(this);
      setTimeout(() => this.emit({ type: 'booted' }), 0);
    }

    addEventListener(_type: string, fn: (event: { data: unknown }) => void) {
      this.listeners.add(fn);
    }

    removeEventListener(_type: string, fn: (event: { data: unknown }) => void) {
      this.listeners.delete(fn);
    }

    emit(data: unknown) {
      if (this.terminated) return;
      for (const fn of this.listeners) fn({ data });
      this.onmessage?.({ data });
    }

    postMessage(message: { id: number; action: string; table?: string; payload?: unknown }) {
      this.received.push(message);
      if (this.silent || this.terminated) return;
      import('../../src/utils/db-engine').then(({ executeOperation }) =>
        executeOperation({
          action: message.action,
          table: message.table,
          payload: message.payload as Record<string, unknown>,
        }).then(
          (result) => this.emit({ id: message.id, ok: true, result }),
          (error: Error) =>
            this.emit({ id: message.id, ok: false, error: error.message, errorName: error.name }),
        ),
      );
    }

    terminate() {
      this.terminated = true;
    }
  }
  return { default: FakeDbWorker };
});

import { markBootstrapReady } from '../../src/utils/bootstrap-ready.js';
import {
  dbClient,
  initDbClient,
  terminateDbWorker,
  setDbRequestTimeout,
  onDbWorkerChange,
  isDbUsingMainThread,
  getDbWorker,
} from '../../src/utils/db-worker-client.js';

const A = 'alice@example.com';
const B = 'bob@example.com';

type Row = Record<string, unknown>;
const message = (account: string, id: string, folder = 'INBOX'): Row => ({
  account,
  id,
  folder,
  date: 1_700_000_000_000,
  subject: `Subject ${id}`,
});

describe('db-worker-client with the real engine', () => {
  beforeAll(async () => {
    // Dev builds hold the db client until bootstrap says go.
    markBootstrapReady();
    await initDbClient();
  });

  beforeEach(async () => {
    await dbClient.messages.clear();
    await dbClient.messageBodies.clear();
    await dbClient.folders.clear();
    await dbClient.meta.clear();
  });

  afterEach(() => {
    setDbRequestTimeout(60_000);
  });

  it('anyOf on a compound index deletes exactly the listed messages', async () => {
    await dbClient.messages.bulkPut([
      message(A, 'm1'),
      message(A, 'm2'),
      message(A, 'm3'),
      message(B, 'm1'),
    ]);
    await dbClient.messageBodies.bulkPut([
      { account: A, id: 'm1', body: '<p>one</p>' },
      { account: A, id: 'm3', body: '<p>three</p>' },
    ]);

    // The bulkDeleteMessages cleanup in mailboxStore.ts.
    const deleteIds = ['m1', 'm3'];
    await dbClient.messages
      .where('[account+id]')
      .anyOf(deleteIds.map((id) => [A, id]))
      .delete();
    await dbClient.messageBodies
      .where('[account+id]')
      .anyOf(deleteIds.map((id) => [A, id]))
      .delete();

    const left = (await dbClient.messages.toArray()) as Row[];
    expect(left.map((m) => `${m.account}/${m.id}`).sort()).toEqual([`${A}/m2`, `${B}/m1`]);
    expect(await dbClient.messageBodies.count()).toBe(0);
  });

  it('anyOf toArray and count match Dexie semantics', async () => {
    await dbClient.messages.bulkPut([message(A, 'm1'), message(A, 'm2'), message(A, 'm3')]);
    const rows = (await dbClient.messages
      .where('[account+id]')
      .anyOf([A, 'm1'], [A, 'm3'])
      .toArray()) as Row[];
    expect(rows.map((r) => r.id).sort()).toEqual(['m1', 'm3']);
    expect(
      await dbClient.messages
        .where('[account+id]')
        .anyOf([[A, 'm2']])
        .count(),
    ).toBe(1);
    expect(await dbClient.messages.where('[account+id]').anyOf([]).delete()).toBe(0);
  });

  it('startsWith().delete() removes the whole key family, not an exact match', async () => {
    // The per-account cleanup in storage.js clearAccountCacheData.
    await dbClient.meta.bulkPut([
      { key: `mutation_queue_${A}`, value: [] },
      { key: `saved_search_${A}_invoices`, value: 'invoice' },
      { key: `saved_search_${A}_travel`, value: 'flight' },
      { key: `saved_search_${B}_invoices`, value: 'invoice' },
    ]);

    const removed = await dbClient.meta.where('key').startsWith(`saved_search_${A}_`).delete();
    expect(removed).toBe(2);
    const keys = ((await dbClient.meta.toArray()) as Row[]).map((r) => r.key).sort();
    expect(keys).toEqual([`mutation_queue_${A}`, `saved_search_${B}_invoices`]);
    expect(await dbClient.meta.where('key').startsWith('saved_search_').count()).toBe(1);
  });

  it('commits a transaction callback as one unit: a failing write rolls back the delete', async () => {
    await dbClient.folders.bulkPut([
      { account: A, path: 'INBOX' },
      { account: A, path: 'Archive' },
    ]);

    // loadFolders' replace-the-account's-folders pattern, with a bad row.
    await expect(
      dbClient.transaction('rw', dbClient.folders, async () => {
        await dbClient.folders.where('account').equals(A).delete();
        await dbClient.folders.bulkPut([
          { account: A, path: 'INBOX' },
          { account: A }, // no primary key path: IndexedDB rejects it
        ]);
      }),
    ).rejects.toThrow();

    const folders = (await dbClient.folders.toArray()) as Row[];
    expect(folders.map((f) => f.path).sort()).toEqual(['Archive', 'INBOX']);
  });

  it('commits every write of a successful transaction', async () => {
    await dbClient.folders.bulkPut([{ account: A, path: 'Old' }]);
    await dbClient.transaction('rw', dbClient.folders, async () => {
      await dbClient.folders.where('account').equals(A).delete();
      await dbClient.folders.bulkPut([
        { account: A, path: 'INBOX' },
        { account: A, path: 'Sent' },
      ]);
    });
    const folders = (await dbClient.folders.toArray()) as Row[];
    expect(folders.map((f) => f.path).sort()).toEqual(['INBOX', 'Sent']);
  });

  it('rejects a request the worker never answers instead of hanging', async () => {
    setDbRequestTimeout(50);
    const worker = fake.instances[fake.instances.length - 1];
    worker.silent = true;
    try {
      await expect(dbClient.messages.get([A, 'm1'])).rejects.toMatchObject({
        code: 'DB_REQUEST_TIMEOUT',
      });
    } finally {
      worker.silent = false;
    }
  });

  it('marks the engine gate at init when a crypto provider is registered', async () => {
    const { setCryptoConfigProvider } = await import('../../src/utils/db-worker-client.js');
    await setCryptoConfigProvider(async () => ({ required: false, rawKey: null }));
    terminateDbWorker();
    await initDbClient();
    const worker = fake.instances[fake.instances.length - 1];
    const init = worker.received.find((m) => (m as { action?: string }).action === 'init') as {
      payload: Row;
    };
    expect(init.payload.cryptoGate).toBe(true);
    const config = worker.received.find(
      (m) => (m as { action?: string }).action === 'configureCrypto',
    );
    expect(config).toBeDefined();
  });

  it('terminates a worker that failed init and reports the move to the main thread', async () => {
    const changes: Array<{ worker: unknown; useMainThread: boolean }> = [];
    const off = onDbWorkerChange((info) => changes.push(info));
    terminateDbWorker();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fake.silentNext = true; // the next worker boots but its IndexedDB never answers
    try {
      const init = initDbClient();
      await vi.advanceTimersByTimeAsync(31_000);
      await init;
    } finally {
      fake.silentNext = false;
      vi.useRealTimers();
      off();
    }

    const stuck = fake.instances[fake.instances.length - 1];
    expect(stuck.terminated).toBe(true);
    expect(isDbUsingMainThread()).toBe(true);
    expect(getDbWorker()).toBeNull();
    expect(changes.at(-1)).toMatchObject({ worker: null, useMainThread: true });

    // Recovering from there brings up a fresh worker and leaves the
    // main-thread engine, rather than running both.
    terminateDbWorker();
    await initDbClient();
    expect(isDbUsingMainThread()).toBe(false);
    const live = fake.instances.filter((w) => !w.terminated);
    expect(live).toHaveLength(1);
    await dbClient.meta.put({ key: 'after-recovery', updatedAt: 1 });
    expect(live[0].received.some((m) => (m as { action?: string }).action === 'put')).toBe(true);
  });
});
