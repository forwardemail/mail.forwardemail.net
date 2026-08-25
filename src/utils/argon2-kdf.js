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
 * what the vault historically used.
 */

// Matches libsodium crypto_pwhash_SALTBYTES.
export const ARGON2_SALT_BYTES = 16;

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

  const { argon2id } = await import('hash-wasm');
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3, // OPSLIMIT_MODERATE
    memorySize: 262144, // MEMLIMIT_MODERATE, 256 MiB in KiB
    hashLength,
    // hash-wasm returns a Uint8Array directly; the hex round-trip both former
    // copies did was pure overhead.
    outputType: 'binary',
  });
}
