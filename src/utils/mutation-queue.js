import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { getAuthHeaderForAccount } from './auth';
import { config } from '../config';
import { writable } from 'svelte/store';
import { warn } from './logger.ts';
import { isOnline } from './network-status';
import { swReadyWithTimeout, isTauri } from './platform.js';
import { exponentialBackoff } from './backoff.js';
import { addFlagsBody, labelChangeBody, queuedToggleBody } from './message-changes.ts';
import {
  MUTATION_MAX_RETRIES,
  MUTATION_RUN_LOCK,
  MUTATION_WRITE_LOCK,
  applySettled,
  drainMutationQueue,
  isExhaustedMutation,
  resolveMutationAccount,
  withNamedLock,
} from './sync-core.js';

/**
 * Offline Mutation Queue
 *
 * Queues mail operations (toggle read, star, move, delete, label, and flags
 * set by a reply) when offline.
 * Processes the queue when connectivity is restored.
 *
 * Mutations are stored in the IndexedDB `meta` table under a per-account key
 * to avoid requiring a schema migration.
 *
 * Each mutation has:
 *   id:        unique identifier
 *   type:      'toggleRead' | 'toggleStar' | 'addFlags' | 'move' | 'delete' | 'label'
 *   payload:   operation-specific data (messageId, folder, flags, etc.)
 *   status:    'pending' | 'processing' | 'failed'
 *   retryCount: number of attempts
 *   createdAt: timestamp
 */

const MAX_RETRIES = MUTATION_MAX_RETRIES;
const BASE_BACKOFF_MS = 3000;
const MAX_BACKOFF_MS = 2 * 60 * 1000;
const QUEUE_KEY_PREFIX = 'mutation_queue_';

export const mutationQueueCount = writable(0);
export const mutationQueueProcessing = writable(false);

let processing = false;

// Serializes every read-modify-write of the queue's meta rows. Writers in
// this tab (appends, the processor's per-entry results, prunes) chain here,
// and the Web Lock keeps the service worker and other tabs out while one
// runs. Without it, an append that lands between another writer's read and
// write is silently dropped.
let queueWriteLock = Promise.resolve();

