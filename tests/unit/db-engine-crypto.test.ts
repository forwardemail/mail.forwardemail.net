/**
 * db-engine at-rest encryption integration tests.
 *
 * Exercises the full dispatcher path (`executeOperation`) against
 * fake-indexeddb with the crypto layer configured, the same path the db
 * worker, the main-thread fallback, and the sync/search workers (via
 * MessageChannel) all share. Verifies that records are sealed ON DISK (read
 * back raw through Dexie) while every read path returns plaintext, that
 * update/modify never leak sealed fields, that writes fail closed while
 * locked, and that the reencryptAll sweeps convert existing data both ways.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import Dexie from 'dexie';
import { executeOperation } from '../../src/utils/db-engine';
import { DB_NAME } from '../../src/utils/db-constants';

type Row = Record<string, unknown>;
const run = (action: string, table?: string, payload?: Row) =>
  executeOperation({ action, table, payload });

const KEY = new Uint8Array(32).fill(9);

const configure = (required: boolean, withKey: boolean) =>
  run('configureCrypto', undefined, { required, rawKey: withKey ? KEY : null });

/** Read a row bypassing the engine's decryption, to inspect what's on disk. */
async function rawGet(table: string, key: unknown): Promise<Row | undefined> {
  const raw = new Dexie(DB_NAME);
  const stores = await raw.open();
  try {
    return (await stores.table(table).get(key)) as Row | undefined;
  } finally {
    raw.close();
  }
}

const msg = (id: string, extra: Row = {}): Row => ({
  account: 'a@example.com',
  id,
  folder: 'INBOX',
  date: 1700000000000,
  is_unread: true,
  subject: `subject-${id}`,
  from: 'sender@example.com',
  snippet: `snippet-${id}`,
  ...extra,
});

