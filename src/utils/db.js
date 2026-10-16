/**
 * Database Access Layer
 *
 * This module provides backward-compatible database access that routes
 * all operations through the dedicated db.worker.js.
 *
 * ARCHITECTURE:
 * - Main thread code imports `db` from this file
 * - All operations are proxied to db.worker.js via db-worker-client
 * - This eliminates version conflicts from multiple Dexie instances
 *
 * MIGRATION NOTE:
 * New code should import directly from db-worker-client:
 *   import { dbClient } from './db-worker-client';
 *
 * Existing code can continue using:
 *   import { db } from './db';
 */

import {
  dbClient,
  initDbClient,
  terminateDbWorker,
  getDbWorker,
  isDbUsingMainThread,
  getDatabaseInfo as getDbInfo,
  clearCache as clearDbCache,
  resetDatabase as resetDb,
  restoreRawRows,
} from './db-worker-client.js';
import { bootstrapReady } from './bootstrap-ready.js';
import { SCHEMA_VERSION, DEXIE_VERSION } from './db-constants.ts';
import {
  getRecoveryInfo,
  clearRecoveryState,
  setTerminateWorkersCallback,
  getRawDatabaseInfo,
  isRecoverableError,
  attemptRecovery,
  cleanupOldDatabases,
  classifyDatabaseError,
  rebuildDatabasePreservingLocalData,
  restorePendingStash,
} from './db-recovery.js';
import { warn } from './logger.ts';

// Re-export schema version
export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;

// Track initialization state
let dbInitialized = false;
let dbInitPromise = null;
let dbRecoveryCallbacks = {
  onRecoveryStart: null,
  onRecoveryComplete: null,
  onRecoveryFailed: null,
};

/**
 * Set callbacks for database recovery events
 */
export function setRecoveryCallbacks(callbacks) {
  dbRecoveryCallbacks = {
    ...dbRecoveryCallbacks,
    ...callbacks,
  };
}

/**
 * Check for version compatibility and handle downgrades
 */
async function ensureVersionCompatibility() {
  try {
    const rawInfo = await getRawDatabaseInfo();
    const normalizeDexieVersion = (rawVersion) => {
      if (!Number.isFinite(rawVersion)) {
        return rawVersion;
      }

      if (rawVersion >= 10 && rawVersion % 10 === 0) {
        return rawVersion / 10;
      }

      return rawVersion;
    };
    const normalizedVersion = rawInfo ? normalizeDexieVersion(rawInfo.version) : null;

    // Downgrade guard: an OLDER app build opening a database created by a
    // NEWER build can't parse the schema, so wipe and re-sync. Compare
    // against the Dexie schema version (in-place upgrades bump it), NOT
    // SCHEMA_VERSION (the database-name generation, still 1). Comparing
    // against SCHEMA_VERSION here would treat every upgraded database as
    // "from the future" and wipe the cache on every boot.
    if (rawInfo && normalizedVersion > DEXIE_VERSION) {
      const error = new Error(
        `Found newer schema (${normalizedVersion}) than expected (${DEXIE_VERSION}); forcing reset`,
      );
      warn(`[DB] ${error.message}`);

      if (dbRecoveryCallbacks.onRecoveryStart) {
        try {
          dbRecoveryCallbacks.onRecoveryStart(error);
        } catch {
          // ignore callback errors
        }
      }

      try {
        const rebuilt = await rebuildDatabasePreservingLocalData();
        if (!rebuilt.recovered) {
          throw rebuilt.error || new Error('Database rebuild was abandoned');
        }
        clearRecoveryState();
        if (dbRecoveryCallbacks.onRecoveryComplete) {
          try {
            dbRecoveryCallbacks.onRecoveryComplete();
          } catch {
            // ignore callback errors
          }
        }
      } catch (deleteError) {
        if (dbRecoveryCallbacks.onRecoveryFailed) {
          try {
            dbRecoveryCallbacks.onRecoveryFailed(deleteError);
          } catch {
            // ignore callback errors
          }
        }
        throw deleteError;
      }
    }
  } catch (err) {
    warn('[DB] Could not check database version for compatibility', err);
  }
}

/**
 * Initialize the database worker and ensure it's ready
 *
 * @returns {Promise<{success: boolean, recovered: boolean, error?: Error}>}
 */
