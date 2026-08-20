import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { getAuthHeader } from './auth';
import { config } from '../config';
import { writable } from 'svelte/store';
import { warn } from './logger.ts';
import { isOnline } from './network-status';
import { swReadyWithTimeout, isTauri } from './platform.js';
import { exponentialBackoff } from './backoff.js';

/**
 * Offline Mutation Queue
 *
 * Queues mail operations (toggle read, star, move, delete, label) when offline.
 * Processes the queue when connectivity is restored.
 *
 * Mutations are stored in the IndexedDB `meta` table under a per-account key
 * to avoid requiring a schema migration.
 *
 * Each mutation has:
 *   id:        unique identifier
 *   type:      'toggleRead' | 'toggleStar' | 'move' | 'delete' | 'label'
 *   payload:   operation-specific data (messageId, folder, flags, etc.)
 *   status:    'pending' | 'processing' | 'failed'
 *   retryCount: number of attempts
 *   createdAt: timestamp
 */

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 3000;
const MAX_BACKOFF_MS = 2 * 60 * 1000;
const QUEUE_KEY_PREFIX = 'mutation_queue_';

export const mutationQueueCount = writable(0);
export const mutationQueueProcessing = writable(false);

let processing = false;

// Serializes every read-modify-write of the queue's single meta row. The queue
// has three concurrent writers (queueMutation appends, processMutationQueue's
// final prune, clearCompletedMutations). Without this, an append that lands
// between another writer's read and write is silently dropped.
let queueWriteLock = Promise.resolve();

