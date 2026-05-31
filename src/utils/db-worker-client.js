/**
 * Database Worker Client
 *
 * Provides a clean API for database operations that mirrors Dexie's interface.
 * All operations are routed through the dedicated db.worker.js.
 *
 * Usage:
 *   import { dbClient, initDbClient } from './db-worker-client';
 *
 *   // Initialize (call once at app startup)
 *   await initDbClient();
 *
 *   // Use like Dexie tables
 *   const messages = await dbClient.messages.where('[account+folder]').equals([account, folder]).toArray();
 *   await dbClient.messages.bulkPut(records);
 */

import DbWorker from '../workers/db.worker.ts?worker&inline';
import { DB_NAME } from './db-constants.ts';
import { bootstrapReady } from './bootstrap-ready.js';
// Same Dexie engine the worker runs, importable on the main thread for the
// fallback below (WebKitGTK stalls IndexedDB inside Web Workers).
import { executeOperation } from './db-engine.ts';

let worker = null;
let messagePort = null; // For worker-to-worker communication
let requestId = 0;
const pendingRequests = new Map();
let initialized = false;
let initPromise = null;
// When true, the db worker's IndexedDB was found non-functional at init
// (notably WebKitGTK/Linux), so every operation runs the engine on the main
// thread instead of postMessaging the (terminated) worker.
let useMainThread = false;

// Determine if we're running in a worker context
const isWorkerContext =
  typeof globalThis.WorkerGlobalScope !== 'undefined' &&
  self instanceof globalThis.WorkerGlobalScope;

/**
 * Create the database worker (main thread only)
 */
function createWorker() {
  try {
    return new DbWorker();
  } catch (error) {
    console.error('[db-worker-client] Failed to create worker', error);
    throw error;
  }
}

/**
 * Send a request to the db worker and wait for response
 */
async function send(action, table = null, payload = {}) {
  // Main-thread fallback: the worker was torn down at init because its
  // IndexedDB stalls (WebKitGTK). Run the same engine inline instead.
  if (useMainThread) {
    return executeOperation({ action, table, payload: payload || {} });
  }
  if (!messagePort && !worker) {
    if (!isWorkerContext && action !== 'init') {
      await initDbClient();
    }
  }

  const attemptSend = () =>
    new Promise((resolve, reject) => {
      const id = ++requestId;
      pendingRequests.set(id, { resolve, reject });

      const message = { id, action, table, payload };

      if (messagePort) {
        // Worker-to-worker communication via MessageChannel
        messagePort.postMessage(message);
      } else if (worker) {
        // Main thread to worker
        worker.postMessage(message);
      } else {
        pendingRequests.delete(id);
        reject(new Error('Database worker not initialized'));
      }
    });

  try {
    return await attemptSend();
  } catch (error) {
    if (!isWorkerContext && error?.message?.includes('Database worker terminated')) {
      await initDbClient();
      return attemptSend();
    }
    throw error;
  }
}

/**
 * Handle response from db worker
 */
function handleMessage(event) {
  const { id, ok, result, error, errorName, errorCode } = event.data;
  const pending = pendingRequests.get(id);

  if (!pending) return;

  pendingRequests.delete(id);

  if (ok) {
    pending.resolve(result);
  } else {
    const err = new Error(error || 'Database operation failed');
    if (errorName) err.name = errorName;
    if (errorCode) err.code = errorCode;
    pending.reject(err);
  }
}

/**
 * Initialize the database client (main thread)
 */
