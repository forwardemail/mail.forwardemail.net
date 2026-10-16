/**
 * IndexedDB Recovery Module
 *
 * Recovery is proportional to the error. Timeouts and transient or quota
 * errors never touch stored data. Only corruption that survives a reopen
 * rebuilds the database, and a rebuild first copies out what exists only on
 * this device (drafts, the outbox, queued changes and other meta rows) into a
 * separate stash database, then puts it back once the new database is open.
 * If that copy cannot be made the rebuild is abandoned instead.
 */

import { DB_NAME } from './db-constants';
import { warn } from './logger.ts';

const DELETE_TIMEOUT_MS = 4000;

// Callback to terminate all workers before recovery - set by main app
let terminateWorkersCallback = null;

/**
 * Set callback to terminate all workers before database recovery
 */
export function setTerminateWorkersCallback(callback) {
  terminateWorkersCallback = callback;
}

// Errors that can mean the database itself is broken. Even these only lead
// to a rebuild when they come back after the database has been reopened.
const CORRUPTION_ERRORS = ['VersionError', 'InvalidStateError', 'NotFoundError', 'UnknownError'];

// Errors that say nothing about the stored data: an aborted or inactive
// transaction, a bad key from the caller, a locked vault, an upgrade blocked
// by another tab. Retrying later is the fix; deleting data never is.
const TRANSIENT_ERRORS = [
  'AbortError',
  'DataError',
  'TransactionInactiveError',
  'ReadOnlyError',
  'ConstraintError',
  'TimeoutError',
  'DatabaseClosedError',
  'DbLockedError',
];

/**
 * Error messages that indicate schema/version issues
 */
const SCHEMA_ERROR_PATTERNS = [
  /version.*mismatch/i,
  /schema.*change/i,
  /older.*version/i,
  /cannot.*downgrade/i,
  /object.*store.*not.*found/i,
  /index.*not.*found/i,
  /keypath.*invalid/i,
];

const TIMEOUT_CODES = [
  'DB_WORKER_INIT_TIMEOUT',
  'DB_WORKER_NO_BOOT',
  'DB_WORKER_PROBE_TIMEOUT',
  'DB_REQUEST_TIMEOUT',
];
const TIMEOUT_PATTERN =
  /Database worker init timeout|Database worker terminated|Database worker not initialized|Database request timed out/i;

/**
 * Sort a database error into what recovery it calls for:
 * - 'timeout': the worker is stuck or gone. Restart it; never delete.
 * - 'quota': storage is full. Free space from server copies.
 * - 'transient': nothing to repair.
 * - 'corruption': may need a rebuild if it survives a reopen.
 * Returns null for errors that are not database errors at all.
 */
