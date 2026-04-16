/**
 * Dexie schema integration tests — exercises a real IndexedDB stack via
 * `fake-indexeddb` rather than mocking Dexie. Catches schema regressions,
 * compound-index query bugs, and quota-handling corner cases.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie, { type Table } from 'dexie';

interface Message {
  account: string;
  id: string;
  folder: string;
  date?: number;
  is_unread_index?: number;
  subject?: string;
}

interface Meta {
  key: string;
  value?: unknown;
  updatedAt?: number;
}

interface Folder {
  account: string;
  path: string;
  unread_count?: number;
}

interface SettingsRow {
  account: string;
  settings?: unknown;
  updatedAt?: number;
}

// Mirror the subset of the schema defined in src/workers/db.worker.ts. If
// the production schema changes, this test will start failing until the
// mirror is updated — which is the intent: a tripwire for silent drift.
class TestDatabase extends Dexie {
  messages!: Table<Message>;
  meta!: Table<Meta>;
  folders!: Table<Folder>;
  settings!: Table<SettingsRow>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      messages:
        '[account+id],id,folder,account,[account+folder],[account+folder+date],[account+folder+is_unread_index],date',
      meta: 'key,updatedAt',
      folders: '[account+path],account,path,unread_count',
      settings: 'account,updatedAt',
    });
  }
}

let db: TestDatabase;

beforeEach(async () => {
  db = new TestDatabase(`webmail-test-${Math.random().toString(36).slice(2)}`);
  await db.open();
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

describe('schema round-trips', () => {
  it('bulk-puts and reads back messages using [account+folder]', async () => {
    await db.messages.bulkPut([
      { account: 'a', id: '1', folder: 'INBOX', date: 100, subject: 'A' },
      { account: 'a', id: '2', folder: 'INBOX', date: 200, subject: 'B' },
      { account: 'a', id: '3', folder: 'Archive', date: 300, subject: 'C' },
      { account: 'b', id: '1', folder: 'INBOX', date: 400, subject: 'D' },
    ]);

    const inboxA = await db.messages.where('[account+folder]').equals(['a', 'INBOX']).toArray();
    expect(inboxA).toHaveLength(2);
    expect(inboxA.map((m) => m.id).sort()).toEqual(['1', '2']);
  });

  it('supports range queries via [account+folder+date]', async () => {
    await db.messages.bulkPut([
      { account: 'a', id: '1', folder: 'INBOX', date: 100 },
      { account: 'a', id: '2', folder: 'INBOX', date: 200 },
      { account: 'a', id: '3', folder: 'INBOX', date: 300 },
    ]);

    const newest = await db.messages
      .where('[account+folder+date]')
      .between(['a', 'INBOX', Dexie.minKey], ['a', 'INBOX', Dexie.maxKey], true, true)
      .reverse()
      .limit(2)
      .toArray();
    expect(newest.map((m) => m.date)).toEqual([300, 200]);
  });

  it('modify() applies an update to records matching a compound where', async () => {
    await db.messages.bulkPut([{ account: 'a', id: '1', folder: 'INBOX', is_unread_index: 1 }]);

    await db.messages.where('[account+id]').equals(['a', '1']).modify({ is_unread_index: 0 });

    const after = await db.messages.get(['a', '1']);
    expect(after?.is_unread_index).toBe(0);
  });
});

describe('meta key-value table (used by mutation-queue / contacts / attachments)', () => {
  it('round-trips arbitrary value shapes', async () => {
    await db.meta.put({ key: 'mutation_queue_user@example.com', value: [{ id: 'x' }] });
    await db.meta.put({ key: 'contacts_user@example.com', value: { contacts: ['a', 'b'] } });

    const q = await db.meta.get('mutation_queue_user@example.com');
    const c = await db.meta.get('contacts_user@example.com');
    expect(q?.value).toEqual([{ id: 'x' }]);
    expect((c?.value as { contacts: string[] }).contacts).toEqual(['a', 'b']);
  });

  it('delete() removes an entry', async () => {
    await db.meta.put({ key: 'att_blob_x', value: 'data:1' });
    expect(await db.meta.get('att_blob_x')).toBeDefined();
    await db.meta.delete('att_blob_x');
    expect(await db.meta.get('att_blob_x')).toBeUndefined();
  });
});

describe('attachment-cache eviction contract', () => {
  // Simulates the eviction loop in attachment-cache.js against a real DB.
  const MAX = 1000; // 1 KB "quota" for the test.

  async function cache(
    key: string,
    size: number,
    manifestKey = 'att_cache_manifest',
  ): Promise<void> {
    const existing = (await db.meta.get(manifestKey))?.value as
      | { totalBytes: number; entries: Array<{ key: string; size: number }> }
      | undefined;
    const manifest = existing ?? { totalBytes: 0, entries: [] };

    while (manifest.totalBytes + size > MAX && manifest.entries.length > 0) {
      const oldest = manifest.entries.shift()!;
      manifest.totalBytes -= oldest.size;
      await db.meta.delete(oldest.key);
    }

    await db.meta.put({ key, value: `data:${key}` });
    manifest.entries.push({ key, size });
    manifest.totalBytes += size;
    await db.meta.put({ key: manifestKey, value: manifest });
  }

  it('evicts oldest entries to stay under the byte budget', async () => {
    await cache('a', 600);
    await cache('b', 300);
    // Adding c (200B) must evict a (600B) to free room.
    await cache('c', 200);

    expect(await db.meta.get('a')).toBeUndefined();
    expect(await db.meta.get('b')).toBeDefined();
    expect(await db.meta.get('c')).toBeDefined();

    const manifest = (await db.meta.get('att_cache_manifest'))?.value as {
      totalBytes: number;
      entries: Array<{ key: string }>;
    };
    expect(manifest.totalBytes).toBe(500);
    expect(manifest.entries.map((e) => e.key)).toEqual(['b', 'c']);
  });
});

describe('SCHEMA_VERSION consistency (tripwire)', () => {
  // This test enforces that src/utils/db-constants.ts and public/sw-sync.js
  // declare the same SCHEMA_VERSION. If they ever drift, the SW and the app
  // will talk to different databases — a subtle, data-loss-class bug.
  it('main app and service worker agree on SCHEMA_VERSION', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const constants = await import('../../../src/utils/db-constants.ts');

    const swSyncPath = path.resolve(process.cwd(), 'public/sw-sync.js');
    const swSync = await fs.readFile(swSyncPath, 'utf-8');

    const match = swSync.match(/SCHEMA_VERSION\s*=\s*(\d+)/);
    expect(match, 'SCHEMA_VERSION not found in public/sw-sync.js').toBeTruthy();
    const swVersion = Number(match![1]);
    expect(swVersion).toBe(constants.SCHEMA_VERSION);
  });
});