export async function initializeDatabase() {
  if (dbInitPromise) {
    return dbInitPromise;
  }

  if (dbInitialized) {
    return { success: true, recovered: false };
  }

  dbInitPromise = (async () => {
    try {
      if (import.meta.env.DEV) {
        await bootstrapReady;
      }
      // Check version compatibility before starting the worker
      await ensureVersionCompatibility();
      await cleanupOldDatabases();

      // Initialize the db worker client
      let result;
      try {
        result = await initDbClient();
      } catch (error) {
        if (
          error?.code === 'DB_WORKER_INIT_TIMEOUT' ||
          /Database worker terminated/i.test(error?.message || '')
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          result = await initDbClient();
        } else {
          throw error;
        }
      }

      if (result?.success) {
        dbInitialized = true;
        await getDbInfo();
        await restoreStashedLocalData();
      }

      return { success: true, recovered: false };
    } catch (error) {
      console.error('[DB] Database initialization failed:', error);

      const errorMessage = error?.message || '';
      const isWorkerTimeout =
        error?.code === 'DB_WORKER_INIT_TIMEOUT' ||
        /Database worker init timeout/i.test(errorMessage) ||
        /Database worker terminated/i.test(errorMessage) ||
        /Database worker not initialized/i.test(errorMessage);

      if (isWorkerTimeout) {
        const recovery = await handleDatabaseError(error);
        if (recovery.recovered) {
          try {
            await initDbClient();
            dbInitialized = true;
            return { success: true, recovered: true };
          } catch (retryError) {
            console.error('[DB] Retry after worker recovery failed:', retryError);
          }
        }
        return { success: false, recovered: false, error };
      }

      // Attempt recovery if this is a recoverable error
      if (isRecoverableError(error)) {
        if (dbRecoveryCallbacks.onRecoveryStart) {
          try {
            dbRecoveryCallbacks.onRecoveryStart(error);
          } catch {
            // ignore
          }
        }

        const recovery = await attemptRecovery(error);
        if (recovery.recovered) {
          if (dbRecoveryCallbacks.onRecoveryComplete) {
            try {
              dbRecoveryCallbacks.onRecoveryComplete();
            } catch {
              // ignore
            }
          }

          // Retry initialization after recovery
          try {
            await initDbClient();
            dbInitialized = true;
            await restoreStashedLocalData();
            return { success: true, recovered: true };
          } catch (retryError) {
            console.error('[DB] Retry after recovery failed:', retryError);
          }
        }

        if (dbRecoveryCallbacks.onRecoveryFailed) {
          try {
            dbRecoveryCallbacks.onRecoveryFailed(error);
          } catch {
            // ignore
          }
        }
      }

      return { success: false, recovered: false, error };
    } finally {
      dbInitPromise = null;
    }
  })();

  return dbInitPromise;
}

/**
 * Ensure database is ready
 */
export async function ensureDbReady() {
  if (dbInitialized && dbClient.isOpen) {
    return true;
  }

  try {
    const result = await initializeDatabase();
    return result.success;
  } catch (error) {
    console.error('[DB] Failed to ensure database ready:', error);
    return false;
  }
}

/**
 * Reset the entire database
 */
export async function resetDatabase() {
  try {
    const result = await resetDb();
    if (result?.success) {
      clearRecoveryState();
    }
    return result?.success ?? false;
  } catch (error) {
    console.error('[DB] Failed to reset database:', error);
    return false;
  }
}

/**
 * Clear cached server data for every account but keep drafts, the outbox and
 * the meta table.
 */
export async function clearCache() {
  try {
    await clearDbCache();
    return true;
  } catch (error) {
    console.error('[DB] Failed to clear cache:', error);
    return false;
  }
}

/**
 * Bring back drafts, outbox items and queued changes saved by a recovery
 * rebuild (possibly in an earlier session that reloaded before restoring).
 */
async function restoreStashedLocalData() {
  try {
    await restorePendingStash((table, rows) => restoreRawRows(table, rows));
  } catch (err) {
    warn('[DB] Restoring local data after a rebuild failed; will retry next boot', err);
  }
}

// A corruption-class error gets one reopen. If another one arrives within
// this window the reopen did not help, and the database is rebuilt.
const CORRUPTION_REOPEN_WINDOW_MS = 5 * 60 * 1000;
let lastCorruptionReopenAt = 0;

function fireRecoveryCallback(name, arg) {
  const callback = dbRecoveryCallbacks[name];
  if (!callback) return;
  try {
    callback(arg);
  } catch {
    // ignore callback errors
  }
}

async function freeSpaceForQuota() {
  try {
    const { cacheManager } = await import('./cache-manager.js');
    const info = await cacheManager.getStorageInfo();
    const target = Math.max((info.quota || 0) * cacheManager.evictionTarget, 5 * 1024 * 1024);
    const result = await cacheManager.evictOldest(target);
    return result?.freedBytes > 0;
  } catch (err) {
    warn('[DB] Freeing space after a quota error failed:', err);
    return false;
  }
}

/**
 * Handle a database error with recovery proportional to its cause. Stored
 * data is only ever rebuilt for corruption that survives a reopen, and even
 * then drafts, the outbox and queued changes are carried over (or the rebuild
 * is abandoned). Every other path leaves stored data alone:
 * - timeout (stuck or dead worker): restart the worker, which falls back to
 *   the main thread if it has to. Never deletes the database.
 * - quota: evict cached message bodies and metadata, oldest and least
 *   important first. Drafts and the outbox are never evicted.
 * - transient (aborted transaction, locked vault, blocked upgrade): nothing.
 *
 * @param {Error} error - The database error
 * @returns {Promise<{recovered: boolean, method: string | null}>}
 */
