import { beforeEach, describe, expect, it, vi } from 'vitest';

// Adding or removing a PGP key drops the cached bodies that were stored still
// encrypted. That used to read every cached body of the account at once; on a
// large account the database worker, which every tab and worker shares, was
// busy with it long enough that opening a message sat on a skeleton.
const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  reads: [] as number[],
  toArrayCalls: 0,
  deleted: [] as unknown[],
}));

const ARMOR = '-----BEGIN PGP MESSAGE-----\nhQEMA\n-----END PGP MESSAGE-----';

vi.mock('../../src/utils/db.js', () => {
  const key = (k: unknown) => JSON.stringify(k);
  const rangeFor = () => ({
    toArray: async () => {
      h.toArrayCalls += 1;
      return [...h.rows.values()];
    },
    primaryKeys: async () => [...h.rows.values()].map((r) => [r.account, r.id]),
  });
  return {
    db: {
      messageBodies: {
        where: () => ({ between: rangeFor, equals: () => ({ first: async () => null }) }),
        bulkGet: async (keys: unknown[]) => {
          h.reads.push(keys.length);
          return keys.map((k) => h.rows.get(key(k)));
        },
        bulkDelete: async (keys: unknown[]) => {
          for (const k of keys) {
            h.deleted.push(k);
            h.rows.delete(key(k));
          }
        },
      },
    },
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

import { invalidatePgpCachedBodies } from '../../src/stores/mailService';

const ME = 'me@example.com';

beforeEach(() => {
  h.rows.clear();
  h.reads = [];
  h.toArrayCalls = 0;
  h.deleted = [];
  for (let n = 0; n < 1000; n += 1) {
    const id = `m${n}`;
    const row: Record<string, unknown> = { account: ME, id, body: `<p>Hello ${n}</p>` };
    if (n % 10 === 0) Object.assign(row, { body: '', raw: ARMOR, pgpLocked: true });
    if (n % 10 === 5) row.body = ARMOR;
    h.rows.set(JSON.stringify([ME, id]), row);
  }
});

describe('dropping cached encrypted bodies after a key change', () => {
  it('reads a small batch at a time instead of every body at once', async () => {
    await invalidatePgpCachedBodies(ME);

    expect(h.toArrayCalls).toBe(0);
    expect(Math.max(...h.reads)).toBeLessThanOrEqual(50);
  });

  it('removes the encrypted ones and keeps the rest', async () => {
    await invalidatePgpCachedBodies(ME);

    expect(h.deleted).toHaveLength(200);
    expect(h.rows.size).toBe(800);
    expect([...h.rows.values()].every((r) => !r.pgpLocked && !String(r.body).includes('PGP'))).toBe(
      true,
    );
  });
});
