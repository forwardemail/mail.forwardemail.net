/**
 * At-rest encryption for the IndexedDB cache (context-agnostic).
 *
 * Runs wherever db-engine runs: the db worker on most platforms, the main
 * thread on the WebKitGTK fallback. That means it must not touch localStorage or any
 * window-only API. Uses WebCrypto AES-256-GCM instead of libsodium: available
 * in every worker context, hardware-accelerated, and adds zero bytes to the
 * inlined worker bundles.
 *
 * Key handling: the main thread derives a dedicated IDB subkey from the App
 * Lock DEK (see crypto-store.js getIdbCryptoMaterial) and pushes it here via
 * the 'configureCrypto' engine action. The key is imported non-extractable and
 * held in module memory only.
 *
 * Envelope format (whole-record): fields required by queried indexes stay
 * plaintext; every other field is serialized to JSON and sealed into a single
 * `_enc: { v, iv, data }` field. Legacy plaintext records (no `_enc`) pass
 * through reads unchanged, so enabling encryption needs no migration cliff;
 * the reencryptAll sweep upgrades them in the background.
 *
 * Fail-closed: when the vault is enabled (`required`) but no key has been
 * pushed (locked), writes to sensitive tables throw DbLockedError instead of
 * silently persisting plaintext.
 */

export class DbLockedError extends Error {
  code = 'DB_LOCKED';
  constructor() {
    super('Database is locked: at-rest encryption is enabled and no key is available');
    this.name = 'DbLockedError';
  }
}

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;

// iv/data are base64 strings, NOT typed arrays: envelope records flow through
// Dexie's Collection.modify deepClone, worker structured clone, and the raw-
// IndexedDB code paths, and strings are the only representation that survives
// all of them intact (Dexie's deepClone corrupts typed arrays).
interface Envelope {
  v: number;
  iv: string;
  data: string;
}

type DbRecord = Record<string, unknown> & { _enc?: Envelope };

// Fields that MUST stay plaintext because a real query path uses them:
// primary-key components, queried indexes ([account+folder+date],
// [account+folder+is_unread_index], the where('from') repair sweep), and
// fields used by sortBy call sites. Everything else is sealed. This list
// tracks the Dexie version 2 index keep-list in db-engine.ts; both come from
// the same audit of every .where() call in the app and workers. One caveat:
// `from` stays sealed here even though its index survives, so the repair
// sweep only matches legacy plaintext rows (acceptable, it exists to fix
// records written by an old bug).
const PLAINTEXT_FIELDS: Record<string, Set<string>> = {
  messages: new Set([
    'account',
    'id',
    'folder',
    'date',
    'flags',
    'is_unread',
    'is_unread_index',
    'has_attachment',
    'modseq',
    'updatedAt',
    'bodyIndexed',
    'labels',
  ]),
  messageBodies: new Set([
    'account',
    'id',
    'folder',
    'updatedAt',
    'sanitizedAt',
    'trackingPixelCount',
    'blockedRemoteImageCount',
  ]),
  drafts: new Set(['account', 'id', 'folder', 'updatedAt']),
  outbox: new Set([
    'account',
    'id',
    'status',
    'retryCount',
    'nextRetryAt',
    'sendAt',
    'createdAt',
    'updatedAt',
  ]),
  searchIndex: new Set(['account', 'key', 'updatedAt']),
  meta: new Set(['key', 'updatedAt']),
};

// The meta table is a grab-bag key-value store; only these key families hold
// sensitive content (queued mutations embed auth headers, contact cache,
// attachment blobs, saved searches). Everything else (migration flags, probe
// records, the app_lock_enabled flag the SW reads) stays plaintext.
const SENSITIVE_META_KEY_PREFIXES = [
  'mutation_queue_',
  'contacts_',
  'att_blob_',
  'att_cache_manifest',
  'saved_search_',
];

let aesKey: CryptoKey | null = null;
let encryptionRequired = false;
let loggedLockedRead = false;

export function isSensitiveTable(table: string | undefined | null): boolean {
  return Boolean(table && PLAINTEXT_FIELDS[table]);
}

