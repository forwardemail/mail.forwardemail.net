import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { getAuthHeader } from './auth';
import { config } from '../config';
import { writable } from 'svelte/store';
import { warn } from './logger.ts';
import { swReadyWithTimeout } from './platform.js';
import { isOnline } from './network-status';

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

function getAccount() {
  return Local.get('email') || 'default';
}

function queueKey(account) {
  return `${QUEUE_KEY_PREFIX}${account}`;
}

function calculateBackoff(retryCount) {
  const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, retryCount), MAX_BACKOFF_MS);
  return Math.floor(delay + delay * Math.random() * 0.2);
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
  const queue = await readQueue(account);

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
  queue.push(mutation);
  await writeQueue(account, queue);

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
      // Remove completed and permanently-failed mutations
      const remaining = queue.filter(
        (m) => m.status !== 'completed' && !(m.status === 'failed' && m.retryCount >= MAX_RETRIES),
      );
      await writeQueue(account, remaining);

      if (permanentlyFailed.length && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('mutation-queue-failed', {
            detail: { count: permanentlyFailed.length },
          }),
        );
      }
    }
  } finally {
    processing = false;
    mutationQueueProcessing.set(false);
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
  const queue = await readQueue(account);
  const remaining = queue.filter((m) => m.status === 'pending' || m.status === 'processing');
  await writeQueue(account, remaining);
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

  // Listen for SW Background Sync completion to refresh counts
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'mutationQueueProcessed') {
        getMutationQueueCount();
      }
    });
  }

  // Process any pending mutations on startup
  if (isOnline()) {
    processMutationQueue();
  }

  // Periodic check for mutations with expired backoff
  setInterval(() => {
    if (isOnline() && !processing) {
      processMutationQueue();
    }
  }, 30000);
}
