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
} from './db-worker-client.js';
import { bootstrapReady } from './bootstrap-ready.js';
import { SCHEMA_VERSION, DEXIE_VERSION } from './db-constants.ts';
import {
  getRecoveryInfo,
  clearRecoveryState,
  setTerminateWorkersCallback,
  getRawDatabaseInfo,
  deleteDatabase,
  isRecoverableError,
  attemptRecovery,
  cleanupOldDatabases,
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
        await deleteDatabase();
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
 * Clear all cached data but keep database structure
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
 * Handle database errors with automatic recovery fallback
 * For worker timeouts: terminates worker and deletes database for clean restart
 * For other recoverable errors: attempts cache clear or database reset
 *
 * @param {Error} error - The database error
 * @returns {Promise<{recovered: boolean, method: string | null}>}
 */
export async function handleDatabaseError(error) {
  const errorMessage = error?.message || '';
  const errorCode = error?.code;

  // Check if this is a worker init timeout or related error
  const isWorkerTimeout =
    errorCode === 'DB_WORKER_INIT_TIMEOUT' ||
    /Database worker init timeout/i.test(errorMessage) ||
    /Database worker terminated/i.test(errorMessage) ||
    /Database worker not initialized/i.test(errorMessage);

  if (!isWorkerTimeout && !isRecoverableError(error)) {
    return { recovered: false, method: null };
  }

  warn('[DB] Attempting recovery for database error:', errorMessage);

  if (dbRecoveryCallbacks.onRecoveryStart) {
    try {
      dbRecoveryCallbacks.onRecoveryStart(error);
    } catch {
      // ignore
    }
  }

  // For worker timeout errors, use aggressive recovery (terminate + delete)
  if (isWorkerTimeout) {
    try {
      // Step 1: Terminate the stuck worker
      terminateDbWorker();

      // Step 2: Delete the database using raw IndexedDB API (bypasses worker)
      await deleteDatabase();

      // Step 3: Clear recovery state
      clearRecoveryState();

      if (dbRecoveryCallbacks.onRecoveryComplete) {
        try {
          dbRecoveryCallbacks.onRecoveryComplete();
        } catch {
          // ignore
        }
      }

      return { recovered: true, method: 'force-reset' };
    } catch (forceResetError) {
      console.error('[DB] Force reset failed:', forceResetError);
      // Fall through to try other methods
    }
  }

  // For other recoverable errors, try gentler approaches

  // Step 1: Try to clear cache
  try {
    const cacheCleared = await clearCache();
    if (cacheCleared) {
      if (dbRecoveryCallbacks.onRecoveryComplete) {
        try {
          dbRecoveryCallbacks.onRecoveryComplete();
        } catch {
          // ignore
        }
      }
      return { recovered: true, method: 'cache-clear' };
    }
  } catch (cacheError) {
    warn('[DB] Failed to clear cache:', cacheError);
  }

  // Step 2: Try to reset database if cache clear failed
  try {
    const resetSuccess = await resetDatabase();
    if (resetSuccess) {
      if (dbRecoveryCallbacks.onRecoveryComplete) {
        try {
          dbRecoveryCallbacks.onRecoveryComplete();
        } catch {
          // ignore
        }
      }
      return { recovered: true, method: 'database-reset' };
    }
  } catch (resetError) {
    console.error('[DB] Failed to reset database:', resetError);
  }

  // Recovery failed
  if (dbRecoveryCallbacks.onRecoveryFailed) {
    try {
      dbRecoveryCallbacks.onRecoveryFailed(error);
    } catch {
      // ignore
    }
  }

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
