/**
 * db-engine unit tests.
 *
 * `src/utils/db-engine.ts` was extracted from `src/workers/db.worker.ts` so the
 * exact same Dexie/IndexedDB logic can run EITHER in the worker (normal path) or
 * on the main thread (the WebKitGTK fallback in db-worker-client.js). Both paths
 * dispatch through the single `executeOperation({action, table, payload})`
 * entry point, so exercising it here against `fake-indexeddb` validates the
 * worker and main-thread code paths at once — and guards the mechanical
 * extraction against regressions (a broken query/transaction would surface here
 * rather than only on a real device).
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { executeOperation } from '../../src/utils/db-engine';

type Row = Record<string, unknown>;
const run = (action: string, table?: string, payload?: Row) =>
  executeOperation({ action, table, payload });

describe('db-engine executeOperation', () => {
  beforeAll(async () => {
    const res = await run('init');
    expect(res).toEqual({ success: true });
  });

  beforeEach(async () => {
    // Each test starts from clean data tables (the engine is a module singleton).
    await run('clear', 'messages');
    await run('clear', 'folders');
    await run('clear', 'meta');
  });

  it('round-trips put/get on the meta table (the worker init probe path)', async () => {
    await run('put', 'meta', { record: { key: 'probe', updatedAt: 1 } });
    const got = (await run('get', 'meta', { key: 'probe' })) as Row | undefined;
    expect(got).toMatchObject({ key: 'probe', updatedAt: 1 });
    await run('delete', 'meta', { key: 'probe' });
    expect(await run('get', 'meta', { key: 'probe' })).toBeUndefined();
  });

  it('bulkPut + toArray + count on messages', async () => {
    await run('bulkPut', 'messages', {
      records: [
        { account: 'a', id: 'm1', folder: 'INBOX', is_unread: true },
        { account: 'a', id: 'm2', folder: 'INBOX', is_unread: false },
        { account: 'a', id: 'm3', folder: 'Sent', is_unread: true },
      ],
    });
    expect((await run('toArray', 'messages')) as Row[]).toHaveLength(3);
    expect(await run('count', 'messages')).toBe(3);
  });

  it('queryEquals resolves the [account+folder] compound index', async () => {
    await run('bulkPut', 'messages', {
      records: [
        { account: 'a', id: 'm1', folder: 'INBOX' },
        { account: 'a', id: 'm2', folder: 'INBOX' },
        { account: 'a', id: 'm3', folder: 'Sent' },
        { account: 'b', id: 'm4', folder: 'INBOX' },
      ],
    });
    const inbox = (await run('queryEquals', 'messages', {
      index: '[account+folder]',
      value: ['a', 'INBOX'],
    })) as Row[];
    expect(inbox.map((m) => m.id).sort()).toEqual(['m1', 'm2']);

    const count = await run('queryEqualsCount', 'messages', {
      index: '[account+folder]',
      value: ['a', 'INBOX'],
    });
    expect(count).toBe(2);
  });

  it('queryBetween returns date-ordered results on [account+folder+date]', async () => {
    await run('bulkPut', 'messages', {
      records: [
        { account: 'a', id: 'm1', folder: 'INBOX', date: 100 },
        { account: 'a', id: 'm2', folder: 'INBOX', date: 300 },
        { account: 'a', id: 'm3', folder: 'INBOX', date: 200 },
      ],
    });
    const asc = (await run('queryBetween', 'messages', {
      index: '[account+folder+date]',
      lower: ['a', 'INBOX', Dexie.minKey],
      upper: ['a', 'INBOX', Dexie.maxKey],
      options: { includeLower: true, includeUpper: true },
    })) as Row[];
    expect(asc.map((m) => m.id)).toEqual(['m1', 'm3', 'm2']);
  });

  it('queryEqualsModify flips a field across a compound-index slice', async () => {
    await run('bulkPut', 'messages', {
      records: [
        { account: 'a', id: 'm1', folder: 'INBOX', is_unread: true },
        { account: 'a', id: 'm2', folder: 'INBOX', is_unread: true },
      ],
    });
    const modified = await run('queryEqualsModify', 'messages', {
      index: '[account+folder]',
      value: ['a', 'INBOX'],
      changes: { is_unread: false },
    });
    expect(modified).toBe(2);
    const all = (await run('toArray', 'messages')) as Row[];
    expect(all.every((m) => m.is_unread === false)).toBe(true);
  });

  it('bulkDelete removes by compound primary key', async () => {
    await run('bulkPut', 'messages', {
      records: [
        { account: 'a', id: 'm1', folder: 'INBOX' },
        { account: 'a', id: 'm2', folder: 'INBOX' },
      ],
    });
    await run('bulkDelete', 'messages', { keys: [['a', 'm1']] });
    expect(((await run('toArray', 'messages')) as Row[]).map((m) => m.id)).toEqual(['m2']);
  });

  it('runs a multi-op transaction atomically', async () => {
    const result = (await run('transaction', undefined, {
      mode: 'rw',
      tables: ['messages'],
      operations: [
        {
          action: 'put',
          table: 'messages',
          payload: { record: { account: 'a', id: 'm1', folder: 'INBOX' } },
        },
        { action: 'count', table: 'messages' },
      ],
    })) as unknown[];
    expect(result).toEqual([['a', 'm1'], 1]);
  });

  it('getInfo reports an open db with the expected tables', async () => {
    const info = (await run('getInfo')) as {
      isOpen: boolean;
      tables: Array<{ name: string }>;
    };
    expect(info.isOpen).toBe(true);
    const names = info.tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['messages', 'folders', 'meta', 'messageBodies']));
  });
});