function withQueueLock(fn) {
  const run = queueWriteLock.then(fn, fn);
  queueWriteLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

function getAccount() {
  return Local.get('email') || 'default';
}

function queueKey(account) {
  return `${QUEUE_KEY_PREFIX}${account}`;
}

function calculateBackoff(retryCount) {
  return exponentialBackoff(retryCount, { baseMs: BASE_BACKOFF_MS, maxMs: MAX_BACKOFF_MS });
}

/**
 * Read the mutation queue for the current account from IndexedDB.
 */
async function readQueue(account) {
  try {
    const record = await db.meta.get(queueKey(account || getAccount()));
    return Array.isArray(record?.value) ? record.value : [];
  } catch {
    return [];
  }
}

/**
 * Return the set of message IDs with pending/in-flight mutations for an
 * account. Callers use this to avoid clobbering an optimistic change
 * whose server round-trip hasn't completed (e.g., during sync reconciliation).
 */
export async function getQueuedMessageIds(account) {
  const queue = await readQueue(account);
  const ids = new Set();
  for (const m of queue) {
    if (m.status === 'completed') continue;
    const id = m.payload?.messageId;
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Write the mutation queue for the current account to IndexedDB.
 */
async function writeQueue(account, queue) {
  const key = queueKey(account || getAccount());
  await db.meta.put({ key, value: queue, updatedAt: Date.now() });
  mutationQueueCount.set(queue.filter((m) => m.status !== 'completed').length);
}

/**
 * Queue a mutation for offline processing.
 * The caller is responsible for applying the optimistic update to stores/IDB.
 *
 * @param {string} type - Mutation type
 * @param {Object} payload - Operation-specific payload
 * @returns {Promise<Object>} The queued mutation record
 */
export async function queueMutation(type, payload) {
  const account = getAccount();

  // Store auth info so the SW can process mutations when the tab is closed
  let authHeader = '';
  try {
    authHeader = getAuthHeader({ required: false });
  } catch {
    // Auth not available — SW will skip if header is missing
  }

  const mutation = {
    id: `mut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    payload: { ...payload, account },
    status: 'pending',
    retryCount: 0,
    createdAt: Date.now(),
    apiBase: config.apiBase || '',
    authHeader,
  };
  await withQueueLock(async () => {
    const queue = await readQueue(account);
    queue.push(mutation);
    await writeQueue(account, queue);
  });

  // If online, process immediately; otherwise register Background Sync
  if (isOnline()) {
    processMutationQueue();
  } else {
    registerBackgroundSync();
  }

  return mutation;
}

/**
 * Register a Background Sync tag so the SW can process mutations
 * even if the tab is closed when connectivity returns.
 *
 * Uses a timeout so this doesn't hang forever on platforms where the
 * SW never activates (Chrome OS Flex, storage quota issues, etc.)
 */
function registerBackgroundSync() {
  if (!('serviceWorker' in navigator)) return;
  swReadyWithTimeout(5000)
    .then((reg) => {
      if (reg?.sync) {
        return reg.sync.register('mutation-queue');
      }
    })
    .catch((err) => {
      warn('[mutation-queue] Background Sync registration failed', err);
    });
}

/**
 * Execute a single mutation against the API.
 * Returns true on success, false on failure.
 */
async function executeMutation(mutation) {
  const { type, payload } = mutation;

  switch (type) {
    case 'toggleRead': {
      const flags = payload.isUnread
        ? (payload.flags || []).filter((f) => f !== '\\Seen')
        : [...(payload.flags || []), '\\Seen'];
      await Remote.request(
        'MessageUpdate',
        { flags, folder: payload.folder },
        { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(payload.messageId)}` },
      );
      return true;
    }

    case 'toggleStar': {
      const flags = payload.isStarred
        ? (payload.flags || []).filter((f) => f !== '\\Flagged')
        : [...(payload.flags || []), '\\Flagged'];
      await Remote.request(
        'MessageUpdate',
        { flags, folder: payload.folder },
        { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(payload.messageId)}` },
      );
      return true;
    }

    case 'move': {
      await Remote.request(
        'MessageUpdate',
        { folder: payload.targetFolder },
        { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(payload.messageId)}` },
      );
      return true;
    }

    case 'delete': {
      let path = `/v1/messages/${encodeURIComponent(payload.messageId)}`;
      if (payload.permanent) path += '?permanent=1';
      await Remote.request('MessageDelete', {}, { method: 'DELETE', pathOverride: path });
      return true;
    }

    case 'label': {
      await Remote.request(
        'MessageUpdate',
        { labels: payload.labels },
        { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(payload.messageId)}` },
      );
      return true;
    }

    default:
      warn('[mutation-queue] Unknown mutation type:', type);
      return false;
  }
}

/**
 * Process the mutation queue — execute pending mutations in order.
 */
export async function processMutationQueue() {
  if (processing || !isOnline()) return;

  const account = getAccount();
  const queue = await readQueue(account);
  if (!queue.length) return;

  processing = true;
  mutationQueueProcessing.set(true);
  let queuedDuringRun = false;

  try {
    let modified = false;
    for (const mutation of queue) {
      if (!isOnline()) break;
      if (mutation.status === 'completed') continue;
      if (mutation.status === 'failed' && mutation.retryCount >= MAX_RETRIES) continue;

      // Check backoff timing
      if (mutation.nextRetryAt && Date.now() < mutation.nextRetryAt) continue;

      mutation.status = 'processing';
      modified = true;

      try {
        await executeMutation(mutation);
        mutation.status = 'completed';
      } catch (err) {
        mutation.retryCount = (mutation.retryCount || 0) + 1;
        if (mutation.retryCount >= MAX_RETRIES) {
          mutation.status = 'failed';
          mutation.lastError = err?.message || 'Unknown error';
        } else {
          mutation.status = 'pending';
          mutation.nextRetryAt = Date.now() + calculateBackoff(mutation.retryCount);
        }
      }
    }

    if (modified) {
      const permanentlyFailed = queue.filter(
        (m) => m.status === 'failed' && m.retryCount >= MAX_RETRIES,
      );
      // Reconcile against a FRESH read under the lock: the snapshot above is
      // stale by now (network round-trips), and writing it back verbatim would
      // drop any mutation enqueued while we were processing. Keep every entry
      // still in the stored queue, applying our processed statuses by id.
      const processedById = new Map(queue.map((m) => [m.id, m]));
      await withQueueLock(async () => {
        const current = await readQueue(account);
        const remaining = current
          .map((m) => processedById.get(m.id) || m)
          .filter(
            (m) =>
              m.status !== 'completed' && !(m.status === 'failed' && m.retryCount >= MAX_RETRIES),
          );
        // Mutations enqueued mid-run were invisible to this pass's snapshot,
        // and their own processMutationQueue trigger hit the `processing`
        // guard. Re-run below so they don't wait for the 30s sweep.
        queuedDuringRun = remaining.some(
          (m) =>
            !processedById.has(m.id) &&
            m.status === 'pending' &&
            (!m.nextRetryAt || m.nextRetryAt <= Date.now()),
        );
        await writeQueue(account, remaining);
      });

      if (permanentlyFailed.length && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('mutation-queue-failed', {
            detail: { count: permanentlyFailed.length },
          }),
        );
        dispatchPermanentFailures(permanentlyFailed);
      }
    }
  } finally {
    processing = false;
    mutationQueueProcessing.set(false);
  }

  if (queuedDuringRun) {
    await processMutationQueue();
  }
}

/**
 * Fire one 'mailbox-mutation-permanently-failed' event per exhausted
 * mutation, carrying the full record (type + payload) so a listener can
 * revert the optimistic local change it can no longer expect to land.
 */
function dispatchPermanentFailures(mutations) {
  if (typeof window === 'undefined') return;
  for (const mutation of mutations) {
    window.dispatchEvent(
      new CustomEvent('mailbox-mutation-permanently-failed', { detail: mutation }),
    );
  }
}

/**
 * Sweep the queue for mutations already marked 'failed' with retries
 * exhausted that this tab didn't just process itself — e.g. the service
 * worker's Background Sync processor gave up while no tab was open. Those
 * entries sit in the shared queue record untouched (sw-sync.js doesn't have
 * store/Dexie access to revert them), so the next time a tab is around to
 * read the queue, it needs to notice and revert them too.
 *
 * Safe to call anytime: reads a fresh snapshot under the write lock, so it
 * can't race processMutationQueue's own prune of the same entries.
 */
export async function reconcilePermanentlyFailedMutations() {
  const account = getAccount();
  let permanentlyFailed = [];
  await withQueueLock(async () => {
    const queue = await readQueue(account);
    permanentlyFailed = queue.filter((m) => m.status === 'failed' && m.retryCount >= MAX_RETRIES);
    if (!permanentlyFailed.length) return;
    const remaining = queue.filter((m) => !(m.status === 'failed' && m.retryCount >= MAX_RETRIES));
    await writeQueue(account, remaining);
  });
  if (permanentlyFailed.length) {
    dispatchPermanentFailures(permanentlyFailed);
  }
}

/**
 * Get count of pending mutations for the current account.
 */
export async function getMutationQueueCount() {
  const queue = await readQueue();
  const count = queue.filter((m) => m.status !== 'completed').length;
  mutationQueueCount.set(count);
  return count;
}

/**
 * Clear all completed/failed mutations for the current account.
 */
export async function clearCompletedMutations() {
  const account = getAccount();
  await withQueueLock(async () => {
    const queue = await readQueue(account);
    const remaining = queue.filter((m) => m.status === 'pending' || m.status === 'processing');
    await writeQueue(account, remaining);
  });
}

/**
 * Initialize the mutation queue processor.
 * Call once on app startup. Listens for online events.
 */
let initialized = false;
export function initMutationQueue() {
  if (initialized) return;
  initialized = true;

  // Process queue when coming back online
  window.addEventListener('online', () => {
    processMutationQueue();
  });

  // Listen for SW Background Sync completion to refresh counts, and revert
  // any mutation the SW gave up on while this tab (or any tab) was closed —
  // the SW has no store/Dexie access to do that itself.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'mutationQueueProcessed') {
        getMutationQueueCount();
        reconcilePermanentlyFailedMutations();
      }
    });
  }

  // Process any pending mutations on startup, and revert anything left
  // behind 'failed' from a previous session (e.g. the SW's Background Sync
  // exhausted retries while the app wasn't running to react to it).
  reconcilePermanentlyFailedMutations();
  if (isOnline()) {
    processMutationQueue();
  }

  // On Tauri (mobile/desktop), SW Background Sync is unavailable.
  // Process queued mutations when the app resumes from background.
  if (isTauri) {
    import('./background-service.js').then(({ onResume }) => {
      onResume(() => {
        if (navigator.onLine && !processing) {
          processMutationQueue();
        }
      });
    });
  }

  // Periodic check for mutations with expired backoff
  setInterval(() => {
    if (isOnline() && !processing) {
      processMutationQueue();
    }
  }, 30000);
}
