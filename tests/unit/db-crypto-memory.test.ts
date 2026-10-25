/**
 * App Lock reads and writes with bounded memory.
 *
 * On iOS the web content process, every worker included, is ended when it
 * crosses its memory limit; the user sees the app go blank and reload. With
 * App Lock on, opening or sealing a row holds several copies of it (base64,
 * ciphertext, plaintext bytes, JSON, the object), and openRecords and
 * sealRecords used to start every row of a result at once. A page of message
 * bodies (each with its raw message and attachments) opened that way, at
 * every launch, ended the page about ten seconds after it loaded, again and
 * again.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { executeOperation, sweepChunkSize } from '../../src/utils/db-engine';
import { fieldsArePlaintext, mapWithConcurrency } from '../../src/utils/db-crypto';

type Row = Record<string, unknown>;
const run = (action: string, table?: string, payload?: Row) =>
  executeOperation({ action, table, payload });

const A = 'a@example.com';
const KEY = new Uint8Array(32).fill(7);
const configure = (required: boolean, withKey: boolean) =>
  run('configureCrypto', undefined, { required, rawKey: withKey ? KEY : null });

const msg = (id: string, extra: Row = {}): Row => ({
  account: A,
  id,
  folder: 'INBOX',
  date: 1_700_000_000_000 + Number(id.replace(/\D/g, '') || 0),
  subject: `subject-${id}`,
  from: 'sender@example.com',
  labels: ['work'],
  ...extra,
});

const body = (id: string, extra: Row = {}): Row => ({
  account: A,
  id,
  folder: 'INBOX',
  body: `<p>body of ${id}</p>`,
  textContent: `body of ${id}`,
  attachments: [{ name: 'a.pdf', href: 'data:application/pdf;base64,AAAA' }],
  raw: 'Subject: x\r\n\r\n' + 'x'.repeat(1000),
  ...extra,
});

// Decrypts in flight at once, the most seen
function trackDecrypts() {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.decrypt.bind(subtle);
  let inFlight = 0;
  const stats = { max: 0, calls: 0 };
  vi.spyOn(subtle, 'decrypt').mockImplementation(async (...args) => {
    inFlight += 1;
    stats.calls += 1;
    stats.max = Math.max(stats.max, inFlight);
    try {
      // Let every other started decrypt reach this point too
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await original(...(args as Parameters<typeof original>));
    } finally {
      inFlight -= 1;
    }
  });
  return stats;
}

describe('mapWithConcurrency', () => {
  it('keeps at most the limit in flight and the results in order', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (n) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n));
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(max).toBe(2);
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });
});

describe('fieldsArePlaintext', () => {
  it('knows which fields are stored in the clear', () => {
    expect(fieldsArePlaintext('messages', ['labels'])).toBe(true);
    expect(fieldsArePlaintext('messages', ['id', 'folder', 'date', 'flags'])).toBe(true);
    expect(fieldsArePlaintext('messages', ['labels', 'subject'])).toBe(false);
    expect(fieldsArePlaintext('messageBodies', ['body'])).toBe(false);
    expect(fieldsArePlaintext('messages', [])).toBe(false);
  });
});

describe('db-engine reads under App Lock', () => {
  beforeAll(async () => {
    expect(await run('init')).toEqual({ success: true });
  });

  beforeEach(async () => {
    await configure(false, false);
    for (const table of ['messages', 'messageBodies', 'meta']) await run('clear', table);
    await configure(true, true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a folder of messages a few at a time, in order', async () => {
    await run('bulkPut', 'messages', {
      records: Array.from({ length: 40 }, (_, i) => msg(`m${i}`)),
    });
    const stats = trackDecrypts();
    const rows = (await run('queryEquals', 'messages', {
      index: '[account+folder]',
      value: [A, 'INBOX'],
    })) as Row[];
    expect(rows).toHaveLength(40);
    expect(rows.every((r) => typeof r.subject === 'string')).toBe(true);
    expect(stats.calls).toBe(40);
    expect(stats.max).toBeLessThanOrEqual(8);
  });

  it('opens message bodies one at a time', async () => {
    await run('bulkPut', 'messageBodies', {
      records: Array.from({ length: 6 }, (_, i) => body(`m${i}`)),
    });
    const stats = trackDecrypts();
    const rows = (await run('bulkGet', 'messageBodies', {
      keys: Array.from({ length: 6 }, (_, i) => [A, `m${i}`]),
    })) as Row[];
    expect(rows.map((r) => r.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    expect(stats.max).toBe(1);
  });

  it('tells which bodies are cached without returning them', async () => {
    await run('bulkPut', 'messageBodies', {
      records: [
        body('m1'),
        body('m2', { body: '-----BEGIN PGP MESSAGE-----\nabc' }),
        body('m3', {
          body: '',
          attachments: [],
          raw: '-----BEGIN PGP MESSAGE-----\nabc',
          pgpLocked: true,
        }),
        body('m4', { attachments: [], attachmentsResolved: true }),
      ],
    });
    const stats = trackDecrypts();
    const statuses = (await run('bodyStatuses', 'messageBodies', {
      keys: [
        [A, 'm1'],
        [A, 'missing'],
        [A, 'm2'],
        [A, 'm3'],
        [A, 'm4'],
      ],
    })) as Array<Row | null>;
    expect(statuses).toEqual([
      {
        hasBody: true,
        bodyIsPgp: false,
        attachmentCount: 1,
        attachmentsResolved: false,
        pgpLocked: false,
        rawIsPgp: false,
        pgpDecrypted: false,
      },
      null,
      expect.objectContaining({ hasBody: true, bodyIsPgp: true }),
      expect.objectContaining({ hasBody: false, pgpLocked: true, rawIsPgp: true }),
      expect.objectContaining({ hasBody: true, attachmentCount: 0, attachmentsResolved: true }),
    ]);
    // Nothing of the bodies themselves crosses back
    expect(JSON.stringify(statuses)).not.toContain('body of');
    expect(stats.max).toBe(1);
  });

  it('reads fields stored in the clear without decrypting the rows', async () => {
    await run('bulkPut', 'messages', {
      records: Array.from({ length: 10 }, (_, i) => msg(`m${i}`, { labels: [`l${i}`] })),
    });
    const stats = trackDecrypts();
    const rows = (await run('query', 'messages', {
      index: 'account',
      where: { op: 'equals', value: A },
      queryMode: 'fields',
      fields: ['labels'],
      options: { offset: 2, limit: 5 },
    })) as Row[];
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => Array.isArray(r.labels) && Object.keys(r).length === 1)).toBe(true);
    expect(stats.calls).toBe(0);

    // A sealed field still has to be opened
    const subjects = (await run('query', 'messages', {
      index: 'account',
      where: { op: 'equals', value: A },
      queryMode: 'fields',
      fields: ['subject'],
    })) as Row[];
    expect(subjects.map((r) => r.subject)).toContain('subject-m3');
    expect(stats.calls).toBe(10);
  });

  it('sweeps message bodies in small chunks and seals them all', async () => {
    expect(sweepChunkSize('messageBodies')).toBeLessThanOrEqual(4);
    expect(sweepChunkSize('searchIndex')).toBeLessThanOrEqual(4);
    expect(sweepChunkSize('messages')).toBe(200);

    await configure(false, false);
    await run('bulkPut', 'messageBodies', {
      records: Array.from({ length: 9 }, (_, i) => body(`m${i}`)),
    });
    await configure(true, true);
    const counts = (await run('reencryptAll', undefined, { direction: 'encrypt' })) as Record<
      string,
      number
    >;
    expect(counts.messageBodies).toBe(9);
    const opened = (await run('get', 'messageBodies', { key: [A, 'm8'] })) as Row;
    expect(opened.body).toBe('<p>body of m8</p>');
  });
});
