/**
 * Dedicated Database Worker
 *
 * Thin worker shell around the shared database engine. The engine itself
 * (the Dexie/IndexedDB connection + the `executeOperation` dispatcher) lives in
 * src/utils/db-engine.ts so the exact same logic can ALSO run on the main
 * thread when WebKitGTK stalls IndexedDB inside Web Workers under the tauri://
 * scheme (see the capability-probe fallback in db-worker-client.js). This file
 * is only the worker message glue: it forwards postMessage requests (from the
 * main thread and from MessageChannel ports opened by the search/sync workers)
 * to executeOperation and posts the results back.
 */

import {
  executeOperation,
  type DbWorkerMessage,
  type DbWorkerResponse,
} from '../utils/db-engine.ts';

// Connected ports for other workers (search, sync) — kept alive for the
// lifetime of the worker so their MessageChannel handlers aren't GC'd.
const connectedPorts = new Map<string, MessagePort>();

// ── Health ──────────────────────────────────────────────────────────────────
//
// Every request is tracked while it runs, and the slow ones are kept, so a
// feedback report can say what the worker is doing when the app has gone slow.
// Callers give up on the database after 1.5s (reader cache reads) or 60s (the
// sync worker), and from the outside a busy worker and a wedged one look the
// same: the cache is simply skipped. 'health' is answered here, ahead of the
// engine, so it still answers while every table request is stuck.
const SLOW_OP_MS = 2_000;
const MAX_SLOW_OPS = 20;
const bootedAt = Date.now();
let nextOpId = 0;
let served = 0;
const inFlight = new Map<
  number,
  { action: string; table?: string | null; source: string; startedAt: number }
>();
const slowOps: Array<{
  action: string;
  table?: string | null;
  source: string;
  ms: number;
  at: string;
  failed: boolean;
}> = [];

async function runTracked(op: Parameters<typeof executeOperation>[0], source: string) {
  const opId = ++nextOpId;
  const startedAt = Date.now();
  inFlight.set(opId, { action: op.action, table: op.table, source, startedAt });
  let failed = false;
  try {
    return await executeOperation(op);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    inFlight.delete(opId);
    served += 1;
    const ms = Date.now() - startedAt;
    if (ms >= SLOW_OP_MS) {
      slowOps.push({
        action: op.action,
        table: op.table,
        source,
        ms,
        at: new Date(startedAt).toISOString(),
        failed,
      });
      if (slowOps.length > MAX_SLOW_OPS) slowOps.shift();
      console.warn(
        `[db.worker] slow ${op.action}${op.table ? ` ${op.table}` : ''} from ${source}: ` +
          `${ms}ms, ${inFlight.size} other requests in flight`,
      );
    }
  }
}

function healthSnapshot() {
  const now = Date.now();
  return {
    uptimeMs: now - bootedAt,
    served,
    // Oldest first: the head of this list is what the rest are waiting behind.
    inFlight: [...inFlight.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, 15)
      .map(({ action, table, source, startedAt }) => ({
        action,
        table,
        source,
        ageMs: now - startedAt,
      })),
    inFlightCount: inFlight.size,
    slowOps: [...slowOps],
  };
}

/**
 * Handle messages from the main thread
 */
self.onmessage = async (event: MessageEvent<DbWorkerMessage>) => {
  const { id, action, table, payload, type } = event.data || {};

  if (!action) {
    if (type !== 'connectPort') {
      console.warn('[db.worker] Ignoring message without action', event.data);
    }
    return;
  }

  if (action === 'health') {
    self.postMessage({ id, ok: true, result: healthSnapshot() } as DbWorkerResponse);
    return;
  }

  try {
    const result = await runTracked({ action, table, payload }, 'main');
    self.postMessage({ id, ok: true, result } as DbWorkerResponse);
  } catch (error) {
    console.error('[db.worker] Operation failed:', action, error);
    self.postMessage({
      id,
      ok: false,
      error: (error as Error).message,
      errorName: (error as Error).name,
      errorCode: (error as { code?: string | number }).code,
    } as DbWorkerResponse);
  }
};

/**
 * Handle MessageChannel port connections from other workers
 */
self.addEventListener('message', (event: MessageEvent<DbWorkerMessage>) => {
  if (event.data?.type === 'connectPort') {
    const { workerId } = event.data;
    const port = (event as MessageEvent & { ports: MessagePort[] }).ports[0];

    if (port && workerId) {
      // A worker that reconnects (for example after its own restart) gets a
      // fresh channel; close the old one so it does not linger.
      const previous = connectedPorts.get(workerId);
      if (previous && previous !== port) previous.close();
      connectedPorts.set(workerId, port);

      port.onmessage = async (portEvent: MessageEvent<DbWorkerMessage>) => {
        const { id, action, table, payload } = portEvent.data;

        try {
          const result = await runTracked({ action: action!, table, payload }, workerId);
          port.postMessage({ id, ok: true, result } as DbWorkerResponse);
        } catch (error) {
          console.error('[db.worker] Port operation failed:', action, error);
          port.postMessage({
            id,
            ok: false,
            error: (error as Error).message,
            errorName: (error as Error).name,
            errorCode: (error as { code?: string | number }).code,
          } as DbWorkerResponse);
        }
      };

      port.start();
    }
  }
});

// Do not auto-init; wait for explicit init with dbName override from main thread.

// Boot heartbeat: signal that the worker script has loaded and its message
// handlers are wired up, BEFORE the (potentially slow) IndexedDB open in
// `init`. The client uses this to distinguish "worker never started" (fall
// back to the main-thread engine immediately) from "worker alive but
// IndexedDB init is slow" (keep waiting). Has no `id`, so the client's
// request handler ignores it; a dedicated boot listener consumes it.
self.postMessage({ type: 'booted' });
