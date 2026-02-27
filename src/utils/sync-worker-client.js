import { config } from '../config.js';
import SyncWorker from '../workers/sync.worker.ts?worker&inline';
import { Local } from './storage.js';
import { getDbWorker, initializeDatabase } from './db.js';
import { getAuthHeader } from './auth.ts';
import { createPendingRequests } from './pending-requests.js';
import { warn } from './logger.ts';
import { isDemoMode } from './demo-mode';

let worker = null;
let workerReady = false;
let dbConnected = false;

const pendingTasks = createPendingRequests();
const pendingRequests = createPendingRequests();
const progressHandlers = new Set();
const perfHandlers = new Set();
const taskCompleteHandlers = new Set();

const createWorker = () => new SyncWorker();

function getPgpPayload() {
  try {
    // SECURITY: Load account-specific PGP keys and passphrases
    const currentAcct = Local.get('email') || 'default';
    const rawKeys = Local.get(`pgp_keys_${currentAcct}`);
    const keys = rawKeys ? JSON.parse(rawKeys) : [];
    const rawPass = Local.get(`pgp_passphrases_${currentAcct}`);
    const passphrases = rawPass ? JSON.parse(rawPass) : {};
    return { keys: Array.isArray(keys) ? keys : [], passphrases: passphrases || {} };
  } catch {
    return { keys: [], passphrases: {} };
  }
}

function handleMessage(event) {
  const data = event?.data || {};
  if (data.type === 'taskComplete') {
    pendingTasks.resolve(data.taskId, data);
    taskCompleteHandlers.forEach((handler) => {
      try {
        handler(data);
      } catch (err) {
        warn('[sync-worker-client] taskComplete handler failed', err);
      }
    });
    return;
  }
  if (data.type === 'taskError') {
    pendingTasks.reject(data.taskId, new Error(data.error || 'Task failed'));
    return;
  }
  if (data.type === 'requestComplete') {
    pendingRequests.resolve(data.requestId, data.result);
    return;
  }
  if (data.type === 'requestError') {
    pendingRequests.reject(data.requestId, new Error(data.error || 'Request failed'));
    return;
  }
  if (data.type === 'perf') {
    perfHandlers.forEach((handler) => handler(data));
    return;
  }
  if (data.type === 'progress' || data.stage) {
    progressHandlers.forEach((handler) => handler(data));
  }
}

function handleWorkerError(event) {
  const errorMsg = event?.message || 'Sync worker crashed';
  console.error('[sync-worker-client] Worker error:', errorMsg);

  // Reject all pending tasks/requests
  const error = new Error(errorMsg);
  pendingTasks.clear(error);
  pendingRequests.clear(error);

  // Reset state so next call recreates worker
  worker = null;
  workerReady = false;
  dbConnected = false;
}

/**
 * Connect sync worker to db.worker via MessageChannel
 * @throws {Error} If connection fails after initialization attempt
 */
async function connectToDbWorker() {
  if (dbConnected || !worker) return;

  let dbWorker = getDbWorker();
  if (!dbWorker) {
    try {
      await initializeDatabase();
      dbWorker = getDbWorker();
    } catch (err) {
      throw new Error(`Failed to initialize database worker: ${err.message || 'Unknown error'}`);
    }
  }
  if (!dbWorker) {
    throw new Error('Database worker not available after initialization');
  }

  // Create a MessageChannel
  const channel = new MessageChannel();

  // Send one port to db.worker
  dbWorker.postMessage({ type: 'connectPort', workerId: 'sync' }, [channel.port1]);

  // Send the other port to sync.worker
  worker.postMessage({ type: 'connectDbPort' }, [channel.port2]);
  dbConnected = true;
}

export async function ensureSyncWorkerReady() {
  if (isDemoMode()) return; // Don't spawn worker in demo mode
  if (workerReady && worker) return worker;
  if (!worker) {
    worker = createWorker();
    worker.onmessage = handleMessage;
    worker.onerror = handleWorkerError;
  }

  const authHeader = getAuthHeader({ allowApiKey: true });
  if (!authHeader) {
    throw new Error('Missing auth header for sync worker');
  }
  worker.postMessage({
    type: 'init',
    config: {
      apiBase: config.apiBase,
      authHeader,
    },
  });
  const pgpPayload = getPgpPayload();
  worker.postMessage({
    type: 'pgpKeys',
    ...pgpPayload,
  });

  // Connect to db worker
  await connectToDbWorker();

  workerReady = true;
  return worker;
}

export function resetSyncWorkerReady() {
  workerReady = false;
  dbConnected = false;
  // Reject all pending tasks/requests from the previous account
  // so in-flight operations don't resolve after an account switch
  const error = new Error('Account switched');
  pendingTasks.clear(error);
  pendingRequests.clear(error);
}

// Default timeout for sync tasks (10 seconds)
const SYNC_TASK_TIMEOUT_MS = 10000;

/**
 * Create a promise that rejects after timeout
 */