export function classifyDatabaseError(error) {
  if (!error) return null;
  const name = error.name || '';
  const code = error.code;
  const message = error.message || '';

  if (TIMEOUT_CODES.includes(code) || TIMEOUT_PATTERN.test(message)) return 'timeout';
  if (name === 'QuotaExceededError' || /quota/i.test(message)) return 'quota';
  if (code === 'DB_LOCKED' || TRANSIENT_ERRORS.includes(name)) return 'transient';
  // Dexie wraps the real cause of a failed open.
  if (name === 'OpenFailedError' && error.inner) {
    return classifyDatabaseError(error.inner) || 'transient';
  }
  if (CORRUPTION_ERRORS.includes(name)) return 'corruption';
  if (SCHEMA_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return 'corruption';
  if (/blocked/i.test(message)) return 'transient';
  return null;
}

/**
 * True only for errors that can justify rebuilding the database (possible
 * corruption). Quota, timeout and transient errors are not recoverable this
 * way: rebuilding would destroy data without fixing anything.
 */
export function isRecoverableError(error) {
  return classifyDatabaseError(error) === 'corruption';
}

async function terminateWorkers() {
  if (!terminateWorkersCallback) return;
  try {
    await Promise.resolve(terminateWorkersCallback());
  } catch (err) {
    warn('[DB Recovery] Worker termination failed:', err);
  }
}

/**
 * Ask the service worker (if any) to close every IndexedDB handle it holds.
 * The SW's own `versionchange` handler is not reliable when a transaction is
 * in flight, so we close explicitly and await an ack before calling
 * indexedDB.deleteDatabase() — otherwise the SW can keep the handle open
 * long enough to block the delete and trigger our 4s deletion timeout.
 * Silent no-op when no SW is registered or no ack arrives within `timeoutMs`.
 */
async function closeServiceWorkerDb(timeoutMs = 1500) {
  try {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
    const target = sw?.controller;
    if (!target) return;
    const channel = new MessageChannel();
    const ack = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      channel.port1.onmessage = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    target.postMessage({ type: 'close-idb' }, [channel.port2]);
    await ack;
  } catch (err) {
    warn('[DB Recovery] Could not signal SW to close IDB:', err);
  }
}

/**
 * Tell the service worker it may open IndexedDB again after a recovery delete.
 * Symmetric counterpart to closeServiceWorkerDb(): `close-idb` latches the SW's
 * `allowOpen` flag to false so the in-flight delete isn't blocked, and this
 * `reopen-idb` resets it to true. Without this, the SW can never reopen the DB
 * and every future background sync fails with "SW IDB closed for recovery",
 * forcing the app onto slow live-network fetches.
 * Silent no-op when no SW is registered or no ack arrives within `timeoutMs`.
 */
async function reopenServiceWorkerDb(timeoutMs = 1500) {
  try {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
    const target = sw?.controller;
    if (!target) return;
    const channel = new MessageChannel();
    const ack = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      channel.port1.onmessage = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    target.postMessage({ type: 'reopen-idb' }, [channel.port2]);
    await ack;
  } catch (err) {
    warn('[DB Recovery] Could not signal SW to reopen IDB:', err);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteDatabaseByName(name, options = {}) {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB not available');
  }

  const { timeoutMs = DELETE_TIMEOUT_MS } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const request = indexedDB.deleteDatabase(name);

    if (timeoutMs) {
      timer = setTimeout(() => {
        finish(null, new Error(`Database deletion timed out: ${name}`));
      }, timeoutMs);
    }

    request.onsuccess = () => finish({ deleted: true });
    request.onerror = () =>
      finish(null, request.error || new Error(`Failed to delete database: ${name}`));
    request.onblocked = () => {
      warn('[DB Recovery] Database deletion blocked, terminating workers');
      terminateWorkers();
    };
  });
}

/**
 * Delete the IndexedDB database
 */
export async function deleteDatabase() {
  await terminateWorkers();
  await closeServiceWorkerDb();
  await delay(100);
  try {
    const result = await deleteDatabaseByName(DB_NAME);
    if (!result.deleted) {
      throw new Error('Database deletion failed');
    }
    return true;
  } finally {
    // Always re-allow the SW to open IndexedDB, even if the delete failed —
    // leaving it latched closed permanently breaks background sync.
    await reopenServiceWorkerDb();
  }
}

// ---------------------------------------------------------------------------
// Local-only data stash
// ---------------------------------------------------------------------------

// Separate database so it survives deleting the cache. Its name does not
// start with the cache prefix, so cleanupOldDatabases leaves it alone.
export const RECOVERY_STASH_DB = 'webmail-recovery-stash';
const STASH_STORE = 'rows';

// Tables whose rows exist only on this device.
const LOCAL_ONLY_TABLES = ['drafts', 'outbox'];
// Meta rows that are copies of server data or downloaded blobs. They can be
// fetched again and can be large, so they are not stashed.
const META_SKIP_PREFIXES = [
  'att_blob_',
  'att_cache_manifest',
  'contacts_',
  'calendars_',
  'calendar_events_',
  '__db_worker_probe__',
];

function keyAfterPrefix(prefix) {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Open the cache database as it is, without creating or upgrading it. */
function openExistingDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open database'));
    request.onupgradeneeded = (event) => {
      // No database yet: nothing to save. Abort so we do not create one.
      try {
        event.target.transaction.abort();
      } catch {
        /* ignore */
      }
      resolve(null);
    };
  });
}

function readAllRows(idb, storeName) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const tx = idb.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(rows);
        return;
      }
      if (storeName === 'meta' && typeof cursor.key === 'string') {
        const skip = META_SKIP_PREFIXES.find((prefix) => cursor.key.startsWith(prefix));
        if (skip) {
          // Jump past the whole family without reading the rest of it.
          cursor.continue(keyAfterPrefix(skip));
          return;
        }
      }
      rows.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error || new Error(`Reading ${storeName} was aborted`));
  });
}

/**
 * Copy drafts, the outbox and the meta rows that matter (queued changes,
 * saved searches, flags) straight out of IndexedDB, exactly as stored: sealed
 * rows stay sealed. Throws if any of it cannot be read.
 */
