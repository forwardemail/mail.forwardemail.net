/**
 * At-rest encryption hardening in the db engine, run against fake-indexeddb
 * through the same executeOperation dispatcher the db worker uses.
 *
 * Covers: calendar and settings caches being sealed, writes during the App
 * Lock disable sweep landing as plaintext, both sweeps leaving rows alone
 * that changed under them, the encrypt sweep resuming after an interruption,
 * the boot gate that holds sensitive writes until the crypto config arrives,
 * and abandoning an unreadable cache without orphaning sealed meta rows.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// Hooks that run in the middle of a sweep, between the moment it reads a row
// and the moment it writes the converted row back. That is where a real
// concurrent write from the UI or the sync worker can land. Each hook clears
// itself once it has acted.
const hooks = vi.hoisted(() => ({
  onSeal: null as null | ((table: string, record: Record<string, unknown>) => Promise<void>),
  onOpen: null as null | ((table: string, record: Record<string, unknown>) => Promise<void>),
}));

vi.mock('../../src/utils/db-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/db-crypto')>();
  const fire = async (
    which: 'onSeal' | 'onOpen',
    table: string,
    record: unknown,
  ): Promise<void> => {
    const hook = hooks[which];
    const rec = record as Record<string, unknown> | undefined;
    if (!hook || !rec) return;
    await hook(table, rec);
  };
  return {
    ...actual,
    sealRecord: async (table: string, record: unknown) => {
      await fire('onSeal', table, record);
      return actual.sealRecord(table, record);
    },
    openRecord: async (table: string, record: unknown) => {
      if ((record as Record<string, unknown> | undefined)?._enc) {
        await fire('onOpen', table, record);
      }
      return actual.openRecord(table, record);
    },
    openRecordStrict: async (table: string, record: unknown) => {
      await fire('onOpen', table, record);
      return actual.openRecordStrict(table, record);
    },
  };
});

import Dexie from 'dexie';
import { executeOperation } from '../../src/utils/db-engine';
import { DB_NAME } from '../../src/utils/db-constants';

type Row = Record<string, unknown>;
const run = (action: string, table?: string, payload?: Row) =>
  executeOperation({ action, table, payload });

const KEY = new Uint8Array(32).fill(7);
const A = 'alice@example.com';

const configure = (required: boolean, withKey: boolean, extra: Row = {}) =>
  run('configureCrypto', undefined, { required, rawKey: withKey ? KEY : null, ...extra });

async function rawGet(table: string, key: unknown, dbName = DB_NAME): Promise<Row | undefined> {
  const raw = new Dexie(dbName);
  const stores = await raw.open();
  try {
    return (await stores.table(table).get(key as never)) as Row | undefined;
  } finally {
    raw.close();
  }
}

async function rawPut(table: string, record: Row): Promise<void> {
  const raw = new Dexie(DB_NAME);
  const stores = await raw.open();
  try {
    await stores.table(table).put(record);
  } finally {
    raw.close();
  }
}

const message = (id: string, extra: Row = {}): Row => ({
  account: A,
  id,
  folder: 'INBOX',
  date: 1_700_000_000_000,
  is_unread: true,
  subject: `Quarterly numbers ${id}`,
  from: 'bob@example.com',
  snippet: `Hi Alice, attached are the numbers for ${id}`,
  ...extra,
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('db engine at-rest encryption hardening', () => {
  beforeAll(async () => {
    expect(await run('init')).toEqual({ success: true });
  });

  beforeEach(async () => {
    await configure(false, false);
    for (const t of ['messages', 'messageBodies', 'drafts', 'outbox', 'meta', 'settings']) {
      await run('clear', t);
    }
  });

  afterEach(() => {
    hooks.onSeal = null;
    hooks.onOpen = null;
  });

  it('seals the calendar caches and cached account settings under App Lock', async () => {
    await configure(true, true);
    await run('put', 'meta', {
      record: {
        key: `calendar_events_${A}_all`,
        value: [{ id: 'ev1', title: 'Oncology appointment', start: '2026-10-20T09:00:00Z' }],
        updatedAt: 1,
      },
    });
    await run('put', 'meta', {
      record: { key: `calendars_${A}`, value: [{ id: 'cal1', name: 'Personal' }], updatedAt: 1 },
    });
    await run('put', 'settings', {
      record: {
        account: A,
        settings: { signature: '<p>Alice Example, Acme Legal</p>' },
        updatedAt: 1,
      },
    });

    const events = await rawGet('meta', `calendar_events_${A}_all`);
    expect(events?._enc).toBeDefined();
    expect(JSON.stringify(events)).not.toContain('Oncology');
    expect((await rawGet('meta', `calendars_${A}`))?._enc).toBeDefined();
    const settings = await rawGet('settings', A);
    expect(settings?._enc).toBeDefined();
    expect(JSON.stringify(settings)).not.toContain('Acme Legal');

    // Still readable through the engine.
    const read = (await run('get', 'meta', { key: `calendar_events_${A}_all` })) as Row;
    expect((read.value as Row[])[0].title).toBe('Oncology appointment');
  });

  it('stores writes made during the disable sweep as plaintext', async () => {
    await configure(true, true);
    // Disable in progress: key kept for reading, sealing stopped.
    await configure(false, true, { sealWrites: false });
    await run('put', 'drafts', {
      record: { account: A, id: 'd-new', subject: 'Typed while disabling', body: 'hello' },
    });
    await configure(false, false); // the key is discarded

    const onDisk = await rawGet('drafts', [A, 'd-new']);
    expect(onDisk?._enc).toBeUndefined();
    expect(onDisk?.subject).toBe('Typed while disabling');
  });

  it('does not let the decrypt sweep overwrite a draft saved while it runs', async () => {
    await configure(true, true);
    await run('put', 'drafts', {
      record: { account: A, id: 'd1', subject: 'First version', body: 'v1' },
    });
    await configure(false, true, { sealWrites: false });

    // The user saves the draft again after the sweep has read the old row.
    hooks.onOpen = async (table) => {
      if (table !== 'drafts') return;
      hooks.onOpen = null;
      await run('put', 'drafts', {
        record: { account: A, id: 'd1', subject: 'Second version', body: 'v2' },
      });
    };
    await run('unsealForDisable');
    await configure(false, false);

    const onDisk = await rawGet('drafts', [A, 'd1']);
    expect(onDisk?._enc).toBeUndefined();
    expect(onDisk?.subject).toBe('Second version');
    expect(onDisk?.body).toBe('v2');
  });

  it('does not resurrect a message deleted while the encrypt sweep runs', async () => {
    await run('bulkPut', 'messages', { records: [message('m1'), message('m2')] });
    await configure(true, true);

    hooks.onSeal = async (table, record) => {
      if (table === 'messages' && record.id === 'm1') {
        hooks.onSeal = null;
        await run('delete', 'messages', { key: [A, 'm1'] });
      }
    };
    await run('reencryptAll', undefined, { direction: 'encrypt' });

    expect(await rawGet('messages', [A, 'm1'])).toBeUndefined();
    expect((await rawGet('messages', [A, 'm2']))?._enc).toBeDefined();
  });

  it('does not revert a move made while the encrypt sweep runs', async () => {
    await run('put', 'messages', { record: message('m1') });
    await configure(true, true);

    hooks.onSeal = async (table, record) => {
      if (table === 'messages' && record.id === 'm1') {
        hooks.onSeal = null;
        await run('update', 'messages', { key: [A, 'm1'], changes: { folder: 'Archive' } });
      }
    };
    await run('reencryptAll', undefined, { direction: 'encrypt' });

    const read = (await run('get', 'messages', { key: [A, 'm1'] })) as Row;
    expect(read.folder).toBe('Archive');
  });

  it('records progress when the encrypt sweep is interrupted and resumes on the next key push', async () => {
    await run('bulkPut', 'messages', { records: [message('m1')] });
    await run('put', 'drafts', { record: { account: A, id: 'd1', subject: 'Unsent reply' } });
    await configure(true, true);

    // The app is closed while the sweep is on the drafts table.
    hooks.onSeal = async (table) => {
      if (table !== 'drafts') return;
      hooks.onSeal = null;
      throw new Error('app closed');
    };
    await expect(run('reencryptAll', undefined, { direction: 'encrypt' })).rejects.toThrow(
      'app closed',
    );
    const progress = await rawGet('meta', 'db_crypto_sweep_progress');
    expect(progress?.table).toBe('drafts');
    expect((await rawGet('drafts', [A, 'd1']))?._enc).toBeUndefined();

    // Next boot: the key is pushed again and the sweep picks up where it was.
    await configure(true, true);
    await waitFor(async () => !(await rawGet('meta', 'db_crypto_sweep_progress')));
    expect((await rawGet('drafts', [A, 'd1']))?._enc).toBeDefined();
    expect((await rawGet('messages', [A, 'm1']))?._enc).toBeDefined();
  });

  it('abandoning an unreadable cache removes sealed meta rows but keeps plaintext ones', async () => {
    await configure(true, true);
    await run('put', 'meta', {
      record: { key: `mutation_queue_${A}`, value: [{ id: 'q1', type: 'flag' }] },
    });
    await run('put', 'meta', { record: { key: `saved_search_${A}_invoices`, value: 'invoice' } });
    await run('put', 'meta', { record: { key: 'att_cache_manifest', value: { entries: [] } } });
    await run('put', 'drafts', { record: { account: A, id: 'd-sealed', subject: 'sealed' } });
    await configure(false, false);
    // Written after App Lock was lost: plaintext and readable.
    await rawPut('drafts', { account: A, id: 'd-plain', subject: 'plain' });
    await rawPut('meta', { key: `saved_search_${A}_plain`, value: 'kept' });
    await rawPut('meta', { key: 'migration:some-flag', updatedAt: 1 });

    await run('abandonSealed');

    expect(await rawGet('meta', `mutation_queue_${A}`)).toBeUndefined();
    expect(await rawGet('meta', `saved_search_${A}_invoices`)).toBeUndefined();
    expect(await rawGet('meta', 'att_cache_manifest')).toBeUndefined();
    expect(await rawGet('drafts', [A, 'd-sealed'])).toBeUndefined();
    expect((await rawGet('drafts', [A, 'd-plain']))?.subject).toBe('plain');
    expect((await rawGet('meta', `saved_search_${A}_plain`))?.value).toBe('kept');
    expect(await rawGet('meta', 'migration:some-flag')).toBeDefined();
  });

  it('runs a sealed multi-table write as one transaction', async () => {
    await configure(true, true);
    await run('put', 'messages', { record: message('m1') });
    await run('transaction', undefined, {
      mode: 'rw',
      tables: ['messages', 'messageBodies'],
      operations: [
        { action: 'put', table: 'messages', payload: { record: message('m2') } },
        {
          action: 'put',
          table: 'messageBodies',
          payload: { record: { account: A, id: 'm2', body: '<p>Board minutes</p>' } },
        },
        {
          action: 'update',
          table: 'messages',
          payload: { key: [A, 'm1'], changes: { subject: 'Edited' } },
        },
      ],
    });

    const body = await rawGet('messageBodies', [A, 'm2']);
    expect(body?._enc).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('Board minutes');
    expect(((await run('get', 'messages', { key: [A, 'm1'] })) as Row).subject).toBe('Edited');
    expect((await rawGet('messages', [A, 'm1']))?.subject).toBeUndefined();
  });

  it('replaces an account folder list atomically (the sync worker message)', async () => {
    await run('bulkPut', 'folders', {
      records: [
        { account: A, path: 'INBOX' },
        { account: A, path: 'Projects' },
      ],
    });
    const replace = (records: Row[]) =>
      run('transaction', undefined, {
        mode: 'rw',
        tables: ['folders'],
        operations: [
          {
            action: 'queryEqualsDelete',
            table: 'folders',
            payload: { index: 'account', value: A },
          },
          { action: 'bulkPut', table: 'folders', payload: { records } },
        ],
      });

    await expect(replace([{ account: A, path: 'INBOX' }, { account: A }])).rejects.toThrow();
    const kept = (await run('queryEquals', 'folders', { index: 'account', value: A })) as Row[];
    expect(kept.map((f) => f.path).sort()).toEqual(['INBOX', 'Projects']);

    await replace([
      { account: A, path: 'INBOX' },
      { account: A, path: 'Sent' },
    ]);
    const now = (await run('queryEquals', 'folders', { index: 'account', value: A })) as Row[];
    expect(now.map((f) => f.path).sort()).toEqual(['INBOX', 'Sent']);
    await run('clear', 'folders');
  });

  it('keeps drafts and the outbox when clearing the cache for recovery', async () => {
    await run('put', 'messages', { record: message('m1') });
    await run('put', 'drafts', { record: { account: A, id: 'd1', subject: 'keep me' } });
    await run('put', 'outbox', { record: { account: A, id: 'o1', status: 'pending' } });

    await run('clearCache');

    expect(await rawGet('messages', [A, 'm1'])).toBeUndefined();
    expect((await rawGet('drafts', [A, 'd1']))?.subject).toBe('keep me');
    expect((await rawGet('outbox', [A, 'o1']))?.status).toBe('pending');
  });
});

describe('crypto boot gate', () => {
  it('holds a sensitive write until the crypto config arrives, then seals it', async () => {
    vi.resetModules();
    const engine = await import('../../src/utils/db-engine');
    const exec = (action: string, table?: string, payload?: Row) =>
      engine.executeOperation({ action, table, payload });
    const dbName = 'idb-gate-test';
    await exec('init', undefined, { dbName, cryptoGate: true });

    // Non-sensitive writes (the worker probe, flags) are not held.
    await exec('put', 'meta', { record: { key: '__db_worker_probe__', updatedAt: 1 } });

    let settled = false;
    const write = exec('put', 'drafts', {
      record: { account: A, id: 'd1', subject: 'Draft from before unlock' },
    }).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    await exec('configureCrypto', undefined, { required: true, rawKey: KEY });
    await write;

    const onDisk = await rawGet('drafts', [A, 'd1'], dbName);
    expect(onDisk?._enc).toBeDefined();
    expect(onDisk?.subject).toBeUndefined();
  });
});
