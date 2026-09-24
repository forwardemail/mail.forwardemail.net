/**
 * The app's one Argon2id cost profile.
 *
 * Both password-derived keys in the app go through this: the App Lock KEK
 * (crypto-store.js) and the QR pairing-code key wrap (device-sync). They must
 * share one implementation, not two copies of the same parameters. The pairing
 * code's whole security argument is that each guess costs one derivation at
 * App Lock's cost, and a copy lets the two drift the first time anyone tunes
 * the parameters for low-RAM devices.
 *
 * Parameters match libsodium's OPSLIMIT_MODERATE / MEMLIMIT_MODERATE, which is
 * what the vault historically used. Changing them would make existing vaults
 * unopenable, so they are fixed here.
 *
 * The derivation runs in a short-lived Web Worker (workers/argon2.worker.ts)
 * that is terminated after every call. Running it on the main thread froze
 * the UI for seconds and left a 256 MiB WebAssembly buffer behind for the
 * garbage collector; on iOS that was enough for the system to kill the page
 * right after an unlock. Environments without Worker support (tests, very old
 * engines) fall back to the main thread.
 */

// Matches libsodium crypto_pwhash_SALTBYTES.
export const ARGON2_SALT_BYTES = 16;

const ARGON2_PARAMS = Object.freeze({
  parallelism: 1,
  iterations: 3, // OPSLIMIT_MODERATE
  memorySize: 262144, // MEMLIMIT_MODERATE, 256 MiB in KiB
});

class WorkerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

let requestCounter = 0;

async function deriveOnMainThread(password, salt, hashLength) {
  const { argon2id } = await import('hash-wasm');
  return argon2id({
    password,
    salt,
    ...ARGON2_PARAMS,
    hashLength,
    // hash-wasm returns a Uint8Array directly; the hex round-trip both former
    // copies did was pure overhead.
    outputType: 'binary',
  });
}

async function deriveInWorker(password, salt, hashLength) {
  let worker;
  try {
    const { default: Argon2Worker } = await import('../workers/argon2.worker.ts?worker&inline');
    worker = new Argon2Worker();
  } catch (error) {
    throw new WorkerUnavailableError(error?.message || 'Argon2 worker could not start');
  }

  const id = ++requestCounter;
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const data = event?.data || {};
        if (data.id !== id) return;
        if (data.ok && data.result instanceof Uint8Array) {
          resolve(data.result);
        } else {
          reject(new Error(data.error || 'Argon2 derivation failed'));
        }
      };
      // An error event before any answer means the worker script itself did
      // not load or crashed (for example a blocked blob: URL); the caller
      // falls back to the main thread for that case only.
      worker.onerror = (event) => {
        event?.preventDefault?.();
        reject(new WorkerUnavailableError(event?.message || 'Argon2 worker failed'));
      };
      worker.onmessageerror = () => {
        reject(new WorkerUnavailableError('Argon2 worker message could not be read'));
      };
      // Copy the salt so transferring never detaches the caller's buffer.
      worker.postMessage({
        id,
        password,
        salt: new Uint8Array(salt),
        hashLength,
        ...ARGON2_PARAMS,
      });
    });
  } finally {
    // Frees the worker's 256 MiB WebAssembly memory right away.
    try {
      worker.terminate();
    } catch {
      // already gone
    }
  }
}

function canUseWorker() {
  return typeof Worker !== 'undefined' && typeof window !== 'undefined';
}

/**
 * Derive a key from a password with the shared cost profile.
 *
 * @param {string} password
 * @param {Uint8Array} salt - exactly ARGON2_SALT_BYTES bytes
 * @param {number} [hashLength=32]
 * @returns {Promise<Uint8Array>}
 */
export async function deriveArgon2Key(password, salt, hashLength = 32) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required');
  }
  if (!salt || salt.length !== ARGON2_SALT_BYTES) {
    throw new Error('Invalid salt');
  }

  if (canUseWorker()) {
    try {
      return await deriveInWorker(password, salt, hashLength);
    } catch (error) {
      if (!(error instanceof WorkerUnavailableError)) throw error;
      console.warn('[argon2-kdf] Worker unavailable, deriving on the main thread:', error.message);
    }
  }

  return deriveOnMainThread(password, salt, hashLength);
}