export async function initDbClient() {
  if (initialized) return { success: true };
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      if (isWorkerContext) {
        throw new Error('Use connectToDbWorker() in worker contexts');
      }

      if (import.meta.env?.DEV) {
        await bootstrapReady;
      }

      // WebKitGTK (Tauri's Linux desktop WebView) stalls IndexedDB inside Web
      // Workers under the tauri:// scheme. It's intermittent per page load —
      // the worker can pass a one-shot init probe yet hang on a later op — so a
      // probe alone is unreliable. Skip the worker outright on Linux desktop and
      // run the engine on the main thread (not subject to the restriction).
      // macOS (WKWebView), Windows (WebView2) and Android (Chromium) are
      // unaffected and keep using the worker + probe below.
      if (shouldUseMainThreadDb()) {
        const result = await initMainThread();
        initialized = true;
        return result;
      }

      try {
        const result = await initViaWorker();
        initialized = true;
        return result;
      } catch (workerErr) {
        // Defensive catch-all for any OTHER environment where the worker's
        // IndexedDB is non-functional (init times out, or the probe round-trip
        // fails). Tear the worker down and run the SAME Dexie engine on the main
        // thread. This also dissolves the old recovery death-spiral: initDbClient
        // resolves via the main thread instead of repeatedly retrying a worker
        // that can't open IndexedDB.
        console.warn(
          '[db-worker-client] DB worker IndexedDB unavailable; using main-thread engine:',
          workerErr?.message,
        );
        terminateDbWorker();
        const result = await initMainThread();
        initialized = true;
        return result;
      }
    } catch (error) {
      console.error('[db-worker-client] Initialization failed:', error);
      throw error;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * True on Tauri's Linux desktop WebView (WebKitGTK), where IndexedDB inside a
 * Web Worker stalls under the tauri:// scheme. macOS (Macintosh UA), Windows
 * (Windows UA) and Android (Chromium WebView, has "Android" in the UA) all run
 * the worker fine and return false. Best-effort UA sniff; on any error we fall
 * through to the worker + probe path, so a miss just costs a probe round-trip.
 */
function shouldUseMainThreadDb() {
  try {
    const isTauri = typeof globalThis.__TAURI_INTERNALS__ !== 'undefined';
    const ua = globalThis.navigator?.userAgent || '';
    return isTauri && /\bLinux\b/.test(ua) && !/Android/.test(ua);
  } catch {
    return false;
  }
}

/**
 * Initialize the Dexie engine on the main thread (the WebKitGTK fallback path).
 */
async function initMainThread() {
  useMainThread = true;
  const result = await executeOperation({ action: 'init', payload: { dbName: DB_NAME } });
  if (result?.success === false) {
    const err = new Error(result?.error || 'Main-thread database init failed');
    err.code = 'DB_INIT_FAILED';
    throw err;
  }
  return result;
}

/**
 * Spin up the worker and confirm it can actually use IndexedDB. Throws if the
 * worker fails to init OR can't round-trip a write/read/delete (the probe) —
 * the caller then falls back to the main-thread engine.
 */
async function initViaWorker() {
  let initTimeoutId = null;
  const initTimeoutPromise = new Promise((_, reject) => {
    initTimeoutId = setTimeout(() => {
      const err = new Error('Database worker init timeout');
      err.code = 'DB_WORKER_INIT_TIMEOUT';
      reject(err);
    }, 10000); // Increased timeout for dev mode
  });
  worker = createWorker();
  worker.onerror = (event) => {
    console.error('[db-worker-client] Worker error', event);
  };
  worker.onmessageerror = (event) => {
    console.error('[db-worker-client] Worker message error', event);
  };
  worker.onmessage = handleMessage;

  // Wait for db worker to initialize
  const result = await Promise.race([send('init', null, { dbName: DB_NAME }), initTimeoutPromise]);
  if (initTimeoutId) clearTimeout(initTimeoutId);
  if (result?.success === false) {
    const err = new Error(result?.error || 'Database initialization failed');
    err.code = 'DB_INIT_FAILED';
    throw err;
  }

  // init() can succeed yet later IndexedDB ops still stall under WebKitGTK, so
  // confirm the worker can round-trip a real write/read/delete before we commit
  // to it. On a healthy worker this resolves in well under the 3s ceiling.
  await probeWorkerIndexedDb();
  return result;
}

/**
 * Write/read/delete a throwaway `meta` record through the worker. Rejects on
 * mismatch or if the round-trip exceeds 3s (i.e. the worker's IndexedDB hangs).
 */
async function probeWorkerIndexedDb() {
  const PROBE_KEY = '__db_worker_probe__';
  let probeTimeoutId = null;
  const probeTimeout = new Promise((_, reject) => {
    probeTimeoutId = setTimeout(() => {
      const err = new Error('Database worker IndexedDB probe timed out');
      err.code = 'DB_WORKER_PROBE_TIMEOUT';
      reject(err);
    }, 3000);
  });
  const probeOps = (async () => {
    await send('put', 'meta', { record: { key: PROBE_KEY, updatedAt: Date.now() } });
    const got = await send('get', 'meta', { key: PROBE_KEY });
    await send('delete', 'meta', { key: PROBE_KEY });
    if (!got || got.key !== PROBE_KEY) {
      const err = new Error('Database worker probe round-trip mismatch');
      err.code = 'DB_WORKER_PROBE_FAILED';
      throw err;
    }
  })();
  // Don't leak an unhandled rejection if the timeout wins the race.
  probeOps.catch(() => {});
  try {
    await Promise.race([probeOps, probeTimeout]);
  } finally {
    if (probeTimeoutId) clearTimeout(probeTimeoutId);
  }
}

/**
 * Connect to db worker via MessageChannel (for other workers)
 * @param {MessagePort} port - The MessagePort connected to db.worker
 */
export function connectToDbWorker(port) {
  if (initialized) return;

  messagePort = port;
  messagePort.onmessage = handleMessage;
  messagePort.start();
  initialized = true;
}

/**
 * Get the underlying worker (for setting up MessageChannels)
 */
export function getDbWorker() {
  return worker;
}

/**
 * True when the DB is running on the main thread (the worker's IndexedDB was
 * non-functional, e.g. WebKitGTK). Other workers (search/sync) use this to skip
 * the MessageChannel connection to the now-terminated db worker — they can't
 * reach a main-thread DB via postMessage, so they degrade gracefully instead of
 * throwing "db.worker not available".
 */
export function isDbUsingMainThread() {
  return useMainThread;
}

/**
 * Terminate the database worker
 */
export function terminateDbWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  if (messagePort) {
    messagePort.close();
    messagePort = null;
  }
  initialized = false;
  initPromise = null;
  // Reject all pending requests
  for (const [, pending] of pendingRequests) {
    pending.reject(new Error('Database worker terminated'));
  }
  pendingRequests.clear();
}

