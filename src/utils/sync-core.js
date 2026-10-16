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

import { DB_NAME } from './db-constants.ts';
import { addFlagsBody, labelChangeBody, queuedToggleBody } from './message-changes.ts';

const META_STORE = 'meta';
const MUTATION_KEY_PREFIX = 'mutation_queue_';
const FETCH_TIMEOUT_MS = 30_000;
export const MUTATION_MAX_RETRIES = 5;
const MUTATION_BASE_BACKOFF_MS = 3000;
const MUTATION_MAX_BACKOFF_MS = 2 * 60 * 1000;

// ── Rules shared by every mutation queue processor ─────────────────────────
// Three processors drain the same queue record: the tab (mutation-queue.js),
// the service worker (public/sw-sync.js, which repeats these rules because it
// cannot import modules) and this file on desktop. They take turns through
// one cross-context lock, and each writes back only the entry it handled.

// Held for a whole run, so only one processor sends queued changes at a time.
export const MUTATION_RUN_LOCK = 'mutation-queue';
// Held for each read-modify-write of a queue record. Short, so adding a
// change never waits on a run's network requests.
export const MUTATION_WRITE_LOCK = 'mutation-queue-write';

/**
 * Run fn under a Web Lock shared by the tab, other tabs and the service
 * worker. Without the Web Locks API fn runs directly, as before.
 */
export function withNamedLock(name, fn) {
  const locks = typeof navigator !== 'undefined' ? navigator?.locks : null;
  if (locks && typeof locks.request === 'function') {
    return locks.request(name, () => fn());
  }
  return Promise.resolve().then(fn);
}

export function isExhaustedMutation(mutation) {
  return mutation?.status === 'failed' && (mutation.retryCount || 0) >= MUTATION_MAX_RETRIES;
}

// The message is gone from the server. A queued delete or move has nothing
// left to do, and neither has a flag or label change on it. Retrying would
// only fail again and end with the change reverted, which put deleted
// messages back in the list.
export function isGoneStatus(status) {
  return status === 404 || status === 410;
}

export function queueAccountFromKey(key) {
  return typeof key === 'string' && key.startsWith(MUTATION_KEY_PREFIX)
    ? key.slice(MUTATION_KEY_PREFIX.length)
    : '';
}

/**
 * The account a queued change belongs to. Every entry is stored under its
 * account's key, and newer entries also carry it in the payload. An entry
 * whose account cannot be told apart (the shared 'default' key with no
 * account of its own, or a payload naming another account than its key) is
 * not sent, since it could go out with the wrong account's credentials.
 */
export function resolveMutationAccount(mutation, queueAccount) {
  const own = mutation?.payload?.account;
  const keyed = queueAccount && queueAccount !== 'default' ? queueAccount : '';
  if (typeof own === 'string' && own && own !== 'default') {
    if (keyed && keyed !== own) return null;
    return own;
  }
  return keyed || null;
}

function mutationTarget(mutation) {
  const id = mutation?.payload?.messageId;
  return id === undefined || id === null || id === '' ? null : String(id);
}

function mutationBackoff(retryCount) {
  const delay = Math.min(
    MUTATION_BASE_BACKOFF_MS * Math.pow(2, retryCount),
    MUTATION_MAX_BACKOFF_MS,
  );
  return Math.floor(delay + delay * Math.random() * 0.2);
}

/**
 * What a processor writes back for one entry after trying it.
 *
 * outcome.result is 'done' (sent, or the message is gone), 'drop' (cannot be
 * sent by anyone), 'skip' (not tried now, for example no credentials) or
 * 'error'. Returns { remove: true } or the entry to store in its place.
 */
export function settleMutation(mutation, outcome, now = Date.now(), backoff = mutationBackoff) {
  const result = outcome?.result;
  if (result === 'done' || result === 'drop') return { id: mutation.id, remove: true, result };
  if (result === 'skip') return { id: mutation.id, remove: false, result, entry: mutation };
  const retryCount = (mutation.retryCount || 0) + 1;
  const error = outcome?.error;
  const entry = { ...mutation, retryCount };
  if (retryCount >= MUTATION_MAX_RETRIES) {
    entry.status = 'failed';
    entry.lastError = error?.message || (outcome?.status ? `HTTP ${outcome.status}` : 'Failed');
  } else {
    entry.status = 'pending';
    entry.nextRetryAt = now + backoff(retryCount);
  }
  return {
    id: mutation.id,
    remove: false,
    result: 'error',
    entry,
    exhausted: isExhaustedMutation(entry),
  };
}

/**
 * Apply one settled entry to a queue read fresh from storage. Entries other
 * processors or the tab added, changed or removed meanwhile are left alone,
 * and an entry no longer there (superseded by a newer change) stays gone.
 */
export function applySettled(queue, settled) {
  const list = Array.isArray(queue) ? queue : [];
  if (!list.some((m) => m?.id === settled.id)) return null;
  if (settled.remove) return list.filter((m) => m?.id !== settled.id);
  return list.map((m) => (m?.id === settled.id ? settled.entry : m));
}

/**
 * Try a queue's entries in order.
 *
 * Changes to one message go out in the order they were made: while an
 * earlier change to a message waits out its backoff or fails, later changes
 * to the same message wait too, so an older change cannot land after a newer
 * one and undo it.
 *
 * @param {Array} queue - snapshot of the queue, oldest first
 * @param {object} deps
 * @param {(m: object) => Promise<object>} deps.execute - returns an outcome
 * @param {(settled: object, m: object) => Promise<void>} deps.settle - writes one result back
 * @param {(m: object) => Promise<boolean>} [deps.isCurrent] - false skips an entry
 *   removed or changed since the snapshot was read
 * @param {() => boolean} [deps.canContinue] - false stops the run (offline)
 * @returns {Promise<Array>} the settled results
 */
