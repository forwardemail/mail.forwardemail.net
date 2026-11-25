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
 * plaintext being shown.
 *
 * Bounded by how much it holds, not only by how many: a decrypted message
 * carries its attachments as data URLs, so a few of them can be tens of MB.
 * Least recently used goes first. The newest entry always stays, whatever its
 * size, so the message on screen can be opened again without the key.
 */
import { isMemoryConstrained } from './memory-profile';

const MAX_ENTRIES = 200;

// In characters of text held, which is about bytes for the base64 that makes
// up most of it. A phone gets far less: its webview is reloaded by the system
// when the app uses too much memory.
const MAX_CHARS = isMemoryConstrained ? 12_000_000 : 64_000_000;

interface Entry<T> {
  keysVersion: number;
  value: T;
  chars: number;
}

/** Roughly how much text `value` holds: its strings and binary parts. */
export function approximateChars(value: unknown): number {
  let total = 0;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') {
      total += item.length;
    } else if (item && typeof item === 'object') {
      if (seen.has(item)) continue;
      seen.add(item);
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
        total += item.byteLength;
      } else if (Array.isArray(item)) {
        for (const child of item) stack.push(child);
      } else {
        for (const child of Object.values(item)) stack.push(child);
      }
    }
  }
  return total;
}

let heldChars = 0;

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
    heldChars -= entry.chars;
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
  const previous = entries.get(key);
  if (previous) {
    entries.delete(key);
    heldChars -= previous.chars;
  }
  const chars = approximateChars(value);
  entries.set(key, { keysVersion, value, chars });
  heldChars += chars;
  while (entries.size > 1 && (entries.size > MAX_ENTRIES || heldChars > MAX_CHARS)) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    heldChars -= entries.get(oldest)?.chars || 0;
    entries.delete(oldest);
  }
}

/** Forget every decrypted message (account switch, YubiKey option turned off). */
export function clearSessionDecrypts(): void {
  entries.clear();
  heldChars = 0;
}

export function sessionDecryptCount(): number {
  return entries.size;
}

export function sessionDecryptChars(): number {
  return heldChars;
}
