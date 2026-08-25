/**
 * Building a pairing bundle on the sending device and applying one on the
 * receiving device.
 *
 * The import is deliberately split into three steps - read the current state,
 * compute a plan, execute the plan. The confirmation screen shows the plan and
 * the writer executes that same plan, so what the user is asked to approve and
 * what actually lands on disk cannot drift apart.
 */
import { db } from '../db';
import { Accounts, Local } from '../storage.js';
import { readPgpKeys, readPgpPassphrases } from '../pgp-local';
import {
  getPortableSettingIds,
  getSettingDefinition,
  parseLocalValue,
  resolveLocalKey,
  serializeLocalValue,
} from '../../stores/settingsRegistry';
import { BUNDLE_VERSION, DEFAULT_TTL_SECONDS, DeviceSyncError } from './seal';
import type {
  DeviceSyncAccount,
  DeviceSyncBundle,
  DeviceSyncPgp,
  DeviceSyncSource,
  PgpKeyEntry,
  SavedSearchEntry,
} from './types';

/**
 * Portable settings that own a dedicated bucket in the bundle and so must not
 * also be folded into the generic `settings` map.
 */
const DEDICATED_BUCKET_IDS = new Set(['pgp_keys', 'pgp_passphrases', 'saved_searches']);

/**
 * Portable device-local values that predate the settings registry.
 *
 * `profile_image_{email}` is deliberately absent: it is stored as a data URL
 * and routinely runs to tens of kilobytes, which would turn a two-frame
 * pairing code into a sixty-frame one for an avatar.
 */
const EXTRA_KEYS: { id: string; localKey: (account: string) => string }[] = [
  { id: 'signature', localKey: (account) => `signature_${account}` },
  { id: 'signature_enabled', localKey: (account) => `signature_enabled_${account}` },
  // settingsStore lowercases the account for profile keys; match it exactly or
  // the value lands under a key nothing reads.
  { id: 'profile_name', localKey: (account) => `profile_name_${account.toLowerCase()}` },
];

const savedSearchPrefix = (account: string): string => `saved_search_${account}_`;

/** Armor differs only in line endings and trailing space across platforms. */
const normalizeArmor = (value: string): string =>
  String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();

export type CollectBundleOptions = {
  account: string;
  include: { account?: boolean; pgp?: boolean; settings?: boolean };
  source: DeviceSyncSource;
  now?: number;
  ttlSeconds?: number;
};

// Reads go through pgp-local.ts, the same parser settingsStore uses. A private
// copy here is the worst place for storage-shape drift: it hands private keys
// to another device.
const readPgp = (account: string): DeviceSyncPgp => ({
  keys: readPgpKeys(account).filter((key) => key?.value),
  passphrases: readPgpPassphrases(account),
});

const readAccount = (account: string): DeviceSyncAccount | null => {
  const stored = Accounts.getAll().find((entry) => entry?.email === account);
  const aliasAuth =
    stored?.aliasAuth ?? (Local.get('email') === account ? Local.get('alias_auth') : null);
  const apiKey = stored?.apiKey ?? (Local.get('email') === account ? Local.get('api_key') : null);

  if (!aliasAuth && !apiKey) return null;
  return { email: account, aliasAuth: aliasAuth || null, apiKey: apiKey || null };
};

const readSettings = (account: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {};

  for (const id of getPortableSettingIds()) {
    if (DEDICATED_BUCKET_IDS.has(id)) continue;

    const def = getSettingDefinition(id);
    const localKey = resolveLocalKey(def, account);
    if (!localKey) continue;

    // A setting the user never touched reads as null. Carrying its default
    // across would overwrite whatever the receiving device already chose.
    const raw = Local.get(localKey);
    if (raw === null || raw === undefined) continue;

    out[id] = parseLocalValue(def, raw);
  }

  return out;
};

const readExtras = (account: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const extra of EXTRA_KEYS) {
    const raw = Local.get(extra.localKey(account));
    if (raw === null || raw === undefined || raw === '') continue;
    out[extra.id] = raw;
  }
  return out;
};

const readSavedSearches = async (account: string): Promise<SavedSearchEntry[]> => {
  try {
    const prefix = savedSearchPrefix(account);
    const rows = await db.meta.where('key').startsWith(prefix).toArray();
    return rows
      .filter((row) => row?.value)
      .map((row) => ({ name: String(row.key).slice(prefix.length), value: row.value }));
  } catch {
    // Saved searches are a nicety; a cache read failure must not sink the
    // whole pairing code.
    return [];
  }
};

