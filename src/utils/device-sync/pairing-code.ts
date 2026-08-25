/**
 * Pairing codes - the control that makes a photographed QR useless.
 *
 * Without one, the seal key travels inside the code itself, so anyone holding a
 * picture of it holds the key. The TTL baked into the bundle does NOT help
 * against that: expiry is checked by an honest scanner, and an attacker with
 * the bytes simply ignores it. Short of a relay with server-enforced single
 * use, a typed secret is the only thing that keeps a screenshot from being
 * enough.
 *
 * Construction: the QR carries the seal key XORed with an Argon2id hash of the
 * code, salted with the frame's session id.
 *
 *   wrapped = sealKey XOR argon2id(code, sessionId)
 *
 * XOR rather than an AEAD because the wrapped value has to fit the frame's
 * fixed 32-byte key slot, and authentication is already handled one layer up:
 * a wrong code yields a wrong seal key, and the payload's AES-GCM tag then
 * fails closed with BAD_KEY. The derived value is used exactly once - the salt
 * is a fresh random session id - so there is no key-reuse weakness.
 *
 * Work factor: 8 characters over a 32-symbol alphabet is 40 bits, and every
 * guess costs one Argon2id at 256 MiB. Memory-hardness is what makes that
 * stick - it caps how many guesses a GPU can run in parallel. At a generous
 * 1000 guesses/second an exhaustive search averages well over a decade, which
 * is a different universe from "a screenshot forwarded in a chat".
 */

/**
 * Deliberately excludes 0/O, 1/I/L - a code is read off one screen and typed
 * into another, and those are the pairs people get wrong.
 */
import { deriveArgon2Key } from '../argon2-kdf.js';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const GROUP = 4;

export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_SALT_BYTES = 16;
export const PAIRING_KEY_BYTES = 32;

export function generatePairingCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);

  let out = '';
  for (const byte of bytes) {
    // Modulo bias over 256/32 is exactly zero: 32 divides 256.
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/** Display form, e.g. "A7K2-9QMX". */
export const formatPairingCode = (code: string): string => {
  const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += GROUP) groups.push(clean.slice(i, i + GROUP));
  return groups.join('-');
};

/**
 * Accept what a person actually types: lowercase, spaces and dashes.
 * Returns '' for anything containing a character the alphabet does not use, so
 * callers can tell "not entered yet" from "entered wrongly".
 */
export function normalizePairingCode(input: string): string {
  const stripped = String(input || '')
    .replace(/[\s-]/g, '')
    .toUpperCase();

  // No lookalike remapping: the alphabet already omits 0, 1, I and O, so a
  // generated code can never contain them and there is nothing to map them to.
  // L IS a valid character - an earlier draft rewrote it to '1' and corrupted
  // perfectly good input. Anything outside the alphabet is a typo, not a code.
  for (const char of stripped) {
    if (!ALPHABET.includes(char)) return '';
  }
  return stripped;
}

export const isPairingCodeComplete = (input: string): boolean =>
  normalizePairingCode(input).length === PAIRING_CODE_LENGTH;

/**
 * Argon2id through the app's single shared cost profile (argon2-kdf.js). Every
 * guess at a pairing code costs exactly one App Lock derivation, and it stays
 * that way because there is only one implementation to tune.
 */
export async function derivePairingKey(code: string, salt: Uint8Array): Promise<Uint8Array> {
  const normalized = normalizePairingCode(code);
  if (!normalized) throw new Error('Pairing code is empty or contains unusable characters');
  if (!(salt instanceof Uint8Array) || salt.length !== PAIRING_SALT_BYTES) {
    throw new Error(`Pairing salt must be ${PAIRING_SALT_BYTES} bytes`);
  }

  return deriveArgon2Key(normalized, salt, PAIRING_KEY_BYTES);
}

const xorBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const out = new Uint8Array(left.length);
  for (let i = 0; i < left.length; i += 1) out[i] = left[i] ^ right[i];
  return out;
};

/** Both directions are the same XOR; named separately for readable call sites. */
export async function wrapSealKey(
  sealKey: Uint8Array,
  code: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  if (sealKey.length !== PAIRING_KEY_BYTES) {
    throw new Error(`Seal key must be ${PAIRING_KEY_BYTES} bytes`);
  }
  return xorBytes(sealKey, await derivePairingKey(code, salt));
}

export async function unwrapSealKey(
  wrapped: Uint8Array,
  code: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  if (wrapped.length !== PAIRING_KEY_BYTES) {
    throw new Error(`Wrapped key must be ${PAIRING_KEY_BYTES} bytes`);
  }
  return xorBytes(wrapped, await derivePairingKey(code, salt));
}
