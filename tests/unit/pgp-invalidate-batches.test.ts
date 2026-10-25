import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Adding or removing a PGP key drops the cached bodies that were stored still
// encrypted. That used to read every cached body of the account at once; on a
// large account the database worker, which every tab and worker shares, was
// busy with it long enough that opening a message sat on a skeleton.
const h = vi.hoisted(() => ({
  bodies: new Map<string, Record<string, unknown>>(),
  messages: new Map<string, Record<string, unknown>>(),
  reads: [] as number[],
  toArrayCalls: 0,
  deleted: [] as unknown[],
}));

const ARMOR = '-----BEGIN PGP MESSAGE-----\nhQEMA\n-----END PGP MESSAGE-----';

// An in-memory stand-in for the db worker's tables, keyed [account, id]. A
// range over [account+id] only returns that account's rows, as IndexedDB does.
vi.mock('../../src/utils/db.js', async () => {
  // what the db worker works out for each body (db-engine bodyStatuses)
  const { cachedBodyStatus } = await import('../../src/workers/sync-pure.ts');
  const key = (k: unknown) => JSON.stringify(k);
  const table = (rows: Map<string, Record<string, unknown>>, { countReads = false } = {}) => ({
    where: (index: string) => ({
      between: (lower: unknown[]) => {
        expect(index).toBe('[account+id]');
        const inAccount = () => [...rows.values()].filter((r) => r.account === lower[0]);
        return {
          toArray: async () => {
            h.toArrayCalls += 1;
            return inAccount();
          },
          primaryKeys: async () => inAccount().map((r) => [r.account, r.id]),
        };
      },
      equals: () => ({ first: async () => null }),
    }),
    bulkGet: async (keys: unknown[]) => {
      if (countReads) h.reads.push(keys.length);
      return keys.map((k) => rows.get(key(k)));
    },
    bodyStatuses: async (keys: unknown[]) => {
      h.reads.push(keys.length);
      return keys.map((k) => cachedBodyStatus(rows.get(key(k)) as never));
    },
    bulkDelete: async (keys: unknown[]) => {
      for (const k of keys) {
        h.deleted.push(k);
        rows.delete(key(k));
      }
    },
    update: async (k: unknown, changes: Record<string, unknown>) => {
      const row = rows.get(key(k));
      if (!row) return 0;
      rows.set(key(k), { ...row, ...changes });
      return 1;
    },
  });
  return {
    db: { messageBodies: table(h.bodies, { countReads: true }), messages: table(h.messages) },
  };
});
vi.mock('../../src/utils/storage.js', () => ({ Local: { get: vi.fn(() => null) } }));
vi.mock('../../src/utils/remote.js', () => ({ Remote: { request: vi.fn() } }));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: vi.fn(),
  refreshSyncWorkerPgpKeys: vi.fn(),
  requestPgpDecryption: vi.fn(),
  unlockPgpKey: vi.fn(),
  requestParsing: vi.fn(),
}));
vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: vi.fn(() => ({ stage: vi.fn(), end: vi.fn() })),
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));

import { forgetPgpPlaintext, invalidatePgpCachedBodies } from '../../src/stores/mailService';
import { messages as messageList } from '../../src/stores/messageStore';

const ME = 'me@example.com';
const OTHER = 'other@example.com';
const k = (account: string, id: string) => JSON.stringify([account, id]);
const body = (id: string, account = ME) => h.bodies.get(k(account, id));
const message = (id: string, account = ME) => h.messages.get(k(account, id));

beforeEach(() => {
  h.bodies.clear();
  h.messages.clear();
  h.reads = [];
  h.toArrayCalls = 0;
  h.deleted = [];
  for (let n = 0; n < 1000; n += 1) {
    const id = `m${n}`;
    const row: Record<string, unknown> = { account: ME, id, body: `<p>Hello ${n}</p>` };
    if (n % 10 === 0) Object.assign(row, { body: '', raw: ARMOR, pgpLocked: true });
    if (n % 10 === 5) row.body = ARMOR;
    h.bodies.set(k(ME, id), row);
  }
});

