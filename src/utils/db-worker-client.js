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
// Supplies the at-rest encryption config ({ required, rawKey }) for the DB
// engine. Registered by db-crypto-bridge on the main thread and re-applied
// after EVERY successful init, because the worker can be torn down and recreated by
// the recovery path, which would otherwise silently drop the key and make a
// locked-vault engine write plaintext again.
let cryptoConfigProvider = null;
// When true, the db worker's IndexedDB was found non-functional at init
// (notably WebKitGTK/Linux), so every operation runs the engine on the main
// thread instead of postMessaging the (terminated) worker.
let useMainThread = false;

// The worker init + IndexedDB probe race against setTimeout() deadlines that
// run on the MAIN thread — the most contended resource during startup. On a
// cold dev load (the inline worker bundle is compiled on first use) or a slow
// x64 Mac, a perfectly healthy worker can miss a tight deadline, get torn down,
// and force the entire app onto the main-thread DB engine. That engine then
// runs every cached read on the main thread and starves the startup API
// fetches (Folders/Calendars/Messages time out even though the server is fast).
// Keep these generous: the UI boot is already decoupled via a 4s ceiling in
// main.ts, so a longer ceiling here only delays *declaring the worker dead*,
// never the UI. A genuine WebKitGTK/Linux stall never reaches here — it's
// short-circuited by shouldUseMainThreadDb() before the worker is even created.
const WORKER_INIT_TIMEOUT_MS = import.meta.env?.DEV ? 30000 : 15000;
const WORKER_PROBE_TIMEOUT_MS = import.meta.env?.DEV ? 10000 : 6000;
// How long to wait for the worker's boot heartbeat (it posts {type:'booted'}
// the moment its script runs, before opening IndexedDB). Hearing it means the
// worker is alive and any further delay is IndexedDB being slow, so we then
// allow the full WORKER_INIT_TIMEOUT_MS. NOT hearing it means the worker never
// started (compile/bundle failure) — fall back fast rather than holding the
// long init ceiling. Generous in dev because the inline worker bundle is
// compiled on first use.
const WORKER_BOOT_TIMEOUT_MS = import.meta.env?.DEV ? 12000 : 5000;

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
      // initDbClient() may have committed to the main-thread engine (the
      // worker's IndexedDB init/probe timed out and the worker was torn down).
      // In that window worker AND messagePort are both null, so without this
      // re-check a caller that entered send() before useMainThread flipped —
      // e.g. the outbox processor firing on startup — falls through to
      // attemptSend() and rejects with "Database worker not initialized".
      if (useMainThread) {
        return executeOperation({ action, table, payload: payload || {} });
      }
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
        await applyCryptoConfig();
        return result;
      }

      try {
        const result = await initViaWorker();
        initialized = true;
        await applyCryptoConfig();
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
        await applyCryptoConfig();
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
export function shouldUseMainThreadDb() {
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
  worker = createWorker();
  worker.onerror = (event) => {
    console.error('[db-worker-client] Worker error', event);
  };
  worker.onmessageerror = (event) => {
    console.error('[db-worker-client] Worker message error', event);
  };

  // Boot heartbeat: resolves when the worker posts {type:'booted'} (its script
  // ran) OR when init itself completes (which also proves it's alive). The boot
  // message has no `id`, so handleMessage ignores it; this dedicated listener
  // consumes it.
  let resolveBooted;
  const bootedPromise = new Promise((resolve) => {
    resolveBooted = resolve;
  });
  const bootListener = (event) => {
    if (event?.data?.type === 'booted') resolveBooted();
  };
  worker.addEventListener('message', bootListener);
  worker.onmessage = handleMessage;

  // Send init now; the browser queues it until the worker's handler attaches,
  // so there's no race with boot. Completing init also satisfies the boot gate.
  const initSend = send('init', null, { dbName: DB_NAME });
  initSend.then(resolveBooted, () => {});

  // Phase 1 — the worker must show signs of life within the short boot window.
  // If it doesn't, it never started; fail fast so the caller falls back to the
  // main-thread engine immediately instead of holding the long init ceiling.
  let bootTimeoutId = null;
  try {
    await Promise.race([
      bootedPromise,
      new Promise((_, reject) => {
        bootTimeoutId = setTimeout(() => {
          const err = new Error('Database worker failed to boot');
          err.code = 'DB_WORKER_NO_BOOT';
          reject(err);
        }, WORKER_BOOT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (bootTimeoutId) clearTimeout(bootTimeoutId);
    worker.removeEventListener('message', bootListener);
  }

  // Phase 2 — the worker is alive, so give IndexedDB the full (generous) init
  // ceiling. Slowness here is IndexedDB opening, not a dead worker.
  let initTimeoutId = null;
  const initTimeoutPromise = new Promise((_, reject) => {
    initTimeoutId = setTimeout(() => {
      const err = new Error('Database worker init timeout');
      err.code = 'DB_WORKER_INIT_TIMEOUT';
      reject(err);
    }, WORKER_INIT_TIMEOUT_MS);
  });
  let result;
  try {
    result = await Promise.race([initSend, initTimeoutPromise]);
  } finally {
    if (initTimeoutId) clearTimeout(initTimeoutId);
  }
  if (result?.success === false) {
    const err = new Error(result?.error || 'Database initialization failed');
    err.code = 'DB_INIT_FAILED';
    throw err;
  }

  // init() can succeed yet later IndexedDB ops still stall under WebKitGTK, so
  // confirm the worker can round-trip a real write/read/delete before we commit
  // to it. On a healthy worker this resolves in well under the probe ceiling.
  await probeWorkerIndexedDb();
  return result;
}

/**
 * Write/read/delete a throwaway `meta` record through the worker. Rejects on
 * mismatch or if the round-trip exceeds WORKER_PROBE_TIMEOUT_MS (i.e. the
 * worker's IndexedDB hangs).
 */
async function probeWorkerIndexedDb() {
  const PROBE_KEY = '__db_worker_probe__';
  let probeTimeoutId = null;
  const probeTimeout = new Promise((_, reject) => {
    probeTimeoutId = setTimeout(() => {
      const err = new Error('Database worker IndexedDB probe timed out');
      err.code = 'DB_WORKER_PROBE_TIMEOUT';
      reject(err);
    }, WORKER_PROBE_TIMEOUT_MS);
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
 * Register the provider that supplies the at-rest encryption config. Applied
 * immediately if the client is already initialized, and re-applied after
 * every future (re)init.
 * @param {() => Promise<{required: boolean, rawKey?: Uint8Array|null}|null>} provider
 */
export async function setCryptoConfigProvider(provider) {
  cryptoConfigProvider = provider;
  if (initialized) {
    await applyCryptoConfig();
  }
}

/**
 * Push the current crypto config (from the registered provider) to the engine.
 * Also called directly on lock/unlock transitions via db-crypto-bridge.
 */
export async function applyCryptoConfig() {
  if (!cryptoConfigProvider) return;
  try {
    const config = await cryptoConfigProvider();
    if (config) {
      await send('configureCrypto', null, config);
    }
  } catch (error) {
    console.error('[db-worker-client] Failed to apply crypto config:', error);
  }
}

/**
 * Push an explicit crypto config to the engine, bypassing the provider.
 * Used by the disable-lock sweep, which needs the key present while the
 * fail-closed flag is already off.
 * @param {{required: boolean, rawKey?: Uint8Array|null}} config
 */
export async function sendCryptoConfig(config) {
  return send('configureCrypto', null, config);
}

/**
 * Run the at-rest re-encryption sweep in the engine.
 * @param {'encrypt'|'decrypt'} direction
 */
export async function reencryptAllDb(direction) {
  return send('reencryptAll', null, { direction });
}

/**
 * Turn at-rest encryption off: drop the server copies and decrypt the
 * local-only tables. See unsealForDisable in db-engine.ts.
 */
export async function unsealDbForDisable() {
  return send('unsealForDisable');
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