function withQueueLock(fn) {
  const locked = () => withNamedLock(MUTATION_WRITE_LOCK, fn);
  const run = queueWriteLock.then(locked, locked);
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
    // Not a flag only added (\Answered): holding the message back from sync
    // would also hide it being moved or deleted elsewhere until the change
    // goes through.
    if (m.type === 'addFlags') continue;
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
 * @param {Object} [options]
 * @param {string} [options.account] - Queue it for this signed-in account
 *   instead of the active one. It runs the next time that account is active.
 * @returns {Promise<Object>} The queued mutation record
 */
export async function queueMutation(type, payload, { account: forAccount } = {}) {
  const account = forAccount || getAccount();

  // Store auth info so the SW can process mutations when the tab is closed.
  // It is the queue's account's, so the SW never sends it as another one.
  let authHeader = '';
  try {
    authHeader = getAuthHeaderForAccount(account);
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

  // If online, process immediately; otherwise register Background Sync.
  // Another account's queue only drains once that account is active.
  if (account !== getAccount()) return mutation;
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
 * Execute a single mutation against the API, as the account it was queued
 * for. Reading the active account at send time sent a change queued for one
 * account with another's credentials after a switch.
 * Returns an outcome for settleMutation (see sync-core.js); a failed request
 * throws, and a 404 counts as done there.
 */
async function executeMutation(mutation, queueAccount) {
  const { type, payload } = mutation;
  const account = resolveMutationAccount(mutation, queueAccount);
  if (!account) {
    warn('[mutation-queue] Dropping a queued change with no account', mutation.id);
    return { result: 'drop' };
  }
  let authHeader = '';
  try {
    authHeader = getAuthHeaderForAccount(account);
  } catch {
    authHeader = '';
  }
  // Signed out or locked: wait for the credentials rather than fail
  if (!authHeader) return { result: 'skip' };
  const path = `/v1/messages/${encodeURIComponent(payload.messageId)}`;
  const put = (body) =>
    Remote.request('MessageUpdate', body, { method: 'PUT', pathOverride: path, authHeader });

  switch (type) {
    // isUnread and isStarred are the state before the toggle (see
    // queuedToggleBody): a queued "mark as read" was sent as "mark as unread"
    case 'toggleRead':
    case 'toggleStar':
      await put(queuedToggleBody(type, payload));
      return { result: 'done' };

    // Flags only ever added (\Answered on the message a reply answered), so a
    // change that keeps failing has nothing to undo.
    case 'addFlags':
      await put(addFlagsBody(payload.flags, payload.add));
      return { result: 'done' };

    case 'move':
      await put({ folder: payload.targetFolder });
      return { result: 'done' };

    case 'delete':
      await Remote.request(
        'MessageDelete',
        {},
        {
          method: 'DELETE',
          pathOverride: payload.permanent ? `${path}?permanent=1` : path,
          authHeader,
        },
      );
      return { result: 'done' };

    case 'label':
      await put(labelChangeBody(payload.labels, payload.previousLabels));
      return { result: 'done' };

    default:
      warn('[mutation-queue] Unknown mutation type:', type);
      return { result: 'drop' };
  }
}

function isRunnable(mutation, now = Date.now()) {
  return mutation?.status === 'pending' && (!mutation.nextRetryAt || mutation.nextRetryAt <= now);
}

/**
 * Process the mutation queue: execute pending mutations in order.
 *
 * Runs under the cross-context run lock, so the service worker's Background
 * Sync and another tab never send the same queued change at the same time.
 * Each result is written back on its own, to a fresh read of the queue.
 */
export async function processMutationQueue() {
  if (processing || !isOnline()) return;

  const account = getAccount();
  processing = true;
  mutationQueueProcessing.set(true);
  let queuedDuringRun = false;

  try {
    await withNamedLock(MUTATION_RUN_LOCK, async () => {
      const queue = await readQueue(account);
      if (!queue.length) return;

      const seen = new Set(queue.map((m) => m?.id));
      const results = await drainMutationQueue(queue, {
        canContinue: () => isOnline(),
        backoff: calculateBackoff,
        execute: (mutation) => executeMutation(mutation, account),
        isCurrent: async (mutation) => {
          const current = (await readQueue(account)).find((m) => m?.id === mutation.id);
          return (
            Boolean(current) && current.status !== 'completed' && !isExhaustedMutation(current)
          );
        },
        settle: (settled) =>
          withQueueLock(async () => {
            const next = applySettled(await readQueue(account), settled);
            if (next) await writeQueue(account, next);
          }),
      });

      const permanentlyFailed = results
        .filter((r) => r.exhausted)
        .map((r) => r.entry)
        .filter(Boolean);
      if (permanentlyFailed.length) {
        // Reverted below, so they leave the queue now
        const ids = new Set(permanentlyFailed.map((m) => m.id));
        await withQueueLock(async () => {
          const current = await readQueue(account);
          const remaining = current.filter((m) => !ids.has(m?.id));
          if (remaining.length !== current.length) await writeQueue(account, remaining);
        });
        notifyPermanentFailures(permanentlyFailed);
      }

      // Changes queued while this ran were not in its snapshot, and their own
      // processMutationQueue call hit the `processing` guard. Run again so
      // they don't wait for the 30s sweep.
      const after = await readQueue(account);
      queuedDuringRun = after.some((m) => !seen.has(m?.id) && isRunnable(m));
    });
  } finally {
    processing = false;
    mutationQueueProcessing.set(false);
  }

  if (queuedDuringRun) {
    await processMutationQueue();
  }
}

function notifyPermanentFailures(permanentlyFailed) {
  if (!permanentlyFailed.length || typeof window === 'undefined') return;
  // A flag a reply set is not a change the user made, and there is
  // nothing for them to try again.
  const userChanges = permanentlyFailed.filter((m) => m.type !== 'addFlags');
  if (userChanges.length) {
    window.dispatchEvent(
      new CustomEvent('mutation-queue-failed', {
        detail: { count: userChanges.length },
      }),
    );
  }
  dispatchPermanentFailures(permanentlyFailed);
}

/**
 * Drop queued changes that a newer change replaces.
 *
 * A change made online goes straight to the server. An older change to the
 * same message still waiting in the queue (a "mark as read" queued offline,
 * then "mark as unread" once back online) would otherwise be sent after it
 * and undo it. Callers run this before sending the newer change.
 *
 * @param {Object} options
 * @param {string} [options.account] - whose queue (default: the active account)
 * @param {Array<string|number>} options.messageIds - API ids (or local ids)
 * @param {string|string[]} options.type - mutation type(s) the new change replaces
 * @returns {Promise<Array>} the entries removed
 */
export async function supersedeQueuedMutations({ account, messageIds, type } = {}) {
  const ids = new Set(
    (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(Boolean).map(String),
  );
  const types = new Set(Array.isArray(type) ? type : [type].filter(Boolean));
  if (!ids.size || !types.size) return [];
  const owner = account || getAccount();
  let removed = [];
  await withQueueLock(async () => {
    const queue = await readQueue(owner);
    removed = queue.filter(
      (m) =>
        types.has(m?.type) &&
        (ids.has(String(m?.payload?.messageId)) || ids.has(String(m?.payload?.internalId))),
    );
    if (removed.length) {
      const gone = new Set(removed.map((m) => m.id));
      await writeQueue(
        owner,
        queue.filter((m) => !gone.has(m.id)),
      );
    }
  });
  return removed;
}

/**
 * After a direct request for a flag change failed: queue it to be sent again
 * when it can still succeed (offline, a timeout, rate limiting, a server
 * error), and report the rest so the caller can put the message back.
 * A message that no longer exists needs neither.
 *
 * @returns {Promise<'queued'|'gone'|'revert'>}
 */
export async function queueOrRevertFailedChange(type, payload, error, { account } = {}) {
  const status = Number(error?.status) || 0;
  if (status === 404 || status === 410) return 'gone';
  const retryable = !status || status === 408 || status === 429 || status >= 500;
  if (!retryable) return 'revert';
  try {
    await queueMutation(type, payload, { account });
    return 'queued';
  } catch (queueError) {
    warn('[mutation-queue] Could not queue a failed change', queueError);
    return 'revert';
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
