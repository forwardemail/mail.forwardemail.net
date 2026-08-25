/**
 * Human-readable summaries of the PGP keys inside a pairing bundle.
 *
 * Used by the confirmation screen so the receiving device shows what it is
 * about to install - fingerprint, algorithm, identities - rather than a bare
 * count. Installing a private key because a camera saw a pattern deserves more
 * than "2 keys".
 *
 * openpgp is imported dynamically: this only runs on the confirmation screen,
 * and the library is far too large to sit in the scanner's critical path.
 * A key that fails to parse is reported rather than thrown away - the user
 * still needs to see that something unreadable arrived.
 */
import type { PgpKeyEntry } from './types';

export type PgpKeySummary = {
  name: string;
  fingerprint: string | null;
  /** Short form shown in the UI, e.g. "A1B2 C3D4". */
  shortId: string | null;
  algorithm: string | null;
  userIds: string[];
  isPrivate: boolean;
  error: string | null;
};

const formatShortId = (fingerprint: string): string => {
  const tail = fingerprint.slice(-8).toUpperCase();
  return `${tail.slice(0, 4)} ${tail.slice(4)}`;
};

const describeAlgorithm = (info: { algorithm?: string; bits?: number; curve?: string }): string => {
  if (info?.curve) return String(info.curve);
  if (info?.bits) return `${info.algorithm || 'key'} ${info.bits}`;
  return info?.algorithm || 'unknown';
};

export async function summarizePgpKeys(keys: PgpKeyEntry[]): Promise<PgpKeySummary[]> {
  if (!Array.isArray(keys) || keys.length === 0) return [];

  let openpgp: typeof import('openpgp');
  try {
    openpgp = await import('openpgp');
  } catch {
    // Without the library we can still name what arrived, which is better than
    // showing nothing on a screen whose whole job is disclosure.
    return keys.map((key) => ({
      name: key.name || 'Imported key',
      fingerprint: null,
      shortId: null,
      algorithm: null,
      userIds: [],
      isPrivate: false,
      error: 'Could not load the PGP library to inspect this key',
    }));
  }

  return Promise.all(
    keys.map(async (entry) => {
      const base = {
        name: entry.name || 'Imported key',
        fingerprint: null as string | null,
        shortId: null as string | null,
        algorithm: null as string | null,
        userIds: [] as string[],
        isPrivate: false,
        error: null as string | null,
      };

      try {
        const key = await openpgp.readKey({ armoredKey: entry.value });
        const fingerprint = key.getFingerprint();
        return {
          ...base,
          fingerprint,
          shortId: fingerprint ? formatShortId(fingerprint) : null,
          algorithm: describeAlgorithm(key.getAlgorithmInfo()),
          userIds: key.getUserIDs(),
          isPrivate: key.isPrivate(),
        };
      } catch (cause) {
        return { ...base, error: (cause as Error)?.message || 'Unreadable key' };
      }
    }),
  );
}