// ============================================================================
// Query Builder - Mimics Dexie's fluent API
// ============================================================================

class QueryBuilder {
  constructor(tableName, index, value) {
    this._table = tableName;
    this._index = index;
    this._value = value;
    this._options = {};
  }

  equals(value) {
    this._value = value;
    return this;
  }

  between(lower, upper, includeLower = true, includeUpper = false) {
    this._lower = lower;
    this._upper = upper;
    this._options.includeLower = includeLower;
    this._options.includeUpper = includeUpper;
    this._isBetween = true;
    this._isStartsWith = false;
    return this;
  }

  startsWith(value) {
    this._value = value;
    this._isStartsWith = true;
    this._isBetween = false;
    return this;
  }

  limit(n) {
    this._options.limit = n;
    return this;
  }

  offset(n) {
    this._options.offset = n;
    return this;
  }

  sortBy(field) {
    this._options.sortBy = field;
    return this;
  }

  reverse() {
    this._options.reverse = true;
    return this;
  }

  async toArray() {
    if (this._isBetween) {
      return send('queryBetween', this._table, {
        index: this._index,
        lower: this._lower,
        upper: this._upper,
        options: this._options,
      });
    }
    if (this._isStartsWith) {
      return send('queryStartsWith', this._table, {
        index: this._index,
        value: this._value,
        options: this._options,
      });
    }
    return send('queryEquals', this._table, {
      index: this._index,
      value: this._value,
      options: this._options,
    });
  }

  async first() {
    return send('queryEqualsFirst', this._table, {
      index: this._index,
      value: this._value,
    });
  }

  async count() {
    return send('queryEqualsCount', this._table, {
      index: this._index,
      value: this._value,
    });
  }

  async delete() {
    return send('queryEqualsDelete', this._table, {
      index: this._index,
      value: this._value,
    });
  }

  async modify(changes) {
    if (typeof changes === 'function') {
      throw new Error('db worker modify does not support function callbacks; pass an object');
    }
    return send('queryEqualsModify', this._table, {
      index: this._index,
      value: this._value,
      changes,
    });
  }
}

// ============================================================================
// Table Proxy - Mimics Dexie table interface
// ============================================================================

class TableProxy {
  constructor(tableName) {
    this._table = tableName;
  }

  // Direct operations
  get(key) {
    return send('get', this._table, { key });
  }

  put(record) {
    return send('put', this._table, { record });
  }

  delete(key) {
    return send('delete', this._table, { key });
  }

  update(key, changes) {
    return send('update', this._table, { key, changes });
  }

  clear() {
    return send('clear', this._table);
  }

  count() {
    return send('count', this._table);
  }

  toArray() {
    return send('toArray', this._table);
  }

  limit(n) {
    return new TableCollectionBuilder(this._table).limit(n);
  }

  // Bulk operations
  bulkGet(keys) {
    return send('bulkGet', this._table, { keys });
  }

