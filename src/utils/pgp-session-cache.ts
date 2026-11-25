/**
 * Decrypted PGP messages kept in memory for this session only.
 *
 * Without App Lock the plaintext is not written to disk
 * (pgp-plaintext-policy.ts), so opening a message again would decrypt it
 * again: another passphrase prompt, or another YubiKey PIN and touch. This
 * keeps the result for the life of the page instead.
 *
 * Keyed by a SHA-256 of the ciphertext, so the same message reached through
 * any path (a cached raw copy, a fresh download) is found, and the map holds
 * no copy of the ciphertext. An entry is only used with the keys it was
 * decrypted with (getPgpKeysVersion()), so removing keys also stops their
 * plaintext being shown. Bounded, least recently used out first.
 */

const MAX_ENTRIES = 200;

interface Entry<T> {
  keysVersion: number;
  value: T;
}

const entries = new Map<string, Entry<unknown>>();

async function keyFor(armored: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(armored);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export async function getSessionDecrypt<T>(
  armored: string,
  keysVersion: number,
): Promise<T | null> {
  const key = await keyFor(armored);
  if (!key) return null;
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.keysVersion !== keysVersion) {
    entries.delete(key);
    return null;
  }
  // Most recently used last
  entries.delete(key);
  entries.set(key, entry);
  return entry.value as T;
}

export async function setSessionDecrypt<T>(
  armored: string,
  keysVersion: number,
  value: T,
): Promise<void> {
  const key = await keyFor(armored);
  if (!key) return;
  entries.delete(key);
  entries.set(key, { keysVersion, value });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Forget every decrypted message (account switch, YubiKey option turned off). */
export function clearSessionDecrypts(): void {
  entries.clear();
}

export function sessionDecryptCount(): number {
  return entries.size;
}