function withTimeout(promise, ms, taskId) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        pendingTasks.reject(taskId, new Error(`Sync task timed out after ${ms}ms`));
        reject(new Error(`Sync task timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

export async function sendSyncTask(task, options = {}) {
  // In demo mode, skip the sync worker — return a no-op result
  // so callers like requestParsing fall through to their fallback path.
  if (isDemoMode()) {
    return { success: false, body: '', attachments: [] };
  }

  const instance = await ensureSyncWorkerReady();
  const taskId = `t-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const promise = pendingTasks.add(taskId);
  instance.postMessage({ type: 'task', taskId, task });

  const timeout = options.timeout ?? SYNC_TASK_TIMEOUT_MS;
  return withTimeout(promise, timeout, taskId);
}

const DEFAULT_WORKER_TIMEOUT = 30_000; // 30s — matches Remote.request default

export async function sendSyncRequest(
  action,
  payload = {},
  { timeout = DEFAULT_WORKER_TIMEOUT } = {},
) {
  // In demo mode, skip the sync worker entirely so the caller falls back
  // to Remote.request() which is intercepted by the demo data generator.
  if (isDemoMode()) {
    throw new Error('Demo mode: sync worker bypassed');
  }

  const instance = await ensureSyncWorkerReady();
  const requestId = `r-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const promise = pendingRequests.add(requestId);
  instance.postMessage({ type: 'request', requestId, action, payload });

  if (!timeout) return promise;

  const timer = setTimeout(() => {
    pendingRequests.reject(
      requestId,
      new Error(`Sync worker request "${action}" timed out after ${timeout}ms`),
    );
  }, timeout);

  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

export function onSyncProgress(handler) {
  progressHandlers.add(handler);
  return () => {
    progressHandlers.delete(handler);
  };
}

export function onSyncPerf(handler) {
  perfHandlers.add(handler);
  return () => {
    perfHandlers.delete(handler);
  };
}

export function onSyncTaskComplete(handler) {
  taskCompleteHandlers.add(handler);
  return () => {
    taskCompleteHandlers.delete(handler);
  };
}

export function refreshSyncWorkerPgpKeys() {
  if (!worker) return;
  const pgpPayload = getPgpPayload();
  worker.postMessage({
    type: 'pgpKeys',
    ...pgpPayload,
  });
}

/**
 * Request the worker to decrypt a PGP encrypted message
 * This allows the main thread to delegate PGP decryption to the worker
 *
 * @param {Object} options - Decryption options
 * @param {string} options.raw - The PGP encrypted message (armored)
 * @param {string} options.messageId - Message ID for tracking
 * @param {string} options.account - Account identifier
 * @returns {Promise<Object>} Decryption result with success, body, textContent, attachments
 */
export async function requestPgpDecryption({ raw, messageId, account }) {
  return sendSyncTask(
    {
      type: 'decryptMessage',
      raw,
      messageId,
      account,
    },
    { timeout: 30000 },
  );
}

/**
 * Unlock a PGP key with a passphrase from the main thread
 * Called after user provides passphrase via modal
 *
 * @param {Object} options - Unlock options
 * @param {string} options.keyName - Name/identifier of the key
 * @param {string} options.passphrase - User-provided passphrase
 * @param {string} options.keyValue - The armored private key
 * @param {boolean} options.remember - Whether to remember passphrase
 * @param {boolean} options.checkOnly - If true, only check if key needs passphrase without unlocking
 * @returns {Promise<Object>} Result with success status and needsPassphrase flag
 */
export async function unlockPgpKey({
  keyName,
  passphrase,
  keyValue,
  remember = false,
  checkOnly = false,
}) {
  return sendSyncRequest('unlockPgpKey', {
    keyName,
    passphrase,
    keyValue,
    remember,
    checkOnly,
  });
}

/**
 * Request MIME parsing from worker (Phase 3 optimization)
 * This delegates all MIME parsing to the worker, removing PostalMime from main thread
 *
 * @param {Object} options - Parse options
 * @param {string} options.raw - Raw MIME message to parse
 * @param {Array} options.existingAttachments - Existing attachments to merge
 * @returns {Promise<Object>} Parsed result with body, textContent, attachments
 */
export async function requestParsing({ raw, existingAttachments = [] }) {
  return sendSyncTask(
    {
      type: 'parseRaw',
      raw,
      existingAttachments,
    },
    { timeout: 30000 },
  );
}

export async function connectSyncSearchPort(searchWorkerClient) {
  if (!searchWorkerClient?.connectSyncPort) {
    throw new Error('Invalid search worker client');
  }
  const instance = await ensureSyncWorkerReady();
  const channel = new MessageChannel();
  instance.postMessage({ type: 'connectSearchPort' }, [channel.port1]);
  await searchWorkerClient.connectSyncPort(channel.port2);
}

export function getSyncWorker() {
  return worker;
}

/**
 * Terminate sync worker and cleanup all pending tasks
 * Call during shutdown or HMR to prevent old code from running
 */
export function terminateSyncWorker() {
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // Ignore termination errors
    }
    worker = null;
  }
  workerReady = false;
  dbConnected = false;
  // Reject all pending tasks/requests
  pendingTasks.clear(new Error('Worker terminated'));
  pendingRequests.clear(new Error('Worker terminated'));
  progressHandlers.clear();
  perfHandlers.clear();
}

// HMR cleanup - terminate worker when module is replaced during development
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    terminateSyncWorker();
  });
}
