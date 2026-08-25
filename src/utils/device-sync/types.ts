/**
 * Shared types for QR device pairing.
 *
 * A bundle is everything that moves from webmail or the desktop app to a phone
 * when the user scans a pairing code. It is plain JSON so a newer sender can
 * add fields without breaking an older scanner, and every bucket is optional
 * because the sending side lets the user uncheck any of them.
 *
 * What is deliberately absent: the six ACCOUNT-scope settings (the server
 * already syncs those), the message cache, and the App Lock vault. A vault is
 * bound to the device that created it; the receiving device sets up its own.
 */

/** Which app produced the bundle, shown on the confirmation screen. */
export type DeviceSyncSource = {
  app: 'web' | 'desktop' | 'mobile';
  os: string;
  name?: string;
};

/** One armored private key as stored in `pgp_keys_{email}`. */
export type PgpKeyEntry = { name: string; value: string };

export type DeviceSyncAccount = {
  email: string;
  aliasAuth?: string | null;
  apiKey?: string | null;
};

/**
 * `passphrases` is keyed by the key's `name`, not by index or fingerprint -
 * that is the shape Settings.svelte and mailService.ts already persist, and
 * renaming a key on import has to move its passphrase with it.
 */
export type DeviceSyncPgp = {
  keys: PgpKeyEntry[];
  passphrases: Record<string, string>;
};

export type SavedSearchEntry = { name: string; value: unknown };

export type DeviceSyncBundle = {
  v: number;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expires at, epoch seconds. Enforced by the scanner. */
  exp: number;
  src: DeviceSyncSource;
  account?: DeviceSyncAccount | null;
  pgp?: DeviceSyncPgp | null;
  /** Portable registry settings, keyed by setting id and already parsed. */
  settings?: Record<string, unknown> | null;
  /** Portable local values that predate the settings registry (signature, …). */
  extras?: Record<string, string> | null;
  savedSearches?: SavedSearchEntry[] | null;
};

/** The three checkboxes on the sending side. */
export type DeviceSyncBuckets = {
  account: boolean;
  pgp: boolean;
  settings: boolean;
};