export async function handleDatabaseError(error) {
  const kind = classifyDatabaseError(error);

  if (kind === 'timeout') {
    try {
      terminateDbWorker();
      await initDbClient();
      dbInitialized = true;
      return { recovered: true, method: 'restart-worker' };
    } catch (restartError) {
      console.error('[DB] Restarting the database worker failed:', restartError);
      return { recovered: false, method: null };
    }
  }

  if (kind === 'quota') {
    const freed = await freeSpaceForQuota();
    return { recovered: freed, method: freed ? 'evict' : null };
  }

  if (kind !== 'corruption') {
    return { recovered: false, method: null };
  }

  warn('[DB] Database error that may be corruption:', error?.message);

  const now = Date.now();
  if (now - lastCorruptionReopenAt > CORRUPTION_REOPEN_WINDOW_MS) {
    lastCorruptionReopenAt = now;
    try {
      terminateDbWorker();
      await initDbClient();
      await getDbInfo();
      dbInitialized = true;
      return { recovered: true, method: 'reopen' };
    } catch (reopenError) {
      warn('[DB] Reopen did not help; rebuilding:', reopenError?.message);
    }
  }

  // The error came back after a reopen: rebuild, keeping local-only data.
  fireRecoveryCallback('onRecoveryStart', error);
  try {
    terminateDbWorker();
    const rebuilt = await rebuildDatabasePreservingLocalData();
    if (rebuilt.recovered) {
      clearRecoveryState();
      await initDbClient();
      dbInitialized = true;
      await restoreStashedLocalData();
      lastCorruptionReopenAt = 0;
      fireRecoveryCallback('onRecoveryComplete');
      return { recovered: true, method: 'rebuild' };
    }
  } catch (rebuildError) {
    console.error('[DB] Rebuilding the database failed:', rebuildError);
  }

  fireRecoveryCallback('onRecoveryFailed', error);
  return { recovered: false, method: null };
}

/**
 * Get database version and metadata
 */
export async function getDatabaseInfo() {
  try {
    await ensureDbReady();
    const info = await getDbInfo();
    return {
      ...info,
      expectedVersion: DEXIE_VERSION,
      initialized: dbInitialized,
      recovery: getRecoveryInfo(),
    };
  } catch (error) {
    console.error('[DB] Failed to get database info:', error);
    return {
      error: error.message,
      isOpen: false,
      initialized: dbInitialized,
      recovery: getRecoveryInfo(),
    };
  }
}

/**
 * Verify database integrity
 */
export async function verifyDatabaseIntegrity() {
  try {
    const ready = await ensureDbReady();
    if (!ready) {
      return { error: 'Database not ready' };
    }

    const info = await getDbInfo();
    const results = {};

    // Check each table has a count
    if (info.counts) {
      for (const [table, count] of Object.entries(info.counts)) {
        results[table] = count >= 0 ? 'ok' : 'error';
      }
    }

    return results;
  } catch (error) {
    console.error('[DB] Database integrity check failed:', error);

    if (isRecoverableError(error)) {
      const recovery = await attemptRecovery(error);
      if (recovery.recovered) {
        return { _recovered: true, _message: 'Database was recovered' };
      }
    }

    return { error: error.message };
  }
}

/**
 * Get the db worker (for setting up MessageChannels with other workers)
 */
export { getDbWorker, isDbUsingMainThread };

/**
 * Terminate the database worker
 */
export { terminateDbWorker };

// ============================================================================
// Backward-compatible `db` export
// ============================================================================

/**
 * Database client with Dexie-like API
 *
 * This is a drop-in replacement for the old direct Dexie instance.
 * All operations are routed through the db worker.
 *
 * @example
 * import { db } from './db';
 *
 * // Works the same as before
 * const messages = await db.messages.where('[account+folder]').equals([account, folder]).toArray();
 * await db.folders.bulkPut(folderRecords);
 */
export const db = dbClient;

// Re-export recovery utilities
export { getRecoveryInfo, clearRecoveryState, setTerminateWorkersCallback };

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    terminateDbWorker();
    dbInitialized = false;
    dbInitPromise = null;
  });

  import.meta.hot.accept();
}

/*
 * ============================================================================
 * SCHEMA UPGRADE GUIDE
 * ============================================================================
 *
 * Schema is defined in db-engine.ts. When making schema changes:
 *
 * 1. For index/field changes within the same database: bump DEXIE_VERSION in
 *    db-constants.ts and add a new this.version(N).stores() declaration in
 *    db-engine.ts (keep the old declarations so installs upgrade in place).
 * 2. Only bump SCHEMA_VERSION (the database NAME generation, must match
 *    public/sw-sync.js) for a truly incompatible layout that requires a
 *    fresh database and full re-sync.
 *
 * For complex migrations, add an .upgrade() callback to the new version in
 * db-engine.ts.
 *
 * ============================================================================
 */
