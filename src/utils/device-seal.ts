/**
 * Sealing for sensitive localStorage values on desktop when App Lock is off.
 *
 * Without App Lock, credentials, the accounts list and PGP private keys used
 * to sit in localStorage as plaintext, which means plaintext in the profile
 * directory on disk. On the desktop app a random key is kept in the OS
 * credential store (src-tauri/src/device_key.rs) and those values are sealed
 * with it before they are written. A copy of the profile directory alone (a
 * backup, a synced home folder, a lost disk) then no longer gives them away.
 * It does not stop code running as the same user, which can ask the
 * credential store for the key as well; App Lock is the answer to that.
 *
 * App Lock takes precedence: while it is on, values are encrypted with the
 * vault key instead (crypto-store.js) and nothing here is used for them.
 *
 * The key is loaded once, before the app reads any credential (src/boot.ts).
 * Sealing and unsealing are synchronous after that, so Local.get stays
 * synchronous. Where there is no credential store (web, mobile, a Linux
 * session without a Secret Service) values stay as they were.
 */
import { isTauriDesktop } from './platform.js';

const SEALED_PREFIX = '\x00DEV\x01';
const KEY_BYTES = 32;
// The app waits for the key before it starts, so the wait has to end. A
// credential store can sit on a prompt indefinitely: macOS asks before a
// binary with a different signature reads the item (every local rebuild),
// and a locked Linux keyring asks to be unlocked.
const STORE_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type Sodium = typeof import('libsodium-wrappers');

let sodium: Sodium | null = null;
let deviceKey: Uint8Array | null = null;

/**
 * Why sealing is or is not in use, for the Diagnostics page. A user who is
 * signed out after an update because their keyring never answered looks, from
 * the outside, exactly like one whose password changed.
 * - unsupported: not the desktop app (web, iOS, Android)
 * - pending: the key has not been asked for yet
 * - on: the key loaded
 * - unavailable: the credential store failed, refused, or did not answer
 */
export type DeviceSealState = 'unsupported' | 'pending' | 'on' | 'unavailable';
let sealState: DeviceSealState = 'pending';
let sealReason = '';
let adoptedLate = false;

export function isDeviceSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

export function hasDeviceKey(): boolean {
  return deviceKey !== null && sodium !== null;
}

async function loadSodium(): Promise<Sodium> {
  if (sodium) return sodium;
  const mod = await import('libsodium-wrappers');
  const loaded = (mod.default || mod) as Sodium;
  await loaded.ready;
  sodium = loaded;
  return loaded;
}

interface DeviceKeyStore {
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
}

// The Tauri API is imported lazily: in web builds it is external, and a
// top-level import would fail to resolve (see unified-push.js).
const tauriStore: DeviceKeyStore = {
  get: async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke<string | null>('device_key_get')) ?? null;
  },
  set: async (value) => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('device_key_set', { value });
  },
};

/**
 * Load the key from the credential store, creating it on first use when
 * `create` is set. Resolves false when there is no usable store; the app then
 * runs exactly as before, with plaintext values.
 *
 * A window that only reads (the compose window) passes create: false, so two
 * windows starting at once cannot each store a different key.
 */
export async function loadDeviceKey(
  { create = true, timeoutMs = STORE_TIMEOUT_MS }: { create?: boolean; timeoutMs?: number } = {},
  store: DeviceKeyStore | null = isTauriDesktop ? tauriStore : null,
): Promise<boolean> {
  if (deviceKey) return true;
  if (!store) {
    sealState = 'unsupported';
    return false;
  }
  try {
    const lib = await loadSodium();
    const first = store.get();
    // A store that answers after the wait (the user allowed the prompt late)
    // still provides the key, for the next read and write in this session.
    first
      .then((late) => {
        if (!deviceKey && late && adoptKey(lib, late)) {
          adoptedLate = true;
          sealState = 'on';
        }
      })
      .catch(() => {});
    let encoded = await withTimeout(first, timeoutMs);
    if (!encoded && create) {
      await withTimeout(store.set(lib.to_base64(lib.randombytes_buf(KEY_BYTES))), timeoutMs);
      // Read it back: on a store that accepts writes but cannot return them,
      // sealing with a key that is gone on the next launch would sign the
      // user out.
      encoded = await withTimeout(store.get(), timeoutMs);
    }
    if (!encoded) {
      sealState = 'unavailable';
      sealReason = create ? 'the store did not keep the key' : 'no key stored yet';
      return false;
    }
    const adopted = adoptKey(lib, encoded);
    sealState = adopted ? 'on' : 'unavailable';
    if (!adopted) sealReason = 'the stored key is malformed';
    return adopted;
  } catch (err) {
    console.warn('[device-seal] OS credential store unavailable; values stay unsealed:', err);
    sealState = 'unavailable';
    sealReason = (err as Error)?.message || String(err);
    return false;
  }
}

