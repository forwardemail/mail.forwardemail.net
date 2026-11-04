/**
 * Database health for feedback reports.
 *
 * When the app has been open a long time it can stop using its cache: every
 * message downloads again and background sync stops filling it. The cause is
 * a database worker that stops answering, and nothing about it reached a
 * report: worker console output never lands in the captured logs. This
 * gathers what the report needs to tell the cases apart:
 *
 * - the db worker does not answer its ping: it is blocked outright;
 * - it answers, with requests in flight for minutes: IndexedDB is stuck;
 * - it answers, idle, while the sync worker has requests waiting: the sync
 *   worker's channel to it is dead.
 *
 * Each part has its own deadline, so a stuck database cannot hold up the
 * feedback form. Only request names, table names, counts and timings are
 * collected, never message content.
 */
import { dbClient, getDbWorkerHealth } from './db-worker-client.js';
import { sendSyncRequest } from './sync-worker-client.js';

const PART_DEADLINE_MS = 3000;

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'timed out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'timed out'>((resolve) => {
        timer = setTimeout(() => resolve('timed out'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface DbHealthReport {
  dbWorker: unknown;
  syncWorker: unknown;
  cachedBodies: number | string;
  pageUptimeMs: number;
}

export async function collectDbHealth(account: string): Promise<DbHealthReport> {
  const [dbWorker, syncWorker, cachedBodies] = await Promise.all([
    getDbWorkerHealth(PART_DEADLINE_MS).catch((error) => ({ error: describeError(error) })),
    withDeadline(
      sendSyncRequest('dbHealth', {}, { timeout: PART_DEADLINE_MS }),
      PART_DEADLINE_MS + 500,
    ).catch((error) => ({ error: describeError(error) })),
    withDeadline(
      Promise.resolve(dbClient.messageBodies.where('account').equals(account).count()),
      PART_DEADLINE_MS,
    ).catch((error) => `error: ${describeError(error)}`),
  ]);
  return {
    dbWorker,
    syncWorker,
    cachedBodies: cachedBodies as number | string,
    pageUptimeMs: Math.round(typeof performance !== 'undefined' ? performance.now() : 0),
  };
}
