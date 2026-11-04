/**
 * The feedback report's database section has to come back even when the
 * database is the thing that is stuck: that is exactly when it is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const parts = vi.hoisted(() => ({
  health: (): Promise<unknown> => Promise.resolve({}),
  syncHealth: (): Promise<unknown> => Promise.resolve({}),
  count: (): Promise<number> => Promise.resolve(0),
  countedFor: [] as unknown[],
}));

vi.mock('../../src/utils/db-worker-client.js', () => ({
  getDbWorkerHealth: () => parts.health(),
  dbClient: {
    messageBodies: {
      where: (index: string) => ({
        equals: (value: unknown) => {
          parts.countedFor.push([index, value]);
          return { count: () => parts.count() };
        },
      }),
    },
  },
}));

vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: () => parts.syncHealth(),
}));

const never = () => new Promise<never>(() => {});

describe('collectDbHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    parts.countedFor = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports each part, counting cached bodies for the account on screen', async () => {
    parts.health = () =>
      Promise.resolve({
        engine: 'worker',
        answered: true,
        inFlightCount: 1,
        inFlight: [{ action: 'put', table: 'messageBodies', source: 'sync', ageMs: 61_000 }],
      });
    parts.syncHealth = () => Promise.resolve({ pending: 4, stalled: true, reconnects: 2 });
    parts.count = () => Promise.resolve(12);
    const { collectDbHealth } = await import('../../src/utils/db-health');

    const report = await collectDbHealth('support@example.com');

    expect(parts.countedFor).toEqual([['account', 'support@example.com']]);
    expect(report.cachedBodies).toBe(12);
    expect(report.dbWorker).toMatchObject({
      answered: true,
      inFlight: [{ action: 'put', table: 'messageBodies', ageMs: 61_000 }],
    });
    expect(report.syncWorker).toMatchObject({ pending: 4, stalled: true, reconnects: 2 });
  });

  it('comes back within its deadline when the database never answers', async () => {
    parts.health = () => Promise.resolve({ engine: 'worker', answered: false, waitedMs: 3000 });
    parts.syncHealth = never;
    parts.count = never;
    const { collectDbHealth } = await import('../../src/utils/db-health');

    const pending = collectDbHealth('support@example.com');
    await vi.advanceTimersByTimeAsync(4000);
    const report = await pending;

    expect(report.cachedBodies).toBe('timed out');
    expect(report.syncWorker).toBe('timed out');
    expect(report.dbWorker).toMatchObject({ answered: false });
  });

  it('keeps the other parts when one of them throws', async () => {
    parts.health = () => Promise.resolve({ engine: 'main-thread' });
    parts.syncHealth = () => Promise.reject(new Error('Missing auth header for sync worker'));
    parts.count = () => Promise.resolve(3);
    const { collectDbHealth } = await import('../../src/utils/db-health');

    const report = await collectDbHealth('support@example.com');

    expect(report.syncWorker).toEqual({ error: 'Missing auth header for sync worker' });
    expect(report.cachedBodies).toBe(3);
    expect(report.dbWorker).toEqual({ engine: 'main-thread' });
  });
});