describe('db-engine with at-rest encryption', () => {
  beforeAll(async () => {
    expect(await run('init')).toEqual({ success: true });
  });

  beforeEach(async () => {
    await configure(false, false);
    await run('clear', 'messages');
    await run('clear', 'messageBodies');
    await run('clear', 'meta');
  });

  it('put stores a sealed record but get returns plaintext', async () => {
    await configure(true, true);
    await run('put', 'messages', { record: msg('m1') });

    const onDisk = await rawGet('messages', ['a@example.com', 'm1']);
    expect(onDisk?.subject).toBeUndefined();
    expect(onDisk?._enc).toBeDefined();
    expect(onDisk?.date).toBe(1700000000000); // queried index stays plaintext

    const viaEngine = (await run('get', 'messages', { key: ['a@example.com', 'm1'] })) as Row;
    expect(viaEngine.subject).toBe('subject-m1');
    expect(viaEngine._enc).toBeUndefined();
  });

  it('bulkPut + queryEquals (with sort/limit) round-trips sealed records', async () => {
    await configure(true, true);
    await run('bulkPut', 'messages', {
      records: [msg('m1', { date: 3 }), msg('m2', { date: 1 }), msg('m3', { date: 2 })],
    });

    const rows = (await run('queryEquals', 'messages', {
      index: '[account+folder]',
      value: ['a@example.com', 'INBOX'],
      options: { sortBy: 'date' },
    })) as Row[];
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm3', 'm1']); // plaintext sort key
    expect(rows.every((r) => typeof r.subject === 'string')).toBe(true);
  });

  it('update touching a sealed field re-seals instead of writing plaintext', async () => {
    await configure(true, true);
    await run('put', 'messages', { record: msg('m1') });

    const updated = await run('update', 'messages', {
      key: ['a@example.com', 'm1'],
      changes: { subject: 'rewritten', is_unread: false },
    });
    expect(updated).toBe(1);

    const onDisk = await rawGet('messages', ['a@example.com', 'm1']);
    expect(onDisk?.subject).toBeUndefined(); // not leaked as plaintext
    expect(onDisk?.is_unread).toBe(false);

    const viaEngine = (await run('get', 'messages', { key: ['a@example.com', 'm1'] })) as Row;
    expect(viaEngine.subject).toBe('rewritten');
    expect(viaEngine.from).toBe('sender@example.com'); // untouched sealed field kept
  });

  it('plaintext-only modify on sealed records keeps the envelope intact', async () => {
    await configure(true, true);
    await run('bulkPut', 'messages', { records: [msg('m1'), msg('m2')] });

    const count = await run('queryEqualsModify', 'messages', {
      index: '[account+folder]',
      value: ['a@example.com', 'INBOX'],
      changes: { is_unread: false },
    });
    expect(count).toBe(2);

    const rows = (await run('queryEquals', 'messages', {
      index: '[account+folder]',
      value: ['a@example.com', 'INBOX'],
    })) as Row[];
    expect(rows.every((r) => r.is_unread === false)).toBe(true);
    expect(rows.every((r) => typeof r.subject === 'string')).toBe(true);
  });

  it('fails closed: sensitive writes reject while required and locked', async () => {
    await configure(true, false);
    await expect(run('put', 'messages', { record: msg('m1') })).rejects.toThrow(/locked/i);
    await expect(
      run('bulkPut', 'messageBodies', {
        records: [{ account: 'a@example.com', id: 'm1', body: 'secret' }],
      }),
    ).rejects.toThrow(/locked/i);

    // Non-sensitive tables keep working while locked.
    await run('put', 'folders', { record: { account: 'a@example.com', path: 'INBOX' } });
    const folder = (await run('get', 'folders', { key: ['a@example.com', 'INBOX'] })) as Row;
    expect(folder.path).toBe('INBOX');
    await run('delete', 'folders', { key: ['a@example.com', 'INBOX'] });
  });

  it('reencryptAll seals existing plaintext data and decrypts it back', async () => {
    // Simulate a pre-App-Lock cache: plaintext writes.
    await run('bulkPut', 'messages', { records: [msg('m1'), msg('m2')] });
    await run('put', 'meta', {
      record: { key: 'contacts_a@example.com', value: [{ email: 'friend@x.com' }] },
    });
    await run('put', 'meta', { record: { key: 'app_lock_enabled', value: true, updatedAt: 1 } });

    // Enable App Lock → sweep.
    await configure(true, true);
    const counts = (await run('reencryptAll', undefined, { direction: 'encrypt' })) as Record<
      string,
      number
    >;
    expect(counts.messages).toBe(2);
    expect(counts.meta).toBe(1); // only the contacts_ record; flag untouched

    const onDisk = await rawGet('messages', ['a@example.com', 'm1']);
    expect(onDisk?.subject).toBeUndefined();
    expect(onDisk?._enc).toBeDefined();
    const flagOnDisk = await rawGet('meta', 'app_lock_enabled');
    expect(flagOnDisk?.value).toBe(true);

    // Reads stay plaintext throughout.
    const viaEngine = (await run('get', 'messages', { key: ['a@example.com', 'm1'] })) as Row;
    expect(viaEngine.subject).toBe('subject-m1');

    // Disable App Lock → decrypt sweep (key still present, required off).
    await configure(false, true);
    const decrypted = (await run('reencryptAll', undefined, { direction: 'decrypt' })) as Record<
      string,
      number
    >;
    expect(decrypted.messages).toBe(2);
    await configure(false, false);

    const plainAgain = await rawGet('messages', ['a@example.com', 'm1']);
    expect(plainAgain?.subject).toBe('subject-m1');
    expect(plainAgain?._enc).toBeUndefined();
    const contacts = (await run('get', 'meta', { key: 'contacts_a@example.com' })) as Row;
    expect(contacts.value).toEqual([{ email: 'friend@x.com' }]);
  });

  it('unsealForDisable drops server copies and decrypts what exists only on this device', async () => {
    const A = 'a@example.com';
    // A cache sealed by App Lock, mixing server copies and local-only data.
    await run('bulkPut', 'messages', { records: [msg('m1'), msg('m2')] });
    await run('put', 'messageBodies', { record: { account: A, id: 'm1', body: '<p>secret</p>' } });
    await run('put', 'folders', { record: { account: A, path: 'INBOX' } });
    await run('put', 'drafts', { record: { account: A, id: 'd1', subject: 'unsent draft' } });
    await run('put', 'outbox', {
      record: { account: A, id: 'o1', status: 'pending', subject: 'queued send' },
    });
    for (const record of [
      { key: `contacts_v2_${A}`, value: [{ email: 'friend@x.com' }] },
      { key: 'att_blob_m1_0', value: 'base64-attachment' },
      { key: 'att_cache_manifest', value: { totalBytes: 17, entries: [] } },
      { key: `mutation_queue_${A}`, value: [{ type: 'flag', id: 'm1' }] },
      { key: `saved_search_${A}_invoices`, value: { query: 'invoice' } },
      { key: 'app_lock_enabled', value: true, updatedAt: 1 },
    ]) {
      await run('put', 'meta', { record });
    }
    await configure(true, true);
    await run('reencryptAll', undefined, { direction: 'encrypt' });
    expect((await rawGet('drafts', [A, 'd1']))?._enc).toBeDefined();

    // Turn App Lock off: key still present, encryption no longer required.
    await configure(false, true);
    const result = (await run('unsealForDisable')) as {
      cleared: string[];
      decrypted: Record<string, number>;
    };
    await configure(false, false);

    expect(result.cleared).toEqual(expect.arrayContaining(['messages', 'messageBodies']));
    expect(result.decrypted).toMatchObject({ drafts: 1, outbox: 1, meta: 2 });
    // Server copies are gone, to be synced again.
    expect(await rawGet('messages', [A, 'm1'])).toBeUndefined();
    expect(await rawGet('messageBodies', [A, 'm1'])).toBeUndefined();
    expect(await rawGet('folders', [A, 'INBOX'])).toBeUndefined();
    expect(await rawGet('meta', `contacts_v2_${A}`)).toBeUndefined();
    expect(await rawGet('meta', 'att_blob_m1_0')).toBeUndefined();
    expect(await rawGet('meta', 'att_cache_manifest')).toBeUndefined();
    // Local-only data survives, as plaintext on disk.
    const draft = await rawGet('drafts', [A, 'd1']);
    expect(draft?.subject).toBe('unsent draft');
    expect(draft?._enc).toBeUndefined();
    expect((await rawGet('outbox', [A, 'o1']))?.subject).toBe('queued send');
    expect((await rawGet('meta', `mutation_queue_${A}`))?.value).toEqual([
      { type: 'flag', id: 'm1' },
    ]);
    expect((await rawGet('meta', `saved_search_${A}_invoices`))?.value).toEqual({
      query: 'invoice',
    });
    expect((await rawGet('meta', 'app_lock_enabled'))?.value).toBe(true);

    await run('clear', 'drafts');
    await run('clear', 'outbox');
  });

  it('unsealForDisable refuses to run without a key, leaving the sealed data alone', async () => {
    await configure(true, true);
    await run('put', 'drafts', { record: { account: 'a@example.com', id: 'd1', subject: 's' } });
    await configure(true, false);
    await expect(run('unsealForDisable')).rejects.toThrow(/requires the encryption key/);
    expect((await rawGet('drafts', ['a@example.com', 'd1']))?._enc).toBeDefined();
    await configure(false, false);
    await run('clear', 'drafts');
  });

  it('reencryptAll refuses to run without a key', async () => {
    await configure(true, false);
    await expect(run('reencryptAll', undefined, { direction: 'encrypt' })).rejects.toThrow(
      /requires the encryption key/,
    );
  });

  it('legacy plaintext rows stay readable after encryption is enabled (no migration cliff)', async () => {
    await run('put', 'messages', { record: msg('legacy') });
    await configure(true, true);

    const viaEngine = (await run('get', 'messages', { key: ['a@example.com', 'legacy'] })) as Row;
    expect(viaEngine.subject).toBe('subject-legacy');

    // New writes are sealed even while legacy rows coexist.
    await run('put', 'messages', { record: msg('fresh') });
    const freshOnDisk = await rawGet('messages', ['a@example.com', 'fresh']);
    expect(freshOnDisk?._enc).toBeDefined();
  });
});
