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

  try {
    const result = await executeOperation({ action, table, payload });
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
          const result = await executeOperation({ action: action!, table, payload });
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
