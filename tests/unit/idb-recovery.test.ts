/**
 * Database error recovery must be proportional to the error.
 *
 * A failed settings write (full disk, aborted transaction, worker timeout)
 * used to clear drafts and the outbox for every account, and a worker
 * timeout deleted the whole database including queued changes and the
 * app_lock_enabled flag. These tests run handleDatabaseError against the real
 * engine on fake-indexeddb and check what survives each kind of error.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';

const evict = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../src/utils/db-worker-client.js', async () => {
  const { executeOperation } = await import('../../src/utils/db-engine');
  const exec = (action: string, table?: string, payload?: Record<string, unknown>) =>
    executeOperation({ action, table, payload });
  return {
    dbClient: { isOpen: true },
    initDbClient: vi.fn(async () => exec('init')),
    terminateDbWorker: vi.fn(() => {
      void exec('close');
    }),
    getDbWorker: () => null,
    isDbUsingMainThread: () => true,
    getDatabaseInfo: vi.fn(async () => exec('getInfo')),
    clearCache: vi.fn(async () => exec('clearCache')),
    resetDatabase: vi.fn(async () => exec('reset')),
    restoreRawRows: vi.fn(async (table: string, records: unknown[]) =>
      exec('restoreRaw', table, { records }),
    ),
  };
});

vi.mock('../../src/utils/cache-manager.js', () => ({
  cacheManager: {
    evictionTarget: 0.1,
    getStorageInfo: async () => ({ usage: 950, quota: 1000, percentage: 95 }),
    evictOldest: async () => {
      evict.calls += 1;
      return { freedBytes: 4096, evicted: { bodies: 3, messages: 0 } };
    },
  },
}));

import { executeOperation } from '../../src/utils/db-engine';
import { DB_NAME } from '../../src/utils/db-constants';
import { handleDatabaseError } from '../../src/utils/db';
import { attemptRecovery } from '../../src/utils/db-recovery.js';

type Row = Record<string, unknown>;
const run = (action: string, table?: string, payload?: Row) =>
  executeOperation({ action, table, payload });

const A = 'alice@example.com';
const B = 'bob@example.com';

async function seedLocalData() {
  await run('bulkPut', 'drafts', {
    records: [
      { account: A, id: 'd1', subject: 'Contract redlines', body: '<p>see attached</p>' },
      { account: B, id: 'd2', subject: 'Re: lunch', body: '<p>Thursday works</p>' },
    ],
  });
  await run('put', 'outbox', {
    record: { account: A, id: 'o1', status: 'pending', subject: 'Invoice 2041', retryCount: 1 },
  });
  await run('put', 'meta', {
    record: { key: `mutation_queue_${A}`, value: [{ id: 'q1', type: 'move', to: 'Archive' }] },
  });
  await run('put', 'meta', { record: { key: 'app_lock_enabled', value: true, updatedAt: 1 } });
  await run('put', 'messages', {
    record: { account: A, id: 'm1', folder: 'INBOX', subject: 'Server copy' },
  });
}

async function rawGet(table: string, key: unknown): Promise<Row | undefined> {
  const raw = new Dexie(DB_NAME);
  const stores = await raw.open();
  try {
    return (await stores.table(table).get(key as never)) as Row | undefined;
  } finally {
    raw.close();
  }
}

async function expectLocalDataIntact() {
  expect((await run('get', 'drafts', { key: [A, 'd1'] })) as Row).toMatchObject({
    subject: 'Contract redlines',
  });
  expect((await run('get', 'drafts', { key: [B, 'd2'] })) as Row).toMatchObject({
    subject: 'Re: lunch',
  });
  expect((await run('get', 'outbox', { key: [A, 'o1'] })) as Row).toMatchObject({
    status: 'pending',
  });
  expect(((await run('get', 'meta', { key: `mutation_queue_${A}` })) as Row).value).toEqual([
    { id: 'q1', type: 'move', to: 'Archive' },
  ]);
  expect(((await run('get', 'meta', { key: 'app_lock_enabled' })) as Row).value).toBe(true);
}

describe('handleDatabaseError', () => {
  let deleteSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    await run('init');
  });

  beforeEach(async () => {
    await run('init');
    for (const t of ['drafts', 'outbox', 'meta', 'messages']) await run('clear', t);
    await seedLocalData();
    deleteSpy?.mockRestore();
    deleteSpy = vi.spyOn(indexedDB, 'deleteDatabase');
    evict.calls = 0;
  });

  it('frees space on a quota error without touching drafts, outbox or queued changes', async () => {
    const err = new Error('The quota has been exceeded.');
    err.name = 'QuotaExceededError';

    const result = await handleDatabaseError(err);

    expect(result).toEqual({ recovered: true, method: 'evict' });
    expect(evict.calls).toBe(1);
    await expectLocalDataIntact();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('restarts the worker on a timeout and never deletes the database', async () => {
    const err = new Error('Database worker init timeout') as Error & { code?: string };
    err.code = 'DB_WORKER_INIT_TIMEOUT';

    const result = await handleDatabaseError(err);

    expect(result.method).toBe('restart-worker');
    expect(deleteSpy).not.toHaveBeenCalled();
    await expectLocalDataIntact();
    expect(await rawGet('messages', [A, 'm1'])).toBeDefined();
  });

  it('does nothing destructive for an aborted transaction or a blocked request', async () => {
    const aborted = new Error('Transaction aborted');
    aborted.name = 'AbortError';
    const blocked = new Error('Request blocked by another connection');

    expect(await handleDatabaseError(aborted)).toEqual({ recovered: false, method: null });
    expect(await handleDatabaseError(blocked)).toEqual({ recovered: false, method: null });

    expect(deleteSpy).not.toHaveBeenCalled();
    await expectLocalDataIntact();
    expect(await rawGet('messages', [A, 'm1'])).toBeDefined();
  });

  it('reopens first on suspected corruption, and rebuilds only if it comes back, keeping local data', async () => {
    const corrupt = () => {
      const err = new Error('Failed to read: object store not found');
      err.name = 'NotFoundError';
      return err;
    };

    const first = await handleDatabaseError(corrupt());
    expect(first.method).toBe('reopen');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await rawGet('messages', [A, 'm1'])).toBeDefined();

    const second = await handleDatabaseError(corrupt());
    expect(second).toEqual({ recovered: true, method: 'rebuild' });
    expect(deleteSpy).toHaveBeenCalledWith(DB_NAME);

    // The server copy is gone; everything that existed only here came back.
    expect(await rawGet('messages', [A, 'm1'])).toBeUndefined();
    await expectLocalDataIntact();
  });
});

describe('attemptRecovery (service worker dbError path)', () => {
  beforeEach(async () => {
    await run('init');
    for (const t of ['drafts', 'outbox', 'meta', 'messages']) await run('clear', t);
    await seedLocalData();
  });

  it('refuses to delete the database for a quota error', async () => {
    const err = new Error('quota exceeded');
    err.name = 'QuotaExceededError';
    const result = await attemptRecovery(err);
    expect(result.recovered).toBe(false);
    await expectLocalDataIntact();
  });
});