describe('dropping cached encrypted bodies after a key change', () => {
  it('reads a small batch at a time instead of every body at once', async () => {
    await invalidatePgpCachedBodies(ME);

    expect(h.toArrayCalls).toBe(0);
    expect(Math.max(...h.reads)).toBeLessThanOrEqual(50);
  });

  it('removes the encrypted ones and keeps the rest', async () => {
    const dropped = await invalidatePgpCachedBodies(ME);

    expect(h.deleted).toHaveLength(200);
    expect(dropped).toHaveLength(200);
    expect(h.bodies.size).toBe(800);
    expect(
      [...h.bodies.values()].every((r) => !r.pgpLocked && !String(r.body).includes('PGP')),
    ).toBe(true);
  });

  it("leaves another account's bodies alone", async () => {
    h.bodies.set(k(OTHER, 'x1'), { account: OTHER, id: 'x1', body: ARMOR });
    await invalidatePgpCachedBodies(ME, { includeDecrypted: true });
    expect(body('x1', OTHER)).toBeDefined();
  });
});

// Removing the saved keys has to remove what they decrypted too: the bodies
// and protected subjects of encrypted messages stayed on this device, readable
// after the keys were gone.
describe('forgetting what the removed keys decrypted', () => {
  beforeEach(() => {
    // decrypted by the sync worker or the reader, marked so
    body('m1')!.pgpDecrypted = true;
    for (let n = 0; n < 1200; n += 1) {
      const id = `m${n}`;
      h.messages.set(k(ME, id), { account: ME, id, subject: `Subject ${n}` });
    }
    // decrypted with its subject protected; the placeholder was kept
    Object.assign(message('m1')!, {
      pgpEncrypted: true,
      subject: 'Real subject',
      pgpOuterSubject: '...',
    });
    // decrypted by a build that marked neither the body nor the placeholder
    Object.assign(message('m2')!, { pgpEncrypted: true, subject: 'Older real subject' });
    // past the first batch of messages read, with a decrypted body
    Object.assign(message('m1102')!, { pgpEncrypted: true });
    h.bodies.set(k(ME, 'm1102'), { account: ME, id: 'm1102', body: '<p>plain</p>' });
    // another account's decrypted message
    h.messages.set(k(OTHER, 'm1'), {
      account: OTHER,
      id: 'm1',
      pgpEncrypted: true,
      subject: 'Theirs',
      pgpOuterSubject: '...',
    });
    h.bodies.set(k(OTHER, 'm1'), {
      account: OTHER,
      id: 'm1',
      body: '<p>theirs</p>',
      pgpDecrypted: true,
    });
  });

  it('keeps decrypted bodies when only re-trying the encrypted ones (a key was added)', async () => {
    await invalidatePgpCachedBodies(ME);
    expect(body('m1')).toBeDefined();
    expect(body('m2')).toBeDefined();
  });

  it('drops the decrypted bodies, marked or flagged on their message, and the encrypted ones', async () => {
    await forgetPgpPlaintext(ME);
    for (const id of ['m1', 'm2', 'm1102', 'm0', 'm5']) expect(body(id)).toBeUndefined();
    expect(body('m3')).toBeDefined();
    expect(h.deleted).toHaveLength(203);
    expect(Math.max(...h.reads)).toBeLessThanOrEqual(50);
  });

  it("puts the server's subject back, or lets the next sync do it", async () => {
    messageList.set([
      { id: 'm1', subject: 'Real subject', pgpEncrypted: true },
      { id: 'm3', subject: 'Subject 3' },
    ] as never);

    const changed = await forgetPgpPlaintext(ME);

    expect(message('m1')).toMatchObject({
      subject: '...',
      pgpOuterSubject: null,
      pgpEncrypted: true,
    });
    // sync keeps a subject over the server's only while the row is flagged
    expect(message('m2')).toMatchObject({ pgpEncrypted: false });
    expect(message('m3')).toEqual({ account: ME, id: 'm3', subject: 'Subject 3' });
    // the list on screen follows
    expect((get(messageList) as Array<{ subject: string }>).map((m) => m.subject)).toEqual([
      '...',
      'Subject 3',
    ]);
    // every message whose text or subject changed, for the search index
    expect(changed.map((m) => m.id).sort()).toEqual(
      expect.arrayContaining(['m0', 'm1', 'm1102', 'm2', 'm5']),
    );
    expect(changed.find((m) => m.id === 'm1')?.subject).toBe('...');
    expect(changed.some((m) => m.id === 'm3')).toBe(false);
  });

  it("leaves another account's messages alone", async () => {
    await forgetPgpPlaintext(ME);
    expect(message('m1', OTHER)?.subject).toBe('Theirs');
    expect(body('m1', OTHER)).toBeDefined();
  });

  it('does nothing without an account', async () => {
    expect(await forgetPgpPlaintext('')).toEqual([]);
    expect(await invalidatePgpCachedBodies('', { includeDecrypted: true })).toEqual([]);
    expect(h.deleted).toHaveLength(0);
  });
});
