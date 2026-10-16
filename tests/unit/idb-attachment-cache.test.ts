/**
 * Attachment blob cache: keys, size accounting, concurrent saves and
 * per-account cleanup, against the real engine on fake-indexeddb.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ email: 'alice@example.com' }));

vi.mock('../../src/utils/storage', () => ({
  Local: { get: (key: string) => (key === 'email' ? session.email : null), set: vi.fn() },
}));

vi.mock('../../src/utils/db', async () => {
  const { executeOperation } = await import('../../src/utils/db-engine');
  await executeOperation({ action: 'init' });
  const exec = (action: string, table: string, payload: Record<string, unknown> = {}) =>
    executeOperation({ action, table, payload });
  return {
    db: {
      meta: {
        get: (key: unknown) => exec('get', 'meta', { key }),
        put: (record: unknown) => exec('put', 'meta', { record }),
        delete: (key: unknown) => exec('delete', 'meta', { key }),
        toArray: () => exec('toArray', 'meta'),
        clear: () => exec('clear', 'meta'),
        where: (index: string) => ({
          startsWith: (value: string) => ({
            delete: () =>
              exec('query', 'meta', {
                index,
                where: { op: 'startsWith', value },
                queryMode: 'delete',
              }),
          }),
        }),
      },
    },
  };
});

import { db } from '../../src/utils/db';
import {
  cacheAttachmentBlob,
  getCachedAttachmentBlob,
  clearAttachmentCacheForAccount,
  dataUrlByteLength,
} from '../../src/utils/attachment-cache.js';

type Row = Record<string, unknown>;
type Manifest = { totalBytes: number; entries: Row[] };

const toDataUrl = (bytes: Uint8Array, mime = 'application/pdf') =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const bytesOf = (length: number, fill: number) => new Uint8Array(length).fill(fill);

async function manifest(): Promise<Manifest> {
  const record = (await db.meta.get('att_cache_manifest')) as Row | undefined;
  return (record?.value as Manifest) || { totalBytes: 0, entries: [] };
}

describe('attachment blob cache', () => {
  beforeAll(() => {
    session.email = 'alice@example.com';
  });

  beforeEach(async () => {
    session.email = 'alice@example.com';
    await db.meta.clear();
  });

  it('keeps two attachments with the same filename in one message apart', async () => {
    const first = toDataUrl(bytesOf(300, 1));
    const second = toDataUrl(bytesOf(500, 2));
    // Scanners commonly name every page "scan.pdf".
    await cacheAttachmentBlob('msg-1', { filename: 'scan.pdf', partId: '2' }, first);
    await cacheAttachmentBlob('msg-1', { filename: 'scan.pdf', partId: '3' }, second);

    expect(await getCachedAttachmentBlob('msg-1', { filename: 'scan.pdf', partId: '2' })).toBe(
      first,
    );
    expect(await getCachedAttachmentBlob('msg-1', { filename: 'scan.pdf', partId: '3' })).toBe(
      second,
    );
  });

  it('counts the decoded size even when the server reported none', async () => {
    const dataUrl = toDataUrl(bytesOf(1234, 7));
    await cacheAttachmentBlob('msg-2', 'report.pdf', dataUrl, 0);

    const m = await manifest();
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].size).toBe(1234);
    expect(m.totalBytes).toBe(1234);
  });

  it('skips an attachment over the per-file limit even with no size hint', async () => {
    const big = toDataUrl(bytesOf(6 * 1024 * 1024, 3));
    await cacheAttachmentBlob('msg-3', 'video.mov', big, 0);
    expect(await getCachedAttachmentBlob('msg-3', 'video.mov')).toBeNull();
    expect((await manifest()).entries).toHaveLength(0);
  });

  it('records every entry when several downloads finish at once', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        cacheAttachmentBlob(`msg-${i}`, `invoice-${i}.pdf`, toDataUrl(bytesOf(100 + i, i))),
      ),
    );
    const m = await manifest();
    expect(m.entries.map((e) => e.filename).sort()).toEqual(
      Array.from({ length: 6 }, (_, i) => `invoice-${i}.pdf`),
    );
    expect(m.totalBytes).toBe(6 * 100 + (0 + 1 + 2 + 3 + 4 + 5));
  });

  it('clears one account without touching another', async () => {
    await cacheAttachmentBlob('msg-a', 'a.pdf', toDataUrl(bytesOf(100, 1)));
    session.email = 'bob@example.com';
    await cacheAttachmentBlob('msg-b', 'b.pdf', toDataUrl(bytesOf(200, 2)));

    const removed = await clearAttachmentCacheForAccount('alice@example.com');
    expect(removed).toBe(1);

    expect(await getCachedAttachmentBlob('msg-b', 'b.pdf')).not.toBeNull();
    session.email = 'alice@example.com';
    expect(await getCachedAttachmentBlob('msg-a', 'a.pdf')).toBeNull();
    const m = await manifest();
    expect(m.entries.map((e) => e.filename)).toEqual(['b.pdf']);
    expect(m.totalBytes).toBe(200);
  });

  it('measures base64 data URLs by their decoded bytes', () => {
    expect(dataUrlByteLength(toDataUrl(bytesOf(1, 0)))).toBe(1);
    expect(dataUrlByteLength(toDataUrl(bytesOf(2, 0)))).toBe(2);
    expect(dataUrlByteLength(toDataUrl(bytesOf(3, 0)))).toBe(3);
    expect(dataUrlByteLength('data:text/plain,hello%20world')).toBe(11);
  });
});
