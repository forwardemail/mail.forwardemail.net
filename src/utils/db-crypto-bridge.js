/**
 * Main-thread glue between the App Lock vault (crypto-store.js) and the DB
 * engine's at-rest encryption (db-crypto.ts).
 *
 * The DEK lives in main-thread memory inside crypto-store; the Dexie engine
 * runs in the db worker (or inline on the WebKitGTK fallback). This module
 * derives a dedicated IDB subkey from the DEK and pushes it, together with
 * the fail-closed `required` flag, into whichever context the engine runs in,
 * on every lock-state transition and after every worker (re)init.
 *
 * It also maintains the plaintext `app_lock_enabled` meta flag that
 * public/sw-sync.js (raw IndexedDB, no key access) checks to skip background
 * content sync while App Lock is active, so the SW can't write plaintext
 * message data behind the engine's back.
 */

import {
  setCryptoConfigProvider,
  applyCryptoConfig,
  sendCryptoConfig,
  reencryptAllDb,
} from './db-worker-client.js';
import { db } from './db';
import {
  isLockEnabled,
  isVaultConfigured,
  isUnlocked,
  getIdbCryptoMaterial,
} from './crypto-store.js';
import { warn } from './logger.ts';

const APP_LOCK_FLAG_KEY = 'app_lock_enabled';

let bridgeInitialized = false;

function atRestEncryptionEnabled() {
  return isLockEnabled() && isVaultConfigured();
}

async function currentCryptoConfig() {
  const required = atRestEncryptionEnabled();
  let rawKey = null;
  if (required && isUnlocked()) {
    rawKey = await getIdbCryptoMaterial();
  }
  return { required, rawKey };
}

async function updateSwGateFlag() {
  try {
    await db.meta.put({
      key: APP_LOCK_FLAG_KEY,
      value: atRestEncryptionEnabled(),
      updatedAt: Date.now(),
    });
  } catch (err) {
    warn('[db-crypto-bridge] Failed to update app_lock_enabled flag:', err);
  }
}

/**
 * Register the config provider with the db client. Call once at bootstrap,
 * before (or around) database initialization; the provider is applied after
 * every successful init automatically.
 */
export async function initDbCryptoBridge() {
  if (bridgeInitialized) return;
  bridgeInitialized = true;
  await setCryptoConfigProvider(currentCryptoConfig);
}

/**
 * Push the current lock state to the engine and refresh the SW gate flag.
 * Called by crypto-store on every lock/unlock/setup/disable transition.
 */
export async function syncDbCryptoState() {
  await initDbCryptoBridge();
  await applyCryptoConfig();
  await updateSwGateFlag();
}

/**
 * One-time sweep after App Lock setup: seal every existing plaintext record.
 * Runs in the engine's context; safe to fire-and-forget.
 */
export async function encryptAllIdbData() {
  await syncDbCryptoState();
  try {
    return await reencryptAllDb('encrypt');
  } catch (err) {
    warn('[db-crypto-bridge] Background encryption sweep failed:', err);
    return null;
  }
}

/**
 * Pre-disable sweep: unwrap every sealed record back to plaintext. MUST be
 * awaited by crypto-store.disableLock BEFORE the DEK is wiped, because afterwards
 * the sealed data would be unreachable.
 */
export async function decryptAllIdbData() {
  await initDbCryptoBridge();
  const rawKey = isUnlocked() ? await getIdbCryptoMaterial() : null;
  if (!rawKey) {
    warn('[db-crypto-bridge] Cannot decrypt IDB data without an unlocked vault');
    return null;
  }
  // Keep the key available for the sweep but drop the fail-closed flag so
  // concurrent writes during the sweep land as plaintext (which is the
  // post-disable end state anyway).
  await sendCryptoConfig({ required: false, rawKey });
  try {
    const result = await reencryptAllDb('decrypt');
    // Success: the cache is plaintext now, so drop the key too.
    await sendCryptoConfig({ required: false, rawKey: null });
    return result;
  } catch (err) {
    // The sweep failed and the cache is still (partly) sealed. Restore the
    // live config (required + key) so reads/writes keep working and the caller
    // can abort the disable with data intact, then rethrow.
    await syncDbCryptoState().catch(() => {});
    throw err;
  }
}

/**
 * Give up on an unreadable encrypted cache. Used when disabling App Lock with
 * no key available (e.g. the DEK couldn't be restored): the sealed records
 * can't be decrypted, so clear them and drop the engine's fail-closed flag so
 * the app recovers and re-syncs from the server instead of throwing
 * DbLockedError on every write.
 */
export async function abandonEncryptedCache() {
  await initDbCryptoBridge();
  await sendCryptoConfig({ required: false, rawKey: null });
  try {
    const { clearCache } = await import('./db-worker-client.js');
    await clearCache();
  } catch (err) {
    warn('[db-crypto-bridge] Failed to clear encrypted cache', err);
  }
  await updateSwGateFlag();
}
