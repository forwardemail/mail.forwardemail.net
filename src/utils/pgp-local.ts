/**
 * The one reader and writer for locally stored PGP material.
 *
 * Keys live in `pgp_keys_{account}` (armored privates) and passphrases in
 * `pgp_passphrases_{account}`, KEYED BY THE KEY'S NAME. Both settingsStore's
 * LocalSettings and the QR pairing bundle read these; two independent parsers
 * of the same storage keys is how a shape change ends with the pairing bundle
 * quietly exporting stale or empty private keys to another device.
 */
import { Local } from './storage.js';
import type { PgpKey } from '../types';

const activeAccount = (): string => Local.get('email') || 'default';

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
};

export function readPgpKeys(account?: string): PgpKey[] {
  const keys = parseJson<PgpKey[]>(Local.get(`pgp_keys_${account || activeAccount()}`), []);
  return Array.isArray(keys) ? keys : [];
}

export function writePgpKeys(keys: PgpKey[], account?: string): void {
  Local.set(`pgp_keys_${account || activeAccount()}`, JSON.stringify(keys || []));
}

export function readPgpPassphrases(account?: string): Record<string, string> {
  const passphrases = parseJson<Record<string, string>>(
    Local.get(`pgp_passphrases_${account || activeAccount()}`),
    {},
  );
  return passphrases && typeof passphrases === 'object' ? passphrases : {};
}

export function writePgpPassphrases(passphrases: Record<string, string>, account?: string): void {
  Local.set(`pgp_passphrases_${account || activeAccount()}`, JSON.stringify(passphrases || {}));
}