  bulkPut(records) {
    return send('bulkPut', this._table, { records });
  }

  bulkDelete(keys) {
    return send('bulkDelete', this._table, { keys });
  }

  // Query builder
  where(index) {
    return new QueryBuilder(this._table, index, null);
  }
}

class TableCollectionBuilder {
  constructor(tableName) {
    this._table = tableName;
    this._options = {};
  }

  limit(n) {
    this._options.limit = n;
    return this;
  }

  offset(n) {
    this._options.offset = n;
    return this;
  }

  reverse() {
    this._options.reverse = true;
    return this;
  }

  async toArray() {
    return send('tableCollection', this._table, { options: this._options });
  }
}
// ============================================================================
// Transaction Support
// ============================================================================

/**
 * Run multiple operations in a transaction
 * @param {string} mode - 'r' for read, 'rw' for read-write
 * @param {string[]} tables - Table names involved in transaction
 * @param {Function} callback - Async function that returns array of operations
 */
export async function transaction(mode, ...args) {
  if (!args.length) {
    throw new Error('Transaction requires a callback');
  }

  const callback = args.pop();
  if (typeof callback !== 'function') {
    throw new Error('Transaction callback must be a function');
  }

  const tablesArg = args.length === 1 ? args[0] : args;
  const tables = normalizeTables(tablesArg);

  // Build operations from callback (optional, for txProxy usage)
  const ops = [];
  const txProxy = {
    table: (name) => ({
      get: (key) => ops.push({ action: 'get', table: name, payload: { key } }),
      put: (record) => ops.push({ action: 'put', table: name, payload: { record } }),
      delete: (key) => ops.push({ action: 'delete', table: name, payload: { key } }),
      bulkPut: (records) => ops.push({ action: 'bulkPut', table: name, payload: { records } }),
      bulkDelete: (keys) => ops.push({ action: 'bulkDelete', table: name, payload: { keys } }),
      clear: () => ops.push({ action: 'clear', table: name }),
      update: (key, changes) =>
        ops.push({ action: 'update', table: name, payload: { key, changes } }),
    }),
  };

  const result = await callback(txProxy);

  if (!ops.length) {
    return result;
  }

  return send('transaction', null, { mode, tables, operations: ops });
}

function normalizeTables(tables) {
  if (!tables) return [];
  const list = Array.isArray(tables) ? tables : [tables];
  return list
    .map((table) => {
      if (typeof table === 'string') return table;
      if (table && typeof table === 'object') {
        return table._table || table.name || table.table || table.tableName;
      }
      return null;
    })
    .filter(Boolean);
}

// ============================================================================
// Database Management
// ============================================================================

export async function getDatabaseInfo() {
  return send('getInfo');
}

export async function clearCache() {
  return send('clearCache');
}

export async function resetDatabase() {
  return send('reset');
}

export async function closeDatabase() {
  return send('close');
}

// ============================================================================
// Main Export - Database Client with Table Proxies
// ============================================================================

/**
 * Database client with Dexie-like table access
 *
 * @example
 * import { dbClient } from './db-worker-client';
 *
 * // Get messages
 * const messages = await dbClient.messages.where('[account+folder]').equals([account, folder]).toArray();
 *
 * // Put a record
 * await dbClient.folders.put(folderRecord);
 *
 * // Bulk operations
 * await dbClient.messages.bulkPut(messages);
 */
export const dbClient = {
  // Tables
  accounts: new TableProxy('accounts'),
  folders: new TableProxy('folders'),
  messages: new TableProxy('messages'),
  messageBodies: new TableProxy('messageBodies'),
  drafts: new TableProxy('drafts'),
  searchIndex: new TableProxy('searchIndex'),
  indexMeta: new TableProxy('indexMeta'),
  meta: new TableProxy('meta'),
  syncManifests: new TableProxy('syncManifests'),
  labels: new TableProxy('labels'),
  settings: new TableProxy('settings'),
  settingsLabels: new TableProxy('settingsLabels'),
  outbox: new TableProxy('outbox'),

  // Transaction helper
  transaction,

  // Management functions
  getInfo: getDatabaseInfo,
  clearCache,
  reset: resetDatabase,
  close: closeDatabase,

  // Check if initialized
  get isOpen() {
    return initialized;
  },
};

// Default export for convenience
export default dbClient;

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    terminateDbWorker();
  });
}