export async function collectBundle(options: CollectBundleOptions): Promise<DeviceSyncBundle> {
  const { account, include, source } = options;
  if (!account) throw new DeviceSyncError('BAD_FORMAT', 'No account to share');

  const now = options.now ?? Date.now();
  const iat = Math.floor(now / 1000);
  const bundle: DeviceSyncBundle = {
    v: BUNDLE_VERSION,
    iat,
    exp: iat + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    src: source,
  };

  if (include.account) {
    const credentials = readAccount(account);
    if (!credentials) {
      // Reached when the App Lock vault is locked: the credential read comes
      // back empty and a bundle that silently omits sign-in would look like it
      // worked right up until the phone could not fetch mail.
      throw new DeviceSyncError('BAD_KEY', 'No sign-in credentials available for this account');
    }
    bundle.account = credentials;
  }

  if (include.pgp) {
    const pgp = readPgp(account);
    if (pgp.keys.length > 0 || Object.keys(pgp.passphrases).length > 0) bundle.pgp = pgp;
  }

  if (include.settings) {
    const settings = readSettings(account);
    const extras = readExtras(account);
    const savedSearches = await readSavedSearches(account);
    if (Object.keys(settings).length > 0) bundle.settings = settings;
    if (Object.keys(extras).length > 0) bundle.extras = extras;
    if (savedSearches.length > 0) bundle.savedSearches = savedSearches;
  }

  return bundle;
}

/* ------------------------------------------------------------------ import */

export type CurrentState = {
  account: string;
  knownAccount: boolean;
  pgp: DeviceSyncPgp;
  settings: Record<string, string | null>;
  extras: Record<string, string | null>;
  savedSearchNames: Set<string>;
};

export async function readCurrentState(account: string): Promise<CurrentState> {
  const settings: Record<string, string | null> = {};
  for (const id of getPortableSettingIds()) {
    if (DEDICATED_BUCKET_IDS.has(id)) continue;
    const localKey = resolveLocalKey(getSettingDefinition(id), account);
    if (localKey) settings[id] = Local.get(localKey);
  }

  const extras: Record<string, string | null> = {};
  for (const extra of EXTRA_KEYS) extras[extra.id] = Local.get(extra.localKey(account));

  let savedSearchNames = new Set<string>();
  try {
    const prefix = savedSearchPrefix(account);
    const rows = await db.meta.where('key').startsWith(prefix).toArray();
    savedSearchNames = new Set(rows.map((row) => String(row.key).slice(prefix.length)));
  } catch {
    savedSearchNames = new Set();
  }

  return {
    account,
    knownAccount: Accounts.getAll().some((entry) => entry?.email === account),
    pgp: readPgp(account),
    settings,
    extras,
    savedSearchNames,
  };
}

export type ImportPlan = {
  account: { email: string; isNew: boolean } | null;
  pgp: {
    added: PgpKeyEntry[];
    /** Incoming keys already held under some name; skipped. */
    duplicates: PgpKeyEntry[];
    renamed: { from: string; to: string }[];
    passphrases: Record<string, string>;
  } | null;
  settings: { id: string; label: string; from: string | null; to: string }[];
  extras: { id: string; localKey: string; to: string }[];
  savedSearches: { added: SavedSearchEntry[]; updated: SavedSearchEntry[] };
};

/**
 * Work out exactly what an import would change. Pure: same bundle plus same
 * current state always yields the same plan, which is what makes the
 * confirmation screen trustworthy and the merge rules testable.
 */
