/**
 * Recipient public keys, per account.
 *
 * Outbound encryption at the server is opportunistic: it looks a key up over
 * WKD and encrypts when it finds one. That is invisible and unoverridable from
 * the client, so a user who has a correspondent's key but whose domain has no
 * WKD record has no way to use it, and no way to tell whether a given message
 * went out encrypted.
 *
 * This is the manual override: keys the user pins themselves, keyed by email
 * address. A pinned key is what the composer's encrypt toggle checks.
 *
 * Stored next to the private keys in localStorage (see pgp-local.ts) rather
 * than IndexedDB so the two travel together in the pairing bundle and share
 * one account-scoping rule.
 */
import { Local } from './storage.js';

export interface RecipientKey {
  /** Lowercased email address this key belongs to. */
  email: string;
  /** Armored public key block. */
  armored: string;
  /** Display label, usually the key's user id. */
  label?: string;
  fingerprint?: string;
  addedAt?: number;
}

const activeAccount = (): string => Local.get('email') || 'default';

const storageKey = (account?: string) => `pgp_recipients_${account || activeAccount()}`;

export function normalizeAddress(value: string): string {
  const raw = String(value ?? '').trim();
  // Accept "Jane <jane@example.com>" as well as a bare address.
  const match = raw.match(/<([^>]+)>\s*$/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

export function readRecipientKeys(account?: string): RecipientKey[] {
  try {
    const parsed = JSON.parse(Local.get(storageKey(account)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k) => k?.email && k?.armored);
  } catch {
    return [];
  }
}

export function writeRecipientKeys(keys: RecipientKey[], account?: string): void {
  Local.set(storageKey(account), JSON.stringify(keys || []));
}

export function findRecipientKey(email: string, account?: string): RecipientKey | null {
  const target = normalizeAddress(email);
  if (!target) return null;
  return readRecipientKeys(account).find((k) => normalizeAddress(k.email) === target) || null;
}

/** Add or replace the key pinned for an address. */
export function saveRecipientKey(key: RecipientKey, account?: string): RecipientKey[] {
  const email = normalizeAddress(key.email);
  if (!email || !key.armored) return readRecipientKeys(account);
  const existing = readRecipientKeys(account).filter((k) => normalizeAddress(k.email) !== email);
  const next = [...existing, { ...key, email, addedAt: key.addedAt || Date.now() }];
  next.sort((a, b) => a.email.localeCompare(b.email));
  writeRecipientKeys(next, account);
  return next;
}

export function deleteRecipientKey(email: string, account?: string): RecipientKey[] {
  const target = normalizeAddress(email);
  const next = readRecipientKeys(account).filter((k) => normalizeAddress(k.email) !== target);
  writeRecipientKeys(next, account);
  return next;
}

export interface RecipientKeyStatus {
  email: string;
  hasKey: boolean;
}

/**
 * Key coverage for a recipient list.
 *
 * Encryption is all-or-nothing: OpenPGP encrypts one ciphertext to a set of
 * keys, so a single recipient without one means the message cannot be sent
 * encrypted as addressed. The composer uses `missing` to say exactly who is
 * blocking it rather than just refusing.
 */
export function recipientKeyCoverage(
  addresses: string[],
  account?: string,
): { statuses: RecipientKeyStatus[]; missing: string[]; allCovered: boolean } {
  const keys = readRecipientKeys(account);
  const known = new Set(keys.map((k) => normalizeAddress(k.email)));
  const seen = new Set<string>();
  const statuses: RecipientKeyStatus[] = [];

  for (const address of addresses || []) {
    const email = normalizeAddress(address);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    statuses.push({ email, hasKey: known.has(email) });
  }

  const missing = statuses.filter((s) => !s.hasKey).map((s) => s.email);
  return { statuses, missing, allCovered: statuses.length > 0 && missing.length === 0 };
}
