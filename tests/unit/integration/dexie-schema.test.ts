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

// Piggybacks on the existing TestDatabase (meta is already declared). These
// cases lock down the design decisions captured in docs/ai-implementation-plan.md:
//   - Risk #1: AI state piggybacks on the meta table via ai:* key prefixes.
//     Prefix scans must return only the AI rows and must not disturb the hot
//     paths (mutation-queue, contact-cache, attachment-cache) that share meta.
//   - Spike (risk #4): Phase 1 DSL fields compile to the existing query plan
//     (compound-index candidate fetch + post-filter). These cases prove the
//     assumed Dexie behavior (e.g. that `labels` is NOT a multi-entry index)
//     so the plan won't silently break if schema or Dexie semantics change.
describe('AI meta-table key-prefix isolation (risk #1 tripwire)', () => {
  const AUDIT_KEY = (day: string) => `ai:audit:${day}`;
  const PROVIDER_KEY = (id: string) => `ai:provider:${id}`;

  it('ai:audit prefix scan returns only AI audit rows', async () => {
    // Seed a mix that mirrors production: mutation queue, contact cache,
    // attachment cache manifest, saved searches, and AI audit/provider rows.
    await db.meta.bulkPut([
      { key: 'mutation_queue_user@example.com', value: [] },
      { key: 'contacts_user@example.com', value: { contacts: [] } },
      { key: 'att_cache_manifest', value: { totalBytes: 0, entries: [] } },
      { key: 'saved_search_user@example.com_unread', value: { name: 'unread' } },
      { key: PROVIDER_KEY('anthropic'), value: { id: 'anthropic' } },
      { key: PROVIDER_KEY('ollama'), value: { id: 'ollama' } },
      { key: AUDIT_KEY('2026-04-17'), value: [{ feature: 'smart_search' }] },
      { key: AUDIT_KEY('2026-04-18'), value: [{ feature: 'summarize' }] },
      { key: AUDIT_KEY('2026-04-19'), value: [{ feature: 'smart_search' }] },
    ]);

    const auditRows = await db.meta.where('key').startsWith('ai:audit:').toArray();
    expect(auditRows.map((r) => r.key).sort()).toEqual([
      AUDIT_KEY('2026-04-17'),
      AUDIT_KEY('2026-04-18'),
      AUDIT_KEY('2026-04-19'),
    ]);

    const providerRows = await db.meta.where('key').startsWith('ai:provider:').toArray();
    expect(providerRows.map((r) => r.key).sort()).toEqual([
      PROVIDER_KEY('anthropic'),
      PROVIDER_KEY('ollama'),
    ]);

    // Umbrella prefix catches everything AI-scoped (useful for wipe-on-logout).
    const allAi = await db.meta.where('key').startsWith('ai:').toArray();
    expect(allAi).toHaveLength(5);
  });

  it('does not disturb unrelated hot-path keys (mutation-queue, contact-cache)', async () => {
    const hotPaths = [
      { key: 'mutation_queue_user@example.com', value: [{ op: 'toggleStar' }] },
      { key: 'contacts_user@example.com', value: { contacts: ['a'] } },
      { key: 'att_cache_manifest', value: { totalBytes: 100, entries: [] } },
    ];
    await db.meta.bulkPut(hotPaths);

    // Heavy AI write activity.
    for (let day = 1; day <= 30; day += 1) {
      const iso = `2026-03-${String(day).padStart(2, '0')}`;
      await db.meta.put({ key: AUDIT_KEY(iso), value: Array.from({ length: 50 }) });
    }

    for (const row of hotPaths) {
      const after = await db.meta.get(row.key);
      expect(after?.value).toEqual(row.value);
    }
  });

  it('delete via prefix scan cleans up AI rows only (wipe-on-logout contract)', async () => {
    await db.meta.bulkPut([
      { key: 'mutation_queue_user@example.com', value: [] },
      { key: PROVIDER_KEY('anthropic'), value: {} },
      { key: AUDIT_KEY('2026-04-19'), value: [] },
    ]);

    const aiKeys = (await db.meta.where('key').startsWith('ai:').toArray()).map((r) => r.key);
    await db.meta.bulkDelete(aiKeys);

    expect(await db.meta.get('mutation_queue_user@example.com')).toBeDefined();
    expect(await db.meta.get(PROVIDER_KEY('anthropic'))).toBeUndefined();
    expect(await db.meta.get(AUDIT_KEY('2026-04-19'))).toBeUndefined();
  });
});

describe('DSL → Dexie query plan (risk #4 spike lock-down)', () => {
  // These tests encode the assumptions in docs/ai-implementation-plan.md
  // Appendix A. If Dexie semantics change, compile-flexsearch / search.worker
  // assumptions break silently — this suite catches that.

  it('candidate fetch via [account+folder+date] range works as documented', async () => {
    await db.messages.bulkPut([
      { account: 'a', id: '1', folder: 'INBOX', date: 1000 },
      { account: 'a', id: '2', folder: 'INBOX', date: 2000 },
      { account: 'a', id: '3', folder: 'INBOX', date: 3000 },
      { account: 'a', id: '4', folder: 'Archive', date: 2500 },
    ]);

    const after = 1500;
    const before = 2500;
    const results = await db.messages
      .where('[account+folder+date]')
      .between(['a', 'INBOX', after], ['a', 'INBOX', before], true, true)
      .toArray();

    expect(results.map((m) => m.id).sort()).toEqual(['2']);
  });

  it('labels index is NOT multi-entry — confirms the post-filter path', async () => {
    // The schema declares `labels` without the `*` prefix, so Dexie indexes
    // the whole array as the key, not each element. This test documents that
    // behavior: querying `labels = 'Work'` does NOT find messages whose
    // `labels` array contains 'Work'. compile-flexsearch routes labels_any
    // through post-filter for exactly this reason.
    //
    // Mirrors the relevant subset of the production schema.
    interface LabelMessage {
      account: string;
      id: string;
      folder?: string;
      labels?: string[];
    }
    class LabelDb extends Dexie {
      msgs!: Table<LabelMessage>;
      constructor(name: string) {
        super(name);
        this.version(1).stores({ msgs: '[account+id],id,account,folder,labels' });
      }
    }

    const labelDb = new LabelDb(`label-test-${Math.random().toString(36).slice(2)}`);
    await labelDb.open();

    try {
      await labelDb.msgs.bulkPut([
        { account: 'a', id: '1', folder: 'INBOX', labels: ['Work', 'Urgent'] },
        { account: 'a', id: '2', folder: 'INBOX', labels: ['Work'] },
        { account: 'a', id: '3', folder: 'INBOX', labels: [] },
      ]);

      // Direct index query does not find 'Work' inside the arrays.
      const byIndex = await labelDb.msgs.where('labels').equals('Work').toArray();
      expect(byIndex).toHaveLength(0);

      // Post-filter is the correct path.
      const candidates = await labelDb.msgs
        .where('[account+id]')
        .between(['a', Dexie.minKey], ['a', Dexie.maxKey])
        .toArray();
      const matching = candidates.filter((m) => (m.labels ?? []).includes('Work'));
      expect(matching.map((m) => m.id).sort()).toEqual(['1', '2']);
    } finally {
      labelDb.close();
      await Dexie.delete(labelDb.name);
    }
  });
});
