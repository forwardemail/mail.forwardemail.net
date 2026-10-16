/**
 * Results the db worker posts to the search worker must stay small enough to
 * structured-clone. WebKit kills the whole web process when one does not, and
 * on 2026-10-14 that happened on every launch for a user with a large
 * mailbox: the db worker died in MessagePort.postMessage right after an
 * IndexedDB read, the watchdog reloaded the window, and it died again.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeOperation } from '../../src/utils/db-engine';
import { MAX_INDEXED_BODY_CHARS } from '../../src/utils/search-body-text.js';

type Row = Record<string, unknown>;
const run = (action: string, table?: string, payload?: Row) =>
  executeOperation({ action, table, payload });

const ACCOUNT = 'reader@example.com';

// A newsletter as the sync worker caches it: the raw source, the rendered
// HTML with an inline image, the extracted text, and the attachment bytes.
function cachedBody(id: string, text: string, extra: Row = {}): Row {
  const image = `data:image/png;base64,${'iVBORw0KGgo'.repeat(20_000)}`;
  return {
    account: ACCOUNT,
    id,
    folder: 'INBOX',
    rawBody: `From: news@example.com\r\nSubject: Weekly\r\n\r\n${'A'.repeat(300_000)}`,
    body: `<html><body><img src="${image}"><p>${text}</p></body></html>`,
    textContent: text,
    attachments: [{ filename: 'report.pdf', size: 250_000, content: 'J'.repeat(250_000) }],
    cachedAt: 1,
    ...extra,
  };
}

describe('db-engine bodyTexts', () => {
  beforeAll(async () => {
    await run('init');
  });

  beforeEach(async () => {
    await run('clear', 'messageBodies');
    await run('clear', 'searchIndex');
  });

  it('returns only the searchable text, never the raw source or attachments', async () => {
    await run('bulkPut', 'messageBodies', {
      records: [
        cachedBody('m1', 'Quarterly figures attached'),
        cachedBody('m2', 'Lunch on Friday?'),
      ],
    });

    const texts = (await run('bodyTexts', 'messageBodies', {
      keys: [
        [ACCOUNT, 'm1'],
        [ACCOUNT, 'missing'],
        [ACCOUNT, 'm2'],
      ],
    })) as Row[];

    expect(texts).toEqual([
      { id: 'm1', text: 'Quarterly figures attached' },
      { id: 'm2', text: 'Lunch on Friday?' },
    ]);
    // Each record is over a megabyte stored; the answer is a few dozen bytes.
    expect(JSON.stringify(texts).length).toBeLessThan(200);
  });

  it('falls back to the HTML without its markup when there is no plain text', async () => {
    await run('put', 'messageBodies', {
      record: cachedBody('h1', 'ignored', {
        textContent: '',
        body:
          '<html><head><style>p{color:red}</style></head><body>' +
          `<img src="data:image/png;base64,${'Qk0'.repeat(50)}"><p>Your order has shipped</p></body></html>`,
      }),
    });
    const [entry] = (await run('bodyTexts', 'messageBodies', { keys: [[ACCOUNT, 'h1']] })) as Row[];
    expect(entry).toEqual({ id: 'h1', text: 'Your order has shipped' });
  });

  it('cuts long text to the indexed length', async () => {
    const long = 'word '.repeat(10_000);
    await run('put', 'messageBodies', { record: cachedBody('long', long) });
    const [entry] = (await run('bodyTexts', 'messageBodies', {
      keys: [[ACCOUNT, 'long']],
    })) as Array<{ text: string }>;
    expect(entry.text.length).toBe(MAX_INDEXED_BODY_CHARS);
    expect(long.startsWith(entry.text)).toBe(true);
  });
});

describe('db-engine search index read', () => {
  beforeAll(async () => {
    await run('init');
  });

  beforeEach(async () => {
    await run('clear', 'searchIndex');
  });

  // An index saved by an older build, which kept every body in full.
  function savedIndex(bodies: string[]): Row {
    return {
      key: 'messages_v1',
      account: ACCOUNT,
      data: bodies.map((body, i) => ({
        id: `m${i}`,
        folder: 'INBOX',
        subject: `Message ${i}`,
        from: 'news@example.com',
        labels: [],
        labelsText: '',
        body,
      })),
      sizeBytes: 0,
      updatedAt: 1,
    };
  }

  it('trims bodies saved in full by an older build, and saves the trimmed index', async () => {
    const huge = 'tracking pixel and markup '.repeat(40_000);
    await run('put', 'searchIndex', { record: savedIndex([huge, 'short note']) });

    const read = (await run('get', 'searchIndex', { key: [ACCOUNT, 'messages_v1'] })) as {
      data: Array<{ id: string; body: string; subject: string }>;
    };
    expect(read.data.map((e) => e.body.length)).toEqual([MAX_INDEXED_BODY_CHARS, 10]);
    expect(huge.startsWith(read.data[0].body)).toBe(true);
    expect(read.data[0].subject).toBe('Message 0');

    // Saved back, so the next launch reads the small copy.
    const again = (await run('get', 'searchIndex', { key: [ACCOUNT, 'messages_v1'] })) as {
      data: Array<{ body: string }>;
    };
    expect(again.data[0].body.length).toBe(MAX_INDEXED_BODY_CHARS);
  });

  it('leaves an index that is already small alone', async () => {
    const record = savedIndex(['hello', 'world']);
    await run('put', 'searchIndex', { record });
    const read = await run('get', 'searchIndex', { key: [ACCOUNT, 'messages_v1'] });
    expect(read).toEqual(record);
  });
});
