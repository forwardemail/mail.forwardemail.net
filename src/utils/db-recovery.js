/**
 * IndexedDB Recovery Module
 *
 * Simple recovery for database errors - delete and let Dexie recreate.
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

/**
 * Known error types that indicate a need for database recovery
 */
const RECOVERABLE_ERRORS = [
  'VersionError',
  'InvalidStateError',
  'AbortError',
  'NotFoundError',
  'DataError',
  'QuotaExceededError',
  'UnknownError',
];

/**
 * Error messages that indicate schema/version issues
 */
const SCHEMA_ERROR_PATTERNS = [
  /version.*mismatch/i,
  /schema.*change/i,
  /upgrade.*blocked/i,
  /older.*version/i,
  /cannot.*downgrade/i,
  /object.*store.*not.*found/i,
  /index.*not.*found/i,
  /keypath.*invalid/i,
  /blocked/i,
];

/**
 * Check if an error is recoverable by deleting and recreating the database
 */
export function isRecoverableError(error) {
  if (!error) return false;

  const errorName = error.name || '';
  if (RECOVERABLE_ERRORS.includes(errorName)) {
    return true;
  }

  const message = error.message || '';
  return SCHEMA_ERROR_PATTERNS.some((pattern) => pattern.test(message));
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
  const result = await deleteDatabaseByName(DB_NAME);
  if (!result.deleted) {
    throw new Error('Database deletion failed');
  }
  return true;
}

/**
 * Attempt to recover the database by deleting it
 */
export async function attemptRecovery(originalError) {
  warn('[DB Recovery] Attempting recovery due to:', originalError?.message);

  try {
    await deleteDatabase();
    await delay(100);
    return { recovered: true };
  } catch (deleteError) {
    console.error('[DB Recovery] Recovery failed:', deleteError);
    return { recovered: false, error: deleteError };
  }
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
  const webmailDbs = databases.filter((db) => db.name?.startsWith('webmail-cache'));
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
