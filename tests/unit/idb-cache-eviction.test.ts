/**
 * Quota eviction on a large cache.
 *
 * evictOldest used to load every cached body of the account into memory
 * (toArray) to sort it, and every message row too; with a cache of several
 * gigabytes that alone could exhaust the renderer. Run it against the real
 * engine behind an in-process stand-in for the db worker and record every
 * response the "worker" sends back: none may carry more than one page of
 * rows, and no message body may cross the worker boundary at all.
 */
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({
  maxRowsPerResponse: 0,
  bodyCrossedBoundary: false,
  record(result: unknown) {
    if (!Array.isArray(result)) return;
    wire.maxRowsPerResponse = Math.max(wire.maxRowsPerResponse, result.length);
    if (result.some((row) => row && typeof row === 'object' && 'body' in row)) {
      wire.bodyCrossedBoundary = true;
    }
  },
}));

vi.mock('../../src/workers/db.worker.ts?worker&inline', () => {
  class FakeDbWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    onmessageerror: unknown = null;
    private listeners = new Set<(event: { data: unknown }) => void>();
    constructor() {
      setTimeout(() => this.emit({ type: 'booted' }), 0);
    }
    addEventListener(_t: string, fn: (event: { data: unknown }) => void) {
      this.listeners.add(fn);
    }
    removeEventListener(_t: string, fn: (event: { data: unknown }) => void) {
      this.listeners.delete(fn);
    }
    emit(data: unknown) {
      for (const fn of this.listeners) fn({ data });
      this.onmessage?.({ data });
    }
    postMessage(message: { id: number; action: string; table?: string; payload?: unknown }) {
      import('../../src/utils/db-engine').then(({ executeOperation }) =>
        executeOperation({
          action: message.action,
          table: message.table,
          payload: message.payload as Record<string, unknown>,
        }).then(
          (result) => {
            wire.record(result);
            this.emit({ id: message.id, ok: true, result });
          },
          (error: Error) => this.emit({ id: message.id, ok: false, error: error.message }),
        ),
      );
    }
    terminate() {}
  }
  return { default: FakeDbWorker };
});

vi.mock('../../src/utils/storage.js', () => ({
  Local: { get: (key: string) => (key === 'email' ? 'alice@example.com' : null), set: vi.fn() },
}));

import { markBootstrapReady } from '../../src/utils/bootstrap-ready.js';
import { dbClient, initDbClient } from '../../src/utils/db-worker-client.js';
import { cacheManager } from '../../src/utils/cache-manager.js';

const A = 'alice@example.com';
const DAY = 24 * 60 * 60 * 1000;

function bodiesFor(folder: string, count: number, ageDays: number) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    account: A,
    id: `${folder.toLowerCase()}-${String(i).padStart(4, '0')}`,
    folder,
    updatedAt: now - ageDays * DAY - i * 1000,
    body: `<html><body><p>${'Lorem ipsum dolor sit amet. '.repeat(40)}</p></body></html>`,
    textContent: 'Lorem ipsum dolor sit amet. '.repeat(40),
  }));
}

describe('cacheManager.evictOldest on a large cache', () => {
  beforeAll(async () => {
    markBootstrapReady();
    await initDbClient();
  });

  beforeEach(async () => {
    await dbClient.messageBodies.clear();
    await dbClient.messages.clear();
    // 1,150 cached bodies across folders, plus another account's bodies.
    await dbClient.messageBodies.bulkPut([
      ...bodiesFor('INBOX', 700, 1),
      ...bodiesFor('Archive', 400, 30),
      ...bodiesFor('Spam', 50, 2),
      { account: 'bob@example.com', id: 'spam-x', folder: 'Spam', updatedAt: 0, body: 'b' },
    ]);
    await dbClient.messages.bulkPut(
      Array.from({ length: 450 }, (_, i) => ({
        account: A,
        id: `m-${String(i).padStart(4, '0')}`,
        folder: 'INBOX',
        updatedAt: 1_700_000_000_000 + i,
        subject: `Subject ${i}`,
      })),
    );
    wire.maxRowsPerResponse = 0;
    wire.bodyCrossedBoundary = false;
  });

  it('pages through the cache instead of loading it whole, and evicts Spam first', async () => {
    const result = await cacheManager.evictOldest(20_000);

    expect(wire.maxRowsPerResponse).toBeLessThanOrEqual(200);
    expect(wire.bodyCrossedBoundary).toBe(false);

    expect(result.freedBytes).toBeGreaterThanOrEqual(20_000);
    expect(result.evicted.bodies).toBeGreaterThan(0);
    const spamLeft = await dbClient.messageBodies
      .where('[account+folder]')
      .equals([A, 'Spam'])
      .count();
    expect(spamLeft).toBe(50 - result.evicted.bodies);
    expect(
      await dbClient.messageBodies.where('[account+folder]').equals([A, 'INBOX']).count(),
    ).toBe(700);
    // Another account's cache is never touched.
    expect(await dbClient.messageBodies.get(['bob@example.com', 'spam-x'])).toBeDefined();
  });

  it('falls back to the oldest message rows, still a page at a time', async () => {
    await dbClient.messageBodies.clear();
    const result = await cacheManager.evictOldest(5_000);

    expect(wire.maxRowsPerResponse).toBeLessThanOrEqual(200);
    expect(result.evicted.messages).toBeGreaterThan(0);
    // The oldest rows went first.
    expect(await dbClient.messages.get([A, 'm-0000'])).toBeUndefined();
    expect(await dbClient.messages.get([A, 'm-0449'])).toBeDefined();
  });
});
