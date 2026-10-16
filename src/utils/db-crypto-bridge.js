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
  unsealDbForDisable,
  abandonSealedDb,
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
// IDB subkey handed over by another window of this app (the desktop compose
// window has no DEK of its own). Only used while this window is not unlocked.
let externalIdbKey = null;
// What the window that owns the vault last said about App Lock: 'disabling'
// (keep the key for reads, write plaintext) or 'off' (nothing is sealed any
// more). Null until it says anything. Only the compose window sets this.
let externalLockState = null;
// Set while App Lock is being turned off. Any config pushed in that window
// (including after a worker restart) keeps the key for reading but stores new
// writes as plaintext, so nothing written during the sweep is sealed with a
// key that is about to be discarded.
let disablingKey = null;

function atRestEncryptionEnabled() {
  return isLockEnabled() && isVaultConfigured();
}

async function currentCryptoConfig() {
  if (disablingKey) {
    return { required: false, rawKey: disablingKey, sealWrites: false };
  }
  if (externalLockState === 'disabling') {
    return { required: false, rawKey: externalIdbKey, sealWrites: false };
  }
  if (externalLockState === 'off') return { required: false, rawKey: null };
  const required = atRestEncryptionEnabled();
  let rawKey = null;
  if (required) {
    if (isUnlocked()) {
      rawKey = await getIdbCryptoMaterial();
    } else if (externalIdbKey) {
      rawKey = externalIdbKey;
    }
  }
  return { required, rawKey };
}

/**
 * Use an IDB subkey supplied by another window (see compose-main.ts). Pass
 * null to forget it. Pushes the resulting config to the engine right away.
 * @param {Uint8Array|null} rawKey
 */
export async function setExternalIdbKey(rawKey) {
  externalIdbKey = rawKey && rawKey.byteLength === 32 ? rawKey : null;
  await initDbCryptoBridge();
  await applyCryptoConfig();
}

/**
 * Follow an App Lock change made in the window that owns the vault (see
 * compose-crypto-sync.ts). 'locked' forgets the key, 'unlocked' takes a new
 * one, 'disabling' stops sealing while the key is still needed for reads,
 * and 'off' drops the key once nothing is sealed.
 * @param {{ state: 'locked'|'unlocked'|'disabling'|'off', rawKey?: Uint8Array|null }} change
 */
export async function applyExternalLockChange({ state, rawKey = null }) {
  if (state === 'unlocked') {
    externalLockState = null;
    externalIdbKey = rawKey && rawKey.byteLength === 32 ? rawKey : null;
  } else if (state === 'locked') {
    externalLockState = null;
    externalIdbKey = null;
  } else if (state === 'disabling') {
    externalLockState = 'disabling';
  } else if (state === 'off') {
    externalLockState = 'off';
    externalIdbKey = null;
  } else {
    return;
  }
  await initDbCryptoBridge();
  await applyCryptoConfig();
}

// Tell open compose windows about a change here. Loaded lazily: it pulls in
// Tauri APIs that only the desktop build has.
function notifyComposeWindows(state) {
  import('./compose-crypto-sync.ts')
    .then(({ broadcastComposeLockState }) => broadcastComposeLockState(state))
    .catch(() => {});
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
  if (!atRestEncryptionEnabled()) notifyComposeWindows('off');
  else notifyComposeWindows(isUnlocked() ? 'unlocked' : 'locked');
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
 * Pre-disable sweep: decrypt the data that exists only on this device and drop
 * the server copies, which sync fetches again. MUST be awaited by
 * crypto-store.disableLock BEFORE the DEK is wiped, because afterwards the
 * sealed drafts and outbox would be unreachable.
 */
export async function decryptAllIdbData() {
  await initDbCryptoBridge();
  const rawKey = isUnlocked() ? await getIdbCryptoMaterial() : null;
  if (!rawKey) {
    warn('[db-crypto-bridge] Cannot decrypt IDB data without an unlocked vault');
    return null;
  }
  // Keep the key available so the sweep can open sealed rows, but stop
  // sealing: a write that races the sweep must land as plaintext (the
  // post-disable end state). Sealing it with this key would lose it once the
  // key is dropped below. The sweep only rewrites rows it finds unchanged, so
  // it does not overwrite those writes either.
  disablingKey = rawKey;
  await sendCryptoConfig({ required: false, rawKey, sealWrites: false });
  // Compose windows seal with the same key; they must stop before it goes.
  await import('./compose-crypto-sync.ts')
    .then(({ broadcastComposeLockState }) => broadcastComposeLockState('disabling'))
    .catch(() => {});
  try {
    const result = await unsealDbForDisable();
    // Success: the cache is plaintext now, so drop the key too.
    disablingKey = null;
    await sendCryptoConfig({ required: false, rawKey: null });
    return result;
  } catch (err) {
    // The sweep failed and the cache is still (partly) sealed. Restore the
    // live config (required + key) so reads/writes keep working and the caller
    // can abort the disable with data intact, then rethrow. Rows written as
    // plaintext in the meantime stay readable and are sealed again by the
    // next encrypt sweep.
    disablingKey = null;
    await syncDbCryptoState().catch(() => {});
    throw err;
  }
}

/**
 * Give up on an unreadable encrypted cache. Used when disabling App Lock with
 * no key available (e.g. the DEK couldn't be restored): the sealed records
 * can't be decrypted, so remove them and drop the engine's fail-closed flag so
 * the app recovers and re-syncs from the server instead of throwing
 * DbLockedError on every write. Sealed meta rows (queued changes, saved
 * searches, contact, calendar and attachment caches) go too, so nothing is
 * left behind that can never be read; plaintext rows are kept.
 */
export async function abandonEncryptedCache() {
  await initDbCryptoBridge();
  externalIdbKey = null;
  disablingKey = null;
  await sendCryptoConfig({ required: false, rawKey: null });
  try {
    await abandonSealedDb();
  } catch (err) {
    warn('[db-crypto-bridge] Failed to clear encrypted cache', err);
  }
  await updateSwGateFlag();
}