function adoptKey(lib: Sodium, encoded: string): boolean {
  try {
    const bytes = lib.from_base64(encoded);
    if (bytes.length !== KEY_BYTES) return false;
    deviceKey = bytes;
    return true;
  } catch {
    return false;
  }
}

/** Seal a value, or return it unchanged when there is no key. */
export function sealForDevice(value: string): string {
  if (!deviceKey || !sodium || typeof value !== 'string' || isDeviceSealed(value)) return value;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(sodium.from_string(value), nonce, deviceKey);
  const packed = new Uint8Array(nonce.length + box.length);
  packed.set(nonce, 0);
  packed.set(box, nonce.length);
  return SEALED_PREFIX + sodium.to_base64(packed);
}

/**
 * The plaintext of a sealed value. Values that are not sealed come back as
 * they are. Null when the value is sealed but cannot be opened here (no key
 * loaded, or a key other than the one it was sealed with); callers treat that
 * as missing, as they do a value App Lock keeps locked.
 */
export function unsealFromDevice(value: string | null): string | null {
  if (!isDeviceSealed(value)) return value;
  if (!deviceKey || !sodium) return null;
  try {
    const packed = sodium.from_base64(value.slice(SEALED_PREFIX.length));
    const nonceLength = sodium.crypto_secretbox_NONCEBYTES;
    if (packed.length <= nonceLength) return null;
    const opened = sodium.crypto_secretbox_open_easy(
      packed.slice(nonceLength),
      packed.slice(0, nonceLength),
      deviceKey,
    );
    return sodium.to_string(opened);
  } catch {
    return null;
  }
}

/**
 * Seal every plaintext value whose key `isSensitive` accepts. Runs at boot,
 * so values written before this existed (or while App Lock was on and then
 * turned off) get sealed. Values App Lock encrypted are left alone.
 */
export function sealExistingLocalStorage(
  isSensitive: (key: string) => boolean,
  isLockEncrypted: (value: string) => boolean,
  prefix = 'webmail_',
): number {
  if (!hasDeviceKey() || typeof localStorage === 'undefined') return 0;
  let sealed = 0;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const fullKey = localStorage.key(i);
    if (fullKey && fullKey.startsWith(prefix) && isSensitive(fullKey.slice(prefix.length))) {
      keys.push(fullKey);
    }
  }
  for (const fullKey of keys) {
    const value = localStorage.getItem(fullKey);
    if (!value || isDeviceSealed(value) || isLockEncrypted(value)) continue;
    try {
      localStorage.setItem(fullKey, sealForDevice(value));
      sealed += 1;
    } catch (err) {
      console.warn('[device-seal] could not seal a stored value:', err);
    }
  }
  return sealed;
}

export interface DeviceSealStatus {
  state: DeviceSealState;
  /** Why the store could not be used, when it could not. */
  reason: string;
  /** The key came after the app had started without it. */
  adoptedLate: boolean;
  /** Stored values sealed with the device key, and how many open with the key loaded now. */
  sealedValues: number;
  readableValues: number;
}

export function getDeviceSealStatus(prefix = 'webmail_'): DeviceSealStatus {
  let sealedValues = 0;
  let readableValues = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const value = localStorage.getItem(key);
      if (!isDeviceSealed(value)) continue;
      sealedValues += 1;
      if (unsealFromDevice(value) !== null) readableValues += 1;
    }
  } catch {
    // storage unavailable: report the state alone
  }
  return { state: sealState, reason: sealReason, adoptedLate, sealedValues, readableValues };
}

/** Test seam: forget the loaded key. */
export function resetDeviceKeyForTests(): void {
  deviceKey = null;
  sealState = 'pending';
  sealReason = '';
  adoptedLate = false;
}