export function planImport(
  bundle: DeviceSyncBundle,
  current: CurrentState,
  include: { account?: boolean; pgp?: boolean; settings?: boolean } = {
    account: true,
    pgp: true,
    settings: true,
  },
): ImportPlan {
  const plan: ImportPlan = {
    account: null,
    pgp: null,
    settings: [],
    extras: [],
    savedSearches: { added: [], updated: [] },
  };

  if (include.account && bundle.account?.email) {
    plan.account = { email: bundle.account.email, isNew: !current.knownAccount };
  }

  if (include.pgp && bundle.pgp) {
    const existingByValue = new Map(
      current.pgp.keys.map((key) => [normalizeArmor(key.value), key] as const),
    );
    const takenNames = new Set(current.pgp.keys.map((key) => key.name));

    const added: PgpKeyEntry[] = [];
    const duplicates: PgpKeyEntry[] = [];
    const renamed: { from: string; to: string }[] = [];
    const passphrases: Record<string, string> = {};

    for (const incoming of bundle.pgp.keys || []) {
      if (!incoming?.value) continue;

      const existing = existingByValue.get(normalizeArmor(incoming.value));
      if (existing) {
        duplicates.push(incoming);
        // The key is already here but its passphrase may not be. Fill the gap;
        // never overwrite a passphrase the receiving device already stored.
        const carried = bundle.pgp.passphrases?.[incoming.name];
        if (carried && !current.pgp.passphrases[existing.name]) {
          passphrases[existing.name] = carried;
        }
        continue;
      }

      // Same name, different key material. Keep both rather than silently
      // dropping one - losing a private key is unrecoverable.
      let name = incoming.name || 'Imported key';
      if (takenNames.has(name)) {
        const base = `${name} (imported)`;
        let candidate = base;
        let counter = 2;
        while (takenNames.has(candidate)) {
          candidate = `${base} ${counter}`;
          counter += 1;
        }
        renamed.push({ from: name, to: candidate });
        name = candidate;
      }

      takenNames.add(name);
      added.push({ name, value: incoming.value });

      // Passphrases are keyed by the key's name, so a rename has to carry the
      // passphrase to the new name or decryption silently stops working.
      const carried = bundle.pgp.passphrases?.[incoming.name];
      if (carried) passphrases[name] = carried;
    }

    plan.pgp = { added, duplicates, renamed, passphrases };
  }

  if (include.settings) {
    for (const [id, value] of Object.entries(bundle.settings || {})) {
      const def = getSettingDefinition(id);
      if (!def?.portable || DEDICATED_BUCKET_IDS.has(id)) continue;

      const serialized = serializeLocalValue(def, value);
      if (serialized === null || serialized === undefined) continue;

      const from = current.settings[id] ?? null;
      if (from === serialized) continue;

      plan.settings.push({ id, label: def.label, from, to: serialized });
    }

    for (const extra of EXTRA_KEYS) {
      const value = bundle.extras?.[extra.id];
      if (value === undefined || value === null) continue;
      if ((current.extras[extra.id] ?? null) === value) continue;
      plan.extras.push({ id: extra.id, localKey: extra.localKey(current.account), to: value });
    }

    for (const entry of bundle.savedSearches || []) {
      if (!entry?.name) continue;
      if (current.savedSearchNames.has(entry.name)) plan.savedSearches.updated.push(entry);
      else plan.savedSearches.added.push(entry);
    }
  }

  return plan;
}

export type ApplyResult = {
  plan: ImportPlan;
  activatedAccount: string | null;
};

/**
 * Execute a plan. `activate` switches the stored credentials over to the
 * imported account; the caller still owns any UI navigation that follows.
 */
export async function applyPlan(
  plan: ImportPlan,
  bundle: DeviceSyncBundle,
  options: { account: string; activate?: boolean; staySignedIn?: boolean } = { account: '' },
): Promise<ApplyResult> {
  const account = options.account;
  let activatedAccount: string | null = null;

  if (plan.account && bundle.account) {
    const ok = Accounts.add(
      bundle.account.email,
      { aliasAuth: bundle.account.aliasAuth, apiKey: bundle.account.apiKey },
      options.staySignedIn !== false,
    );
    // Accounts.add refuses while the vault is locked rather than clobbering the
    // encrypted account list. Surfacing that is the difference between "unlock
    // and scan again" and a pairing that looked fine and did nothing.
    if (!ok) {
      throw new DeviceSyncError(
        'BAD_KEY',
        'Could not save the account. Unlock the app first, then scan again.',
      );
    }
    if (options.activate) {
      Accounts.setActive(bundle.account.email);
      activatedAccount = bundle.account.email;
    }
  }

  if (plan.pgp && (plan.pgp.added.length > 0 || Object.keys(plan.pgp.passphrases).length > 0)) {
    const current = readPgp(account);
    if (plan.pgp.added.length > 0) {
      Local.set(`pgp_keys_${account}`, JSON.stringify([...current.keys, ...plan.pgp.added]));
    }
    const passphrases = { ...current.passphrases, ...plan.pgp.passphrases };
    if (Object.keys(passphrases).length > 0) {
      Local.set(`pgp_passphrases_${account}`, JSON.stringify(passphrases));
    }
  }

  for (const change of plan.settings) {
    const localKey = resolveLocalKey(getSettingDefinition(change.id), account);
    if (localKey) Local.set(localKey, change.to);
  }

  for (const change of plan.extras) {
    Local.set(change.localKey, change.to);
  }

  const savedSearches = [...plan.savedSearches.added, ...plan.savedSearches.updated];
  if (savedSearches.length > 0) {
    try {
      await Promise.all(
        savedSearches.map((entry) =>
          db.meta.put({
            key: `${savedSearchPrefix(account)}${entry.name}`,
            value: entry.value,
            updatedAt: Date.now(),
          }),
        ),
      );
    } catch {
      // Same reasoning as the read side: saved searches are the least valuable
      // thing in the bundle and must not fail an import that carried keys.
    }
  }

  return { plan, activatedAccount };
}