export async function drainMutationQueue(
  queue,
  { execute, settle, isCurrent, canContinue, now = Date.now, backoff },
) {
  const waiting = new Set();
  const results = [];
  for (const mutation of Array.isArray(queue) ? queue : []) {
    if (canContinue && !canContinue()) break;
    if (!mutation || mutation.status === 'completed' || isExhaustedMutation(mutation)) continue;
    const target = mutationTarget(mutation);
    if (target && waiting.has(target)) continue;
    if (mutation.nextRetryAt && now() < mutation.nextRetryAt) {
      if (target) waiting.add(target);
      continue;
    }
    if (isCurrent && !(await isCurrent(mutation))) continue;

    let outcome;
    try {
      outcome = await execute(mutation);
    } catch (error) {
      outcome = isGoneStatus(Number(error?.status))
        ? { result: 'done', gone: true }
        : { result: 'error', error };
    }
    const settled = settleMutation(mutation, outcome, now(), backoff);
    if (!settled.remove && target) waiting.add(target);
    await settle(settled, mutation);
    results.push(settled);
  }
  return results;
}

// The outcome of a fetch made for a queued change.
function outcomeOfResponse(res) {
  if (res?.ok) return { result: 'done' };
  if (isGoneStatus(res?.status)) return { result: 'done', gone: true };
  return { result: 'error', status: res?.status };
}

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
   * Write one processed entry back to its queue record, in a single
   * transaction on a fresh read. Writing the whole snapshot back dropped
   * changes queued meanwhile and brought back ones already removed.
   */
  async function writeSettledMutation(key, settled) {
    let db;
    try {
      db = await openDb();
    } catch (err) {
      console.warn('[sync-core] Failed to open DB to write mutation queue', err);
      return;
    }

    if (!db.objectStoreNames.contains(META_STORE)) return;

    return withNamedLock(
      MUTATION_WRITE_LOCK,
      () =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(META_STORE, 'readwrite');
          const store = tx.objectStore(META_STORE);
          const req = store.get(key);
          req.onsuccess = () => {
            const record = req.result;
            const next = applySettled(record?.value, settled);
            if (next) store.put({ key, value: next, updatedAt: Date.now() });
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }),
    );
  }

  /**
   * Whether an entry is still queued as it was in the snapshot.
   */
  async function isStillQueued(key, mutation) {
    try {
      const db = await openDb();
      const record = await new Promise((resolve, reject) => {
        const req = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const current = (Array.isArray(record?.value) ? record.value : []).find(
        (m) => m?.id === mutation.id,
      );
      return Boolean(current) && current.status !== 'completed' && !isExhaustedMutation(current);
    } catch {
      return false;
    }
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
   * Same switch as executeMutationSW in sw-sync.js.
   */
  async function executeMutation(mutation, queueAccount) {
    const { type, payload, apiBase, authHeader } = mutation;
    if (!resolveMutationAccount(mutation, queueAccount)) {
      console.warn('[sync-core] Dropping a queued change with no account', mutation.id);
      return { result: 'drop' };
    }
    // The tab sends these with the account's current credentials.
    if (!apiBase || !authHeader) return { result: 'skip' };

    const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader,
    };

    const msgPath = `/v1/messages/${encodeURIComponent(payload.messageId)}`;

    switch (type) {
      // isUnread and isStarred are the state before the toggle (see
      // queuedToggleBody): a queued "mark as read" was sent as "mark as unread"
      case 'toggleRead':
      case 'toggleStar': {
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(queuedToggleBody(type, payload)),
        });
        return outcomeOfResponse(res);
      }

      case 'addFlags': {
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(addFlagsBody(payload.flags, payload.add)),
        });
        return outcomeOfResponse(res);
      }

      case 'move': {
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ folder: payload.targetFolder }),
        });
        return outcomeOfResponse(res);
      }

      case 'delete': {
        const path = payload.permanent ? `${msgPath}?permanent=1` : msgPath;
        const res = await fetchWithTimeout(`${base}${path}`, {
          method: 'DELETE',
          headers,
        });
        return outcomeOfResponse(res);
      }

      case 'label': {
        const res = await fetchWithTimeout(`${base}${msgPath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(labelChangeBody(payload.labels, payload.previousLabels)),
        });
        return outcomeOfResponse(res);
      }

      default:
        return { result: 'drop' };
    }
  }

  /**
   * Process all mutation queues from IndexedDB.
   * Mirrors processMutationsSW in sw-sync.js.
   */
  async function processMutations() {
    return withNamedLock(MUTATION_RUN_LOCK, async () => {
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
        const queueAccount = queueAccountFromKey(key);
        await drainMutationQueue(queue, {
          execute: (mutation) => executeMutation(mutation, queueAccount),
          isCurrent: (mutation) => isStillQueued(key, mutation),
          settle: async (settled) => {
            try {
              await writeSettledMutation(key, settled);
            } catch (err) {
              console.warn('[sync-core] Failed to write mutation queue', err);
            }
          },
        });
      }

      await postMessage({ type: 'mutationQueueProcessed' });
    });
  }

  return { processMutations };
}