function metaKeyIsSensitive(key: unknown): boolean {
  if (typeof key !== 'string') return false;
  return SENSITIVE_META_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function recordIsSensitive(table: string, record: DbRecord): boolean {
  if (!isSensitiveTable(table)) return false;
  if (table === 'meta') return metaKeyIsSensitive(record?.key);
  return true;
}

/**
 * True when any key in a `changes` object (Table.update / Collection.modify)
 * would land in the sealed portion of a record. Dotted keypaths count by
 * their root segment.
 */
export function changesTouchSensitiveFields(table: string, changes: unknown): boolean {
  if (!isSensitiveTable(table) || !changes || typeof changes !== 'object') return false;
  const plain = PLAINTEXT_FIELDS[table];
  return Object.keys(changes).some((key) => !plain.has(key.split('.')[0]));
}

export function isDbCryptoActive(): boolean {
  return aesKey !== null || encryptionRequired;
}

export function getDbCryptoState(): { required: boolean; hasKey: boolean } {
  return { required: encryptionRequired, hasKey: aesKey !== null };
}

/**
 * Install (or clear) the encryption key and the fail-closed requirement.
 * Called via the 'configureCrypto' engine action from the main thread.
 */
export async function configureDbCrypto(options: {
  required?: boolean;
  rawKey?: ArrayBuffer | Uint8Array | null;
}): Promise<{ required: boolean; hasKey: boolean }> {
  encryptionRequired = Boolean(options?.required);
  const raw = options?.rawKey ?? null;
  if (raw) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.byteLength !== 32) {
      throw new Error('db-crypto key must be 32 bytes');
    }
    aesKey = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  } else {
    aesKey = null;
  }
  loggedLockedRead = false;
  return getDbCryptoState();
}

function isEnvelope(value: unknown): value is Envelope {
  const env = value as Envelope | null;
  return Boolean(
    env &&
    typeof env === 'object' &&
    typeof env.v === 'number' &&
    typeof env.iv === 'string' &&
    typeof env.data === 'string',
  );
}

// Chunked conversions: String.fromCharCode(...bytes) overflows the call stack
// on multi-MB attachment blobs.
const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptFields(secret: Record<string, unknown>): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(JSON.stringify(secret));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey!, encoded);
  return {
    v: ENVELOPE_VERSION,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptFields(envelope: Envelope): Promise<Record<string, unknown>> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    aesKey!,
    base64ToBytes(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function splitRecord(table: string, record: DbRecord) {
  const plainFields = PLAINTEXT_FIELDS[table];
  const plain: DbRecord = {};
  const secret: Record<string, unknown> = {};
  let hasSecret = false;
  for (const [key, value] of Object.entries(record)) {
    if (key === '_enc') continue;
    if (plainFields.has(key)) {
      plain[key] = value;
    } else if (value !== undefined) {
      secret[key] = value;
      hasSecret = true;
    }
  }
  return { plain, secret, hasSecret };
}

/**
 * Seal a record for storage. No-op when encryption is off or the record is
 * not sensitive; throws DbLockedError when encryption is required but the
 * key is absent.
 */
export async function sealRecord(table: string, record: unknown): Promise<unknown> {
  if (!record || typeof record !== 'object') return record;
  const rec = record as DbRecord;
  if (!recordIsSensitive(table, rec)) return record;

  const { plain, secret, hasSecret } = splitRecord(table, rec);

  if (!aesKey) {
    if (encryptionRequired) throw new DbLockedError();
    return record;
  }

  if (isEnvelope(rec._enc)) {
    // Already sealed. A cursor-path modify (Dexie applies changes to the
    // stored record) can attach plaintext fields NEXT TO an existing
    // envelope. Merge them into the sealed payload instead of dropping or
    // double-storing them.
    if (!hasSecret) return record;
    const existing = await decryptFields(rec._enc);
    const merged = { ...existing, ...secret };
    return { ...plain, _enc: await encryptFields(merged) };
  }

  if (!hasSecret) return record;
  return { ...plain, _enc: await encryptFields(secret) };
}

/**
 * Open a stored record. Legacy plaintext records pass through; sealed records
 * decrypt and merge. When locked, sealed fields are stripped (never expose
 * ciphertext to callers); the UI is behind the lock screen in that state.
 */
export async function openRecord(table: string, record: unknown): Promise<unknown> {
  if (!record || typeof record !== 'object') return record;
  const rec = record as DbRecord;
  if (!isEnvelope(rec._enc)) return record;

  const { _enc, ...plain } = rec;
  if (!aesKey) {
    if (!loggedLockedRead) {
      loggedLockedRead = true;
      console.warn(
        `[db-crypto] Read of sealed ${table} record while locked; sealed fields omitted`,
      );
    }
    return plain;
  }

  try {
    const secret = await decryptFields(_enc);
    return { ...plain, ...secret };
  } catch (err) {
    // Wrong key (e.g. vault was reset), so surface the plaintext shell rather
    // than failing every list read.
    console.error(`[db-crypto] Failed to decrypt ${table} record:`, err);
    return plain;
  }
}

export async function sealRecords(table: string, records: unknown[]): Promise<unknown[]> {
  if (!isDbCryptoActive() || !isSensitiveTable(table)) return records;
  return Promise.all(records.map((r) => sealRecord(table, r)));
}

export async function openRecords(table: string, records: unknown[]): Promise<unknown[]> {
  if (!isSensitiveTable(table)) return records;
  return Promise.all(records.map((r) => openRecord(table, r)));
}

export const SENSITIVE_TABLES = Object.keys(PLAINTEXT_FIELDS);
