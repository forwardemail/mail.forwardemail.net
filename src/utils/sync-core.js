/**
 * Forward Email – Sync Core (platform-agnostic)
 *
 * Dependency-injected factory that provides the mutation-queue processing
 * logic shared by sync-shim.js (Tauri desktop) and potentially mobile
 * platforms in the future.
 *
 * This mirrors the mutation processing logic in public/sw-sync.js but
 * accepts injected `postMessage`, `fetch`, and `indexedDB` so it can
 * run outside a Service Worker context.
 *
 * @param {object} deps
 * @param {(payload: object) => Promise<void>} deps.postMessage
 * @param {typeof globalThis.fetch} deps.fetch
 * @param {IDBFactory} deps.indexedDB
 * @returns {{ processMutations: () => Promise<void> }}
 */

const DB_NAME = 'webmail-cache-v1';
const META_STORE = 'meta';
const MUTATION_KEY_PREFIX = 'mutation_queue_';
const FETCH_TIMEOUT_MS = 30_000;
const MUTATION_MAX_RETRIES = 5;

export function createSyncCore({ postMessage, fetch, indexedDB }) {
  /**
   * Open the IndexedDB database using the injected factory.
   */
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);

      req.onsuccess = () => resolve(req.result);

      req.onerror = () => {
        console.error('[sync-core] IndexedDB open failed:', req.error);
        reject(req.error || new Error('IndexedDB open failed'));
      };

      req.onblocked = () => {
        console.warn('[sync-core] IndexedDB open blocked');
      };
    });
  }

  /**
   * Read all mutation queue entries from the meta store.
   * Returns an array of { key, queue } objects.
   */
  async function readAllMutationQueues() {
    let db;
    try {
      db = await openDb();
    } catch (err) {
      console.warn('[sync-core] Failed to open DB for mutation queues', err);
      return [];
    }

    if (!db.objectStoreNames.contains(META_STORE)) return [];

    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const store = tx.objectStore(META_STORE);
      const results = [];
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(results);
          return;
        }

        const record = cursor.value;
        if (
          record?.key &&
          typeof record.key === 'string' &&
          record.key.startsWith(MUTATION_KEY_PREFIX) &&
          Array.isArray(record.value)
        ) {
          results.push({ key: record.key, queue: record.value });
        }

        cursor.continue();
      };

      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Write a mutation queue back to the meta store.
   */
  async function writeMutationQueue(key, queue) {
    let db;
    try {
      db = await openDb();
    } catch (err) {
      console.warn('[sync-core] Failed to open DB to write mutation queue', err);
      return;
    }

    if (!db.objectStoreNames.contains(META_STORE)) return;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      const store = tx.objectStore(META_STORE);
      store.put({ key, value: queue, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Fetch with a timeout to prevent hung requests from blocking the queue.
   */
  function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  /**
   * Execute a single mutation via fetch.
   * Same 5-case switch as executeMutationSW in sw-sync.js.
   */
  async function executeMutation(mutation) {
    const { type, payload, apiBase, authHeader } = mutation;
    if (!apiBase || !authHeader) return false;

    const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader,
    };

    const msgPath = `/v1/messages/${encodeURIComponent(payload.messageId)}`;

    switch (type) {
      case 'toggleRead': {
        const flags = payload.isUnread
          ? (payload.flags || []).filter((f) => f !== '\\Seen')
          : [...(payload.flags || []), '\\Seen'];
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ flags, folder: payload.folder }),
        });
        return res.ok;
      }

      case 'toggleStar': {
        const flags = payload.isStarred
          ? (payload.flags || []).filter((f) => f !== '\\Flagged')
          : [...(payload.flags || []), '\\Flagged'];
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ flags, folder: payload.folder }),
        });
        return res.ok;
      }

      case 'move': {
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ folder: payload.targetFolder }),
        });
        return res.ok;
      }

      case 'delete': {
        const path = payload.permanent ? `${msgPath}?permanent=1` : msgPath;
        const res = await fetchWithTimeout(`${base}${path}`, {
          method: 'DELETE',
          headers,
        });
        return res.ok;
      }

      case 'label': {
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ labels: payload.labels }),
        });
        return res.ok;
      }

      default:
        return false;
    }
  }

  /**
   * Process all mutation queues from IndexedDB.
   * Mirrors processMutationsSW in sw-sync.js.
   */
  async function processMutations() {
    let queues;
    try {
      queues = await readAllMutationQueues();
    } catch (err) {
      console.warn('[sync-core] Failed to read mutation queues', err);
      await postMessage({
        type: 'dbError',
        error: err.message,
        errorName: err.name,
        recoverable: true,
      });
      return;
    }

    for (const { key, queue } of queues) {
      let modified = false;
      for (const mutation of queue) {
        if (mutation.status === 'completed') continue;
        if (mutation.status === 'failed' && mutation.retryCount >= MUTATION_MAX_RETRIES) continue;
        if (mutation.nextRetryAt && Date.now() < mutation.nextRetryAt) continue;

        mutation.status = 'processing';
        modified = true;

        try {
          const ok = await executeMutation(mutation);
          mutation.status = ok ? 'completed' : 'failed';
          if (!ok) mutation.retryCount = (mutation.retryCount || 0) + 1;
        } catch {
          mutation.retryCount = (mutation.retryCount || 0) + 1;
          mutation.status = mutation.retryCount >= MUTATION_MAX_RETRIES ? 'failed' : 'pending';
        }
      }

      if (modified) {
        const remaining = queue.filter((m) => m.status !== 'completed');
        try {
          await writeMutationQueue(key, remaining);
        } catch (err) {
          console.warn('[sync-core] Failed to write mutation queue', err);
        }
      }
    }

    await postMessage({ type: 'mutationQueueProcessed' });
  }

  return { processMutations };
}
