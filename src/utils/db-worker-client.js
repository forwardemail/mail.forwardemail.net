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
// Notified whenever the engine moves (new worker, worker torn down, or the
// main-thread fallback taking over). The sync and search workers hold a
// MessagePort into the db worker; when that worker goes away their port is
// dead and they must reconnect or stop using it.
const workerChangeListeners = new Set();

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

// Every postMessage request gets a deadline. A request posted to a worker that
// has died (or to a port whose worker was replaced) gets no reply at all, and
// without this the caller would wait forever. The long-running maintenance
// actions are exempt; they legitimately take minutes on a large cache.
let requestTimeoutMs = 60_000;
const UNTIMED_ACTIONS = new Set([
  'init',
  'reencryptAll',
  'unsealForDisable',
  'abandonSealed',
  'clearCache',
  'reset',
  'restoreRaw',
]);

/** Override the per-request deadline (tests, or 0 to disable). */
export function setDbRequestTimeout(ms) {
  requestTimeoutMs = Number.isFinite(ms) && ms >= 0 ? ms : requestTimeoutMs;
}

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
      let timer = null;
      const settle = (fn) => (value) => {
        if (timer) clearTimeout(timer);
        fn(value);
      };
      pendingRequests.set(id, { resolve: settle(resolve), reject: settle(reject) });

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
        return;
      }

      if (requestTimeoutMs > 0 && !UNTIMED_ACTIONS.has(action)) {
        timer = setTimeout(() => {
          if (!pendingRequests.has(id)) return;
          pendingRequests.delete(id);
          const err = new Error(`Database request timed out: ${action}`);
          err.code = 'DB_REQUEST_TIMEOUT';
          reject(err);
        }, requestTimeoutMs);
      }
    });

  try {
    return await attemptSend();
  } catch (error) {
    if (!isWorkerContext && error?.message?.includes('Database worker terminated')) {
      await initDbClient();
      // The re-init may have landed on the main-thread engine.
      if (useMainThread) {
        return executeOperation({ action, table, payload: payload || {} });
      }
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
        notifyWorkerChange();
        return result;
      }

      try {
        const result = await initViaWorker();
        initialized = true;
        await applyCryptoConfig();
        notifyWorkerChange();
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
        teardownWorker();
        const result = await initMainThread();
        initialized = true;
        await applyCryptoConfig();
        notifyWorkerChange();
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
function initPayload() {
  // Ask the engine to hold sensitive reads and writes until the crypto config
  // is pushed, when there is a provider that will push one. Without this the
  // window between init and configureCrypto stores plaintext under App Lock.
  return { dbName: DB_NAME, cryptoGate: Boolean(cryptoConfigProvider) };
}

async function initMainThread() {
  // A worker from an earlier attempt must not keep running next to the
  // main-thread engine: it has no crypto config and other workers may still
  // be talking to it.
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // already gone
    }
    worker = null;
  }
  useMainThread = true;
  const result = await executeOperation({ action: 'init', payload: initPayload() });
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
  // Requests must go to the new worker, not to a main-thread engine left over
  // from an earlier fallback, and an earlier worker must not linger.
  useMainThread = false;
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // already gone
    }
    worker = null;
  }
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
  const initSend = send('init', null, initPayload());
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
  let config;
  try {
    config = (await cryptoConfigProvider()) || { required: false, rawKey: null };
  } catch (error) {
    // The provider only throws when App Lock is on and the key could not be
    // derived. Fail closed rather than leave the engine waiting or writing
    // plaintext.
    console.error('[db-worker-client] Crypto config provider failed:', error);
    config = { required: true, rawKey: null };
  }
  try {
    await send('configureCrypto', null, config);
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
 * Drop sealed rows that can no longer be opened (App Lock turned off without
 * the key). See abandonSealed in db-engine.ts.
 */
export async function abandonSealedDb() {
  return send('abandonSealed');
}

/**
 * Put raw rows back after a recovery rebuild without resealing them or
 * overwriting newer rows. See restoreRaw in db-engine.ts.
 */
export async function restoreRawRows(table, records) {
  return send('restoreRaw', table, { records });
}

/**
 * Open a database channel for another worker (sync, search) and return the
 * end to hand to it. With the db worker running, the channel goes to it. With
 * the engine on the main thread (the fallback when the worker's IndexedDB
 * stalls), this thread answers on it, so the other workers keep a working
 * database instead of a port to a worker that is gone.
 * @param {string} workerId - 'sync' or 'search'
 * @returns {MessagePort | null}
 */
export function openDbPortForWorker(workerId) {
  if (isWorkerContext || typeof MessageChannel === 'undefined') return null;
  const channel = new MessageChannel();
  if (useMainThread) {
    channel.port1.onmessage = async (event) => {
      const { id, action, table, payload } = event.data || {};
      if (id == null || !action) return;
      try {
        const result = await executeOperation({ action, table, payload: payload || {} });
        channel.port1.postMessage({ id, ok: true, result });
      } catch (error) {
        channel.port1.postMessage({
          id,
          ok: false,
          error: error?.message || String(error),
          errorName: error?.name,
          errorCode: error?.code,
        });
      }
    };
    channel.port1.start();
    return channel.port2;
  }
  if (!worker) return null;
  worker.postMessage({ type: 'connectPort', workerId }, [channel.port1]);
  return channel.port2;
}

/**
 * Connect to db worker via MessageChannel (for other workers)
 * @param {MessagePort} port - The MessagePort connected to db.worker
 */
export function connectToDbWorker(port) {
  if (!port) return;
  if (messagePort === port) return;
  // A new port means the db worker was replaced. Requests sent down the old
  // port will never be answered, so fail them now and switch over.
  if (messagePort) {
    try {
      messagePort.close();
    } catch {
      // already closed
    }
    rejectAllPending(new Error('Database worker terminated'));
  }

  messagePort = port;
  messagePort.onmessage = handleMessage;
  messagePort.start();
  initialized = true;
}

function rejectAllPending(error) {
  for (const [, pending] of pendingRequests) {
    pending.reject(error);
  }
  pendingRequests.clear();
}

/**
 * Subscribe to engine moves: a new db worker came up, the worker was torn
 * down, or the main-thread fallback took over. The listener receives
 * `{ worker, useMainThread }`. Any MessagePort handed out for the previous
 * worker is dead after this fires. Returns an unsubscribe function.
 */
export function onDbWorkerChange(listener) {
  if (typeof listener !== 'function') return () => {};
  workerChangeListeners.add(listener);
  return () => workerChangeListeners.delete(listener);
}

function notifyWorkerChange() {
  const info = { worker, useMainThread };
  for (const listener of workerChangeListeners) {
    try {
      listener(info);
    } catch (err) {
      console.error('[db-worker-client] Worker change listener failed:', err);
    }
  }
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
  const hadWorker = teardownWorker();
  initialized = false;
  initPromise = null;
  if (hadWorker) notifyWorkerChange();
}

// Stop the worker and fail its in-flight requests, leaving the init state
// alone so an init that is switching to the main thread keeps its promise.
function teardownWorker() {
  const hadWorker = Boolean(worker);
  if (worker) {
    worker.terminate();
    worker = null;
  }
  if (messagePort) {
    messagePort.close();
    messagePort = null;
  }
  rejectAllPending(new Error('Database worker terminated'));
  return hadWorker;
}

// ============================================================================
// Query Builder - Mimics Dexie's fluent API
// ============================================================================

class QueryBuilder {
  constructor(tableName, index) {
    this._table = tableName;
    this._index = index;
    this._where = { op: 'equals', value: null };
    this._options = {};
  }

  equals(value) {
    this._where = { op: 'equals', value };
    return this;
  }

  // Dexie accepts anyOf(a, b, c) and anyOf([a, b, c]); a compound index takes
  // an array of key arrays, e.g. anyOf([[account, id1], [account, id2]]).
  anyOf(...args) {
    const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    this._where = { op: 'anyOf', values };
    return this;
  }

  between(lower, upper, includeLower = true, includeUpper = false) {
    this._where = { op: 'between', lower, upper, includeLower, includeUpper };
    this._options.includeLower = includeLower;
    this._options.includeUpper = includeUpper;
    return this;
  }

  startsWith(value) {
    this._where = { op: 'startsWith', value };
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

  reverse() {
    this._options.reverse = true;
    return this;
  }

  // Like Dexie, sortBy() ends the chain and resolves to the sorted array.
  sortBy(field) {
    this._options.sortBy = field;
    return this.toArray();
  }

  _query(queryMode, extra = {}) {
    return send('query', this._table, {
      index: this._index,
      where: this._where,
      queryMode,
      options: this._options,
      ...extra,
    });
  }

  async toArray() {
    const { op } = this._where;
    if (op === 'between') {
      return send('queryBetween', this._table, {
        index: this._index,
        lower: this._where.lower,
        upper: this._where.upper,
        options: this._options,
      });
    }
    if (op === 'startsWith') {
      return send('queryStartsWith', this._table, {
        index: this._index,
        value: this._where.value,
        options: this._options,
      });
    }
    if (op === 'anyOf') {
      return this._query('toArray');
    }
    return send('queryEquals', this._table, {
      index: this._index,
      value: this._where.value,
      options: this._options,
    });
  }

  async first() {
    if (this._where.op !== 'equals') return this._query('first');
    return send('queryEqualsFirst', this._table, {
      index: this._index,
      value: this._where.value,
    });
  }

  async count() {
    if (this._where.op !== 'equals') return this._query('count');
    return send('queryEqualsCount', this._table, {
      index: this._index,
      value: this._where.value,
    });
  }

  async primaryKeys() {
    return this._query('primaryKeys');
  }

  /**
   * Not a Dexie method: resolve to `{ ...fields, approxBytes }` per matching
   * row, read straight from storage without decrypting or shipping whole
   * records. For housekeeping scans such as cache eviction.
   * @param {string[]} fields - plaintext fields to copy into each summary
   */
  async summaries(fields = []) {
    return this._query('summaries', { fields });
  }

  /**
   * Not a Dexie method: matching rows, decrypted, with only these fields.
   * @param {string[]} fields
   */
  async pickFields(fields = []) {
    return this._query('fields', { fields });
  }

  async delete() {
    const captured = captureWrite(this._table, 'query', {
      index: this._index,
      where: this._where,
      queryMode: 'delete',
    });
    if (captured) return captured;
    if (this._where.op !== 'equals') return this._query('delete');
    return send('queryEqualsDelete', this._table, {
      index: this._index,
      value: this._where.value,
    });
  }

  async modify(changes) {
    if (typeof changes === 'function') {
      throw new Error('db worker modify does not support function callbacks; pass an object');
    }
    const captured = captureWrite(this._table, 'query', {
      index: this._index,
      where: this._where,
      queryMode: 'modify',
      changes,
    });
    if (captured) return captured;
    if (this._where.op !== 'equals') return this._query('modify', { changes });
    return send('queryEqualsModify', this._table, {
      index: this._index,
      value: this._where.value,
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
    return captureWrite(this._table, 'put', { record }) || send('put', this._table, { record });
  }

  delete(key) {
    return captureWrite(this._table, 'delete', { key }) || send('delete', this._table, { key });
  }

  update(key, changes) {
    return (
      captureWrite(this._table, 'update', { key, changes }) ||
      send('update', this._table, { key, changes })
    );
  }

  clear() {
    return captureWrite(this._table, 'clear', {}) || send('clear', this._table);
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

  // Searchable text only, for body records (see bodyTexts in db-engine).
  bodyTexts(keys) {
    return send('bodyTexts', this._table, { keys });
  }

  // One page of an index match in a sort order with no index (subject,
  // sender), sorted in the worker (see sortedPage in db-engine).
  sortedPage(index, value, { order, offset = 0, limit = 50 } = {}) {
    return send('sortedPage', this._table, { index, value, order, offset, limit });
  }

  bulkPut(records) {
    return (
      captureWrite(this._table, 'bulkPut', { records }) || send('bulkPut', this._table, { records })
    );
  }

  bulkDelete(keys) {
    return (
      captureWrite(this._table, 'bulkDelete', { keys }) || send('bulkDelete', this._table, { keys })
    );
  }

  // Query builder
  where(index) {
    return new QueryBuilder(this._table, index);
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

// The read-write transaction whose callback is running right now, if any.
// While it is set, writes made through the table proxies to its tables are
// collected instead of sent, and the whole batch is sent as one engine
// transaction when the callback returns.
let activeTx = null;

/**
 * Queue a write into the running transaction. Returns a resolved promise when
 * the write was captured, or null when it should be sent on its own.
 */
function captureWrite(table, action, payload) {
  if (!activeTx || !activeTx.tables.has(table)) return null;
  activeTx.ops.push({ action, table, payload });
  return Promise.resolve(undefined);
}

/**
 * Run multiple operations in one transaction, Dexie style:
 *
 *   await db.transaction('rw', db.folders, async () => {
 *     await db.folders.where('account').equals(account).delete();
 *     await db.folders.bulkPut(rows);
 *   });
 *
 * Writes made on the listed tables while the callback runs are collected and
 * then committed by the engine as a single IndexedDB transaction, so either
 * all of them land or none do. Two consequences of batching: a captured write
 * resolves immediately with no value, and a read inside the callback sees the
 * data as it was before the transaction. Keep the callback to writes plus
 * synchronous logic, which is what every caller in the app does.
 *
 * @param {string} mode - 'r' for read, 'rw' for read-write
 * @param {...(string|object)} args - Tables involved, then the callback
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
  const writable = typeof mode === 'string' && mode.includes('w');

  // A transaction opened inside another one joins it, as in Dexie.
  if (activeTx && writable) {
    for (const t of tables) activeTx.tables.add(t);
    return callback(activeTx.proxy);
  }

  const ops = [];
  let usedProxy = false;
  const txProxy = {
    table: (name) => {
      usedProxy = true;
      return {
        get: (key) => ops.push({ action: 'get', table: name, payload: { key } }),
        put: (record) => ops.push({ action: 'put', table: name, payload: { record } }),
        delete: (key) => ops.push({ action: 'delete', table: name, payload: { key } }),
        bulkPut: (records) => ops.push({ action: 'bulkPut', table: name, payload: { records } }),
        bulkDelete: (keys) => ops.push({ action: 'bulkDelete', table: name, payload: { keys } }),
        clear: () => ops.push({ action: 'clear', table: name }),
        update: (key, changes) =>
          ops.push({ action: 'update', table: name, payload: { key, changes } }),
      };
    },
  };

  let result;
  if (writable) {
    activeTx = { tables: new Set(tables), ops, proxy: txProxy };
    try {
      result = await callback(txProxy);
    } finally {
      activeTx = null;
    }
  } else {
    result = await callback(txProxy);
  }

  if (!ops.length) {
    return result;
  }

  const txResult = await send('transaction', null, { mode, tables, operations: ops });
  return usedProxy ? txResult : result;
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

/**
 * Drop the cached server copies for every account. Drafts and the outbox are
 * kept unless `includeLocalOnly` is set.
 * @param {{includeLocalOnly?: boolean}} [options]
 */
export async function clearCache(options = {}) {
  return send('clearCache', null, { includeLocalOnly: Boolean(options.includeLocalOnly) });
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
