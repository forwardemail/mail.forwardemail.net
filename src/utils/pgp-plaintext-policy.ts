/**
 * Where the plaintext of a decrypted PGP message may be kept.
 *
 * On disk (IndexedDB: the body cache, the decrypted subject on the message
 * row, the search index) only while App Lock is on: then the database is
 * encrypted at rest with a key derived from the App Lock PIN or passkey
 * (db-crypto.ts). Without App Lock it would be readable by anyone with a copy
 * of the profile directory, which defeats encrypting the mail, and with a key
 * on a hardware token (YubiKey), keeping the key off the computer.
 *
 * Otherwise only in memory, for this session (pgp-session-cache.ts), so a
 * message opened again does not need the key, PIN or touch again.
 */
import { isLockEnabled } from './crypto-store.js';

export function pgpPlaintextMayPersist(): boolean {
  try {
    return isLockEnabled() === true;
  } catch {
    return false;
  }
}