export async function snapshotLocalOnlyData() {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB not available');
  const idb = await openExistingDatabase();
  if (!idb) return {};
  try {
    const snapshot = {};
    for (const table of [...LOCAL_ONLY_TABLES, 'meta']) {
      // A store that is missing holds nothing to lose.
      if (!idb.objectStoreNames.contains(table)) continue;
      const rows = await readAllRows(idb, table);
      if (rows.length) snapshot[table] = rows;
    }
    return snapshot;
  } finally {
    idb.close();
  }
}

function openStash() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECOVERY_STASH_DB, 1);
    request.onupgradeneeded = () => {
      const stash = request.result;
      if (!stash.objectStoreNames.contains(STASH_STORE)) {
        stash.createObjectStore(STASH_STORE, { keyPath: 'table' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeStash(snapshot) {
  const stash = await openStash();
  try {
    await new Promise((resolve, reject) => {
      const tx = stash.transaction(STASH_STORE, 'readwrite');
      const store = tx.objectStore(STASH_STORE);
      for (const [table, rows] of Object.entries(snapshot)) {
        // Merge with rows left over from an earlier rebuild that was never
        // restored, so a second rebuild cannot drop them.
        const getReq = store.get(table);
        getReq.onsuccess = () => {
          const previous = getReq.result?.rows || [];
          store.put({ table, rows: [...previous, ...rows], savedAt: Date.now() });
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Writing the recovery stash was aborted'));
    });
  } finally {
    stash.close();
  }
}

async function stashExists() {
  if (typeof indexedDB === 'undefined') return false;
  if (typeof indexedDB.databases === 'function') {
    try {
      const dbs = await indexedDB.databases();
      return dbs.some((info) => info.name === RECOVERY_STASH_DB);
    } catch {
      // fall through and open it
    }
  }
  return true;
}

/**
 * Put stashed rows back through `restore(table, rows)` once the rebuilt
 * database is open, then delete the stash. Rows already present are not
 * overwritten (restoreRaw in the engine handles that). Safe to call on every
 * boot: it does nothing when there is no stash. The stash is kept if any
 * table fails to restore, so the next boot tries again.
 */
export async function restorePendingStash(restore) {
  if (!(await stashExists())) return null;
  let stash;
  try {
    stash = await openStash();
  } catch (err) {
    warn('[DB Recovery] Could not open recovery stash:', err);
    return null;
  }
  let entries = [];
  try {
    const tx = stash.transaction(STASH_STORE, 'readonly');
    entries = await requestToPromise(tx.objectStore(STASH_STORE).getAll());
  } finally {
    stash.close();
  }
  if (!entries.length) {
    await deleteDatabaseByName(RECOVERY_STASH_DB, { timeoutMs: 2000 }).catch(() => {});
    return null;
  }
  const restored = {};
  for (const entry of entries) {
    if (!entry?.rows?.length) continue;
    // Throws to the caller and keeps the stash if the restore fails.
    restored[entry.table] = await restore(entry.table, entry.rows);
  }
  await deleteDatabaseByName(RECOVERY_STASH_DB, { timeoutMs: 2000 }).catch((err) => {
    warn('[DB Recovery] Could not delete recovery stash:', err);
  });
  return restored;
}

/**
 * Delete and recreate the cache database without losing what exists only on
 * this device. The local-only rows are copied into the stash first; if that
 * copy fails, nothing is deleted and recovery reports failure instead.
 * Callers restore the stash with restorePendingStash after reopening.
 */
export async function rebuildDatabasePreservingLocalData() {
  let snapshot;
  try {
    snapshot = await snapshotLocalOnlyData();
    if (Object.keys(snapshot).length) {
      await writeStash(snapshot);
    }
  } catch (error) {
    console.error('[DB Recovery] Could not save local data; not rebuilding the database:', error);
    return { recovered: false, error, reason: 'snapshot-failed' };
  }

  try {
    await deleteDatabase();
    await delay(100);
  } catch (deleteError) {
    console.error('[DB Recovery] Recovery failed:', deleteError);
    return { recovered: false, error: deleteError };
  }
  const preserved = {};
  for (const [table, rows] of Object.entries(snapshot)) preserved[table] = rows.length;
  return { recovered: true, preserved };
}

/**
 * Attempt to recover the database from a corruption-class error by
 * rebuilding it. Any other error is refused: deleting the cache does not fix
 * a full disk, a timeout or an aborted transaction, and used to wipe drafts
 * and the outbox for every account.
 */
export async function attemptRecovery(originalError) {
  const kind = classifyDatabaseError(originalError);
  if (kind !== 'corruption') {
    warn('[DB Recovery] Not rebuilding the database for a non-corruption error:', kind);
    return { recovered: false, skipped: true, reason: kind || 'unknown' };
  }
  warn('[DB Recovery] Attempting recovery due to:', originalError?.message);
  return rebuildDatabasePreservingLocalData();
}

/**
 * Open database with recovery support
 */
export async function openWithRecovery(db, callbacks = {}) {
  const { onRecoveryStart, onRecoveryComplete, onRecoveryFailed } = callbacks;

  try {
    if (!db.isOpen()) {
      await db.open();
    }
    return db;
  } catch (error) {
    console.error('[DB Recovery] Database open failed:', error);

    if (!isRecoverableError(error)) {
      throw error;
    }

    if (onRecoveryStart) {
      try {
        onRecoveryStart(error);
      } catch {
        /* ignore callback errors */
      }
    }

    try {
      db.close();
    } catch {
      /* ignore close errors */
    }

    const result = await attemptRecovery(error);

    if (result.recovered) {
      if (onRecoveryComplete) {
        try {
          onRecoveryComplete();
        } catch {
          /* ignore callback errors */
        }
      }

      try {
        await db.open();
        return db;
      } catch (reopenError) {
        console.error('[DB Recovery] Failed to open after recovery:', reopenError);
        if (onRecoveryFailed) {
          try {
            onRecoveryFailed(reopenError);
          } catch {
            /* ignore callback errors */
          }
        }
        throw reopenError;
      }
    } else {
      if (onRecoveryFailed) {
        try {
          onRecoveryFailed(result.error);
        } catch {
          /* ignore callback errors */
        }
      }
      throw result.error || error;
    }
  }
}

/**
 * Initialize database with recovery support
 */
export async function initializeWithRecovery(db, callbacks = {}) {
  try {
    await openWithRecovery(db, callbacks);
    return { success: true, recovered: false };
  } catch (error) {
    return { success: false, recovered: false, error };
  }
}

/**
 * Force delete all webmail databases (manual escape hatch)
 */
export async function forceDeleteAllDatabases() {
  await terminateWorkers();
  await delay(200);

  const databases = (await indexedDB.databases?.()) || [];
  // The recovery stash holds drafts and queued changes, so a full sign-out
  // removes it too.
  const webmailDbs = databases.filter(
    (db) => db.name?.startsWith('webmail-cache') || db.name === RECOVERY_STASH_DB,
  );
  const deleted = [];

  for (const dbInfo of webmailDbs) {
    try {
      await deleteDatabaseByName(dbInfo.name, { timeoutMs: 5000 });
      deleted.push(dbInfo.name);
    } catch (err) {
      console.error(`[DB Recovery] Failed to delete ${dbInfo.name}:`, err);
    }
  }

  return { deleted };
}

/**
 * Get basic database info using raw IndexedDB API
 */
export async function getRawDatabaseInfo() {
  if (typeof indexedDB === 'undefined') return null;

  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME);

    request.onsuccess = () => {
      const db = request.result;
      const info = {
        name: db.name,
        version: db.version,
        objectStoreNames: Array.from(db.objectStoreNames),
      };
      db.close();
      resolve(info);
    };

    request.onerror = () => resolve(null);

    request.onupgradeneeded = (event) => {
      try {
        event.target.result.close();
      } catch {
        /* ignore */
      }
      try {
        event.target.transaction.abort();
      } catch {
        /* ignore */
      }
      resolve(null);
    };
  });
}

/**
 * No-op for backwards compatibility (we no longer track recovery state)
 */
export function clearRecoveryState() {}

/**
 * Returns empty recovery info for backwards compatibility
 */
export function getRecoveryInfo() {
  return {};
}

/**
 * Cleanup old database versions
 */
export async function cleanupOldDatabases() {
  if (typeof indexedDB.databases !== 'function') {
    return { deleted: [] };
  }

  const databases = (await indexedDB.databases?.()) || [];
  const namePrefix = DB_NAME.split('-v')[0];
  const candidates = databases.filter((db) => {
    const name = db.name || '';
    if (!name || name === DB_NAME) return false;
    return name === namePrefix || name.startsWith(`${namePrefix}-v`);
  });

  const deleted = [];
  for (const dbInfo of candidates) {
    if (!dbInfo.name) continue;
    try {
      await deleteDatabaseByName(dbInfo.name, { timeoutMs: 5000 });
      deleted.push(dbInfo.name);
    } catch (err) {
      warn(`[DB Recovery] Failed to cleanup ${dbInfo.name}:`, err);
    }
  }

  return { deleted };
}
