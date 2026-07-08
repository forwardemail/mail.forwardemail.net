/**
 * Database Engine (context-agnostic)
 *
 * Owns the Dexie/IndexedDB connection and implements every database operation
 * behind a single `executeOperation({ action, table, payload })` dispatcher.
 * Imported by BOTH:
 *   - src/workers/db.worker.ts (normal path): wires self.onmessage →
 *     executeOperation so the DB lives off the main thread.
 *   - src/utils/db-worker-client.js (fallback path): when a runtime probe
 *     finds the worker's IndexedDB is non-functional — notably WebKitGTK on
 *     Linux, which stalls IndexedDB inside Web Workers under the tauri://
 *     scheme — it terminates the worker and calls executeOperation directly so
 *     the DB runs on the main thread instead. Each import context gets its own
 *     module-scoped Dexie instance; only one is ever active at a time.
 */

import Dexie, { type IndexableType, type Table, type TransactionMode } from 'dexie';
import { DB_NAME, DEXIE_VERSION } from './db-constants.ts';
import {
  configureDbCrypto,
  changesTouchSensitiveFields,
  isDbCryptoActive,
  getDbCryptoState,
  openRecord,
  openRecords,
  sealRecord,
  sealRecords,
  recordIsSensitive,
  SENSITIVE_TABLES,
} from './db-crypto';

// Type definitions for database tables
interface Account {
  id: string;
  email: string;
  createdAt?: number;
  updatedAt?: number;
}

interface Folder {
  account: string;
  path: string;
  parentPath?: string;
  unread_count?: number;
  specialUse?: string;
  updatedAt?: number;
}

interface Message {
  account: string;
  id: string;
  folder: string;
  from?: string;
  subject?: string;
  snippet?: string;
  date?: number;
  flags?: string[];
  is_unread?: boolean;
  is_unread_index?: number;
  has_attachment?: boolean;
  modseq?: string | number;
  updatedAt?: number;
  bodyIndexed?: boolean;
  labels?: string[];
}

interface MessageBody {
  account: string;
  id: string;
  folder?: string;
  body?: string;
  textContent?: string;
  attachments?: unknown[];
  updatedAt?: number;
  sanitizedAt?: number;
  trackingPixelCount?: number;
  blockedRemoteImageCount?: number;
  raw?: string;
}

interface Draft {
  account: string;
  id: string;
  folder?: string;
  updatedAt?: number;
}

interface SearchIndexEntry {
  account: string;
  key: string;
  updatedAt?: number;
}

interface IndexMeta {
  account: string;
  key: string;
  updatedAt?: number;
}

interface Meta {
  key: string;
  updatedAt?: number;
}

interface SyncManifest {
  account: string;
  folder: string;
  lastUID?: number;
  lastSyncAt?: number;
  pagesFetched?: number;
  messagesFetched?: number;
  hasBodiesPass?: boolean;
  updatedAt?: number;
}

interface Label {
  account: string;
  id: string;
  name?: string;
  color?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface Settings {
  account: string;
  settings?: unknown;
  updatedAt?: number;
}

interface SettingsLabels {
  account: string;
  labels?: unknown[];
  updatedAt?: number;
}

interface OutboxItem {
  account: string;
  id: string;
  status?: string;
  retryCount?: number;
  nextRetryAt?: number;
  sendAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

// Database class with typed tables
class WebmailDatabase extends Dexie {
  accounts!: Table<Account>;
  folders!: Table<Folder>;
  messages!: Table<Message>;
  messageBodies!: Table<MessageBody>;
  drafts!: Table<Draft>;
  searchIndex!: Table<SearchIndexEntry>;
  indexMeta!: Table<IndexMeta>;
  meta!: Table<Meta>;
  syncManifests!: Table<SyncManifest>;
  labels!: Table<Label>;
  settings!: Table<Settings>;
  settingsLabels!: Table<SettingsLabels>;
  outbox!: Table<OutboxItem>;

  constructor(name: string) {
    super(name);
    // Version 1: the original schema. Kept so installs still on it upgrade
    // in place when they open the database with the newer declaration below.
    this.version(1).stores({
      accounts: 'id,email,createdAt,updatedAt',
      folders: '[account+path],account,path,parentPath,unread_count,specialUse,updatedAt',
      messages:
        '[account+id],id,folder,account,[account+folder],[account+folder+date],[account+folder+is_unread_index],from,subject,snippet,date,flags,is_unread,is_unread_index,has_attachment,modseq,updatedAt,bodyIndexed,labels',
      messageBodies:
        '[account+id],account,id,[account+folder],folder,body,textContent,attachments,updatedAt,sanitizedAt,trackingPixelCount,blockedRemoteImageCount',
      drafts: '[account+id],id,account,folder,updatedAt',
      searchIndex: '[account+key],key,account,updatedAt',
      indexMeta: '[account+key],key,account,updatedAt',
      meta: 'key,updatedAt',
      syncManifests:
        '[account+folder],account,folder,lastUID,lastSyncAt,pagesFetched,messagesFetched,hasBodiesPass,updatedAt',
      labels: '[account+id],id,account,name,color,createdAt,updatedAt',
      settings: 'account,settings,updatedAt',
      settingsLabels: 'account,labels,updatedAt',
      outbox: '[account+id],id,account,status,retryCount,nextRetryAt,sendAt,createdAt,updatedAt',
    });
    // Version 2: keep only indexes a real query path uses. Version 1 indexed
    // nearly every field, and on the two highest-write tables that meant
    // building secondary B-trees over full email bodies (messageBodies.body,
    // textContent, attachments) and a dozen never-queried message fields.
    // Dropping them cuts write amplification during sync and shrinks the
    // database on disk. Records themselves are untouched by the upgrade.
    // The keep-list mirrors PLAINTEXT_FIELDS in db-crypto.ts; both derive
    // from the same audit of every .where() call in the app and workers
    // (public/sw-sync.js and sync-core.js use no indexes at all).
    this.version(DEXIE_VERSION).stores({
      accounts: 'id',
      folders: '[account+path],account',
      // from: kept for the empty-sender repair sweep in sync.worker.ts.
      // folder: kept for the cross-account count in Mailbox.svelte.
      messages:
        '[account+id],account,folder,[account+folder],[account+folder+date],[account+folder+is_unread_index],from',
      messageBodies: '[account+id],account,[account+folder]',
      drafts: '[account+id],account',
      searchIndex: '[account+key],account',
      indexMeta: '[account+key],account',
      meta: 'key',
      syncManifests: '[account+folder],account',
      labels: '[account+id],account',
      settings: 'account',
      settingsLabels: 'account',
      outbox: '[account+id],account',
    });
  }
}

// Single Dexie instance for all operations
let db: WebmailDatabase | null = null;
let activeDbName: string | null = null;

function createDb(name: string): WebmailDatabase {
  return new WebmailDatabase(name);
}

// Track initialization state
let initialized = false;
let initPromise: Promise<{ success: boolean }> | null = null;

export interface DbOperationPayload {
  key?: unknown;
  keys?: unknown[];
  record?: unknown;
  records?: unknown[];
  changes?: unknown;
  index?: string;
  value?: unknown;
  lower?: unknown;
  upper?: unknown;
  options?: {
    reverse?: boolean;
    sortBy?: string;
    offset?: number;
    limit?: number;
    includeLower?: boolean;
    includeUpper?: boolean;
  };
  mode?: TransactionMode;
  tables?: string[];
  operations?: DbOperation[];
  dbName?: string;
}

export interface DbOperation {
  action: string;
  table?: string;
  payload?: DbOperationPayload;
}

export interface DbWorkerMessage {
  id?: number;
  action?: string;
  table?: string;
  payload?: DbOperationPayload;
  type?: string;
  workerId?: string;
}

export interface DbWorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorName?: string;
  errorCode?: string | number;
}

/**
 * Initialize the database
 */
async function initializeDb(nameOverride: string | null = null): Promise<{ success: boolean }> {
  if (initialized && (!nameOverride || nameOverride === activeDbName)) {
    return { success: true };
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const name = nameOverride || DB_NAME;
      if (!db || activeDbName !== name) {
        if (db?.isOpen?.()) {
          await db.close();
        }
        db = createDb(name);
        activeDbName = name;
        initialized = false;
      }
      await db.open();
      initialized = true;

      // One-time migration: remove messages whose `id` is a Message-ID header
      // (contains @ and angle brackets). These are orphaned records from a bug
      // where normalizeMessageForCache used the Message-ID email header as the
      // record ID, causing forwarded emails to overwrite each other in IDB.
      try {
        const migrationKey = 'migration:purge-message-id-header-keys';
        const already = await db.meta.get(migrationKey);
        if (!already) {
          const allMessages = await db.messages.toArray();
          const bad = allMessages.filter((m) => {
            const id = m?.id;
            return (
              typeof id === 'string' && id.includes('@') && (id.startsWith('<') || id.includes('>'))
            );
          });
          if (bad.length) {
            const keys = bad.map((m) => [m.account, m.id]);
            await db.messages.bulkDelete(keys);
            // Also clean up corresponding message bodies
            await db.messageBodies.bulkDelete(keys).catch(() => {});
            console.log(`[db.worker] Migration: purged ${bad.length} orphaned message records`);
          }
          await db.meta.put({ key: migrationKey, updatedAt: Date.now() });
        }
      } catch (err) {
        console.warn('[db.worker] Migration failed (non-fatal):', err);
      }

      return { success: true };
    } catch (error) {
      console.error('[db.worker] Database initialization failed:', error);
      initialized = false;
      throw error;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Ensure database is ready before operations
 */
async function ensureReady(): Promise<void> {
  if (!db) {
    await initializeDb();
  }
  if (!initialized) {
    await initializeDb();
  }
  if (!db!.isOpen()) {
    await db!.open();
  }
}

// ============================================================================
// Generic Table Operations
// ============================================================================

async function tableGet(table: string, key: unknown): Promise<unknown> {
  await ensureReady();
  const record = await (db as unknown as Record<string, Table>)[table].get(key);
  return openRecord(table, record);
}

async function tablePut(table: string, record: unknown): Promise<unknown> {
  await ensureReady();
  return (db as unknown as Record<string, Table>)[table].put(await sealRecord(table, record));
}

async function tableDelete(table: string, key: unknown): Promise<void> {
  await ensureReady();
  return (db as unknown as Record<string, Table>)[table].delete(key);
}

async function tableUpdate(table: string, key: unknown, changes: unknown): Promise<number> {
  await ensureReady();
  const tableObj = (db as unknown as Record<string, Table>)[table];
  // When the change set touches sealed fields, Dexie's in-place update would
  // write them as plaintext siblings of the envelope. Read-merge-reseal
  // instead. The crypto must run OUTSIDE an IDB transaction (awaiting
  // WebCrypto lets the transaction auto-commit), so this is a plain RMW,
  // the same race window Dexie's own get-then-put callers already have.
  if (isDbCryptoActive() && changesTouchSensitiveFields(table, changes)) {
    const stored = await tableObj.get(key);
    if (!stored) return 0;
    const opened = (await openRecord(table, stored)) as Record<string, unknown>;
    const merged = { ...opened, ...(changes as Record<string, unknown>) };
    await tableObj.put(await sealRecord(table, merged));
    return 1;
  }
  return tableObj.update(key, changes);
}

async function tableClear(table: string): Promise<void> {
  await ensureReady();
  return (db as unknown as Record<string, Table>)[table].clear();
}

async function tableCount(table: string): Promise<number> {
  await ensureReady();
  return (db as unknown as Record<string, Table>)[table].count();
}

async function tableBulkGet(table: string, keys: unknown[]): Promise<unknown[]> {
  await ensureReady();
  const records = await (db as unknown as Record<string, Table>)[table].bulkGet(keys);
  return openRecords(table, records);
}

async function tableBulkPut(table: string, records: unknown[]): Promise<unknown> {
  await ensureReady();
  return (db as unknown as Record<string, Table>)[table].bulkPut(await sealRecords(table, records));
}

async function tableBulkDelete(table: string, keys: unknown[]): Promise<void> {
  await ensureReady();
  return (db as unknown as Record<string, Table>)[table].bulkDelete(keys);
}

async function tableToArray(table: string): Promise<unknown[]> {
  await ensureReady();
  const records = await (db as unknown as Record<string, Table>)[table].toArray();
  return openRecords(table, records);
}

// ============================================================================
// Query Operations (where clauses)
// ============================================================================

interface QueryOptions {
  reverse?: boolean;
  sortBy?: string;
  offset?: number;
  limit?: number;
  includeLower?: boolean;
  includeUpper?: boolean;
}

async function queryEquals(
  table: string,
  index: string,
  value: unknown,
  options: QueryOptions = {},
): Promise<unknown[]> {
  await ensureReady();
  let query = (db as unknown as Record<string, Table>)[table].where(index).equals(value);

  if (options.reverse) {
    query = query.reverse();
  }
  if (options.sortBy) {
    // Sort fields are always plaintext (see PLAINTEXT_FIELDS), so sorting
    // sealed records is stable; open them afterwards.
    return openRecords(table, await query.sortBy(options.sortBy));
  }
  if (options.offset) {
    query = query.offset(options.offset);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }

  return openRecords(table, await query.toArray());
}

async function queryEqualsFirst(table: string, index: string, value: unknown): Promise<unknown> {
  await ensureReady();
  const record = await (db as unknown as Record<string, Table>)[table]
    .where(index)
    .equals(value)
    .first();
  return openRecord(table, record);
}

async function queryEqualsCount(table: string, index: string, value: unknown): Promise<number> {
  await ensureReady();
  return (db as unknown as Record<string, Table>)[table].where(index).equals(value).count();
}

async function queryEqualsDelete(table: string, index: string, value: unknown): Promise<number> {
  await ensureReady();
  return (db as unknown as Record<string, Table>)[table].where(index).equals(value).delete();
}

async function queryEqualsModify(
  table: string,
  index: string,
  value: unknown,
  changes: unknown,
): Promise<number> {
  await ensureReady();
  const tableObj = (db as unknown as Record<string, Table>)[table];
  // Same sealed-field hazard as tableUpdate: cursor-path modify would write
  // plaintext siblings of the envelope. Read-merge-reseal the matches
  // (crypto outside any IDB transaction, see tableUpdate).
  if (isDbCryptoActive() && changesTouchSensitiveFields(table, changes)) {
    const stored = await tableObj
      .where(index)
      .equals(value as IndexableType)
      .toArray();
    if (!stored.length) return 0;
    const resealed = await Promise.all(
      stored.map(async (record) => {
        const opened = (await openRecord(table, record)) as Record<string, unknown>;
        return sealRecord(table, { ...opened, ...(changes as Record<string, unknown>) });
      }),
    );
    await tableObj.bulkPut(resealed);
    return stored.length;
  }
  return tableObj.where(index).equals(value).modify(changes);
}

async function queryBetween(
  table: string,
  index: string,
  lower: unknown,
  upper: unknown,
  options: QueryOptions = {},
): Promise<unknown[]> {
  await ensureReady();
  let query = (db as unknown as Record<string, Table>)[table]
    .where(index)
    .between(lower, upper, options.includeLower, options.includeUpper);

  if (options.reverse) {
    query = query.reverse();
  }
  if (options.sortBy) {
    return openRecords(table, await query.sortBy(options.sortBy));
  }
  if (options.offset) {
    query = query.offset(options.offset);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }

  return openRecords(table, await query.toArray());
}

async function queryStartsWith(
  table: string,
  index: string,
  value: string,
  options: QueryOptions = {},
): Promise<unknown[]> {
  await ensureReady();
  let query = (db as unknown as Record<string, Table>)[table].where(index).startsWith(value);

  if (options.reverse) {
    query = query.reverse();
  }
  if (options.sortBy) {
    return openRecords(table, await query.sortBy(options.sortBy));
  }
  if (options.offset) {
    query = query.offset(options.offset);
  }
  if (options.limit) {
    query = query.limit(options.limit);
  }

  return openRecords(table, await query.toArray());
}

// ============================================================================
// Transaction Operations
// ============================================================================

async function runTransaction(
  mode: TransactionMode,
  tables: string | string[],
  operations: DbOperation[],
): Promise<unknown[]> {
  await ensureReady();

  // Map table names to actual table objects
  const tableList = Array.isArray(tables) ? tables : [tables];
  const tableObjects = tableList
    .map((t) => {
      if (typeof t === 'string') return (db as unknown as Record<string, Table>)[t];
      const tableObj = t as { name?: string; _table?: string; table?: string; tableName?: string };
      const name = tableObj?.name || tableObj?._table || tableObj?.table || tableObj?.tableName;
      return name ? (db as unknown as Record<string, Table>)[name] : null;
    })
    .filter(Boolean) as Table[];

  return db!.transaction(mode, tableObjects, async () => {
    const results: unknown[] = [];
    for (const op of operations) {
      const result = await executeOperation(op);
      results.push(result);
    }
    return results;
  });
}

// ============================================================================
// Database Management
// ============================================================================

interface DatabaseInfo {
  version: number;
  name: string;
  isOpen: boolean;
  tables: Array<{ name: string; schema: string | undefined }>;
  counts: Record<string, number>;
}

async function getDatabaseInfo(): Promise<DatabaseInfo> {
  await ensureReady();

  const info: DatabaseInfo = {
    version: db!.verno,
    name: db!.name,
    isOpen: db!.isOpen(),
    tables: db!.tables.map((t) => ({
      name: t.name,
      schema: t.schema.primKey?.keyPath?.toString() || t.schema.primKey?.name,
    })),
    counts: {},
  };

  for (const table of db!.tables) {
    try {
      info.counts[table.name] = await table.count();
    } catch {
      info.counts[table.name] = 0;
    }
  }

  return info;
}

// Nuclear cache clear — wipes ALL accounts. Only used for database error recovery.
// For per-account cleanup, use clearAccountCacheData() in storage.js instead.
async function clearCache(): Promise<{ success: boolean }> {
  await ensureReady();

  await Promise.all([
    db!.folders.clear(),
    db!.messages.clear(),
    db!.messageBodies.clear(),
    db!.syncManifests?.clear?.(),
    db!.searchIndex.clear(),
    db!.indexMeta.clear(),
    db!.drafts.clear(),
    db!.outbox.clear(),
    db!.settings?.clear?.(),
    db!.settingsLabels?.clear?.(),
    // meta table intentionally kept
  ]);

  return { success: true };
}

async function resetDatabase(): Promise<{ success: boolean; error?: string }> {
  try {
    if (db!.isOpen()) {
      await db!.close();
    }
    await db!.delete();
    await db!.open();
    initialized = true;
    return { success: true };
  } catch (error) {
    console.error('[db.worker] Reset failed:', error);
    return { success: false, error: (error as Error).message };
  }
}

async function closeDatabase(): Promise<{ success: boolean }> {
  if (db!.isOpen()) {
    await db!.close();
  }
  initialized = false;
  return { success: true };
}

async function tableCollection(table: string, options: QueryOptions = {}): Promise<unknown[]> {
  await ensureReady();
  let collection = (db as unknown as Record<string, Table>)[table].toCollection();
  if (options.reverse) {
    collection = collection.reverse();
  }
  if (options.offset) {
    collection = collection.offset(options.offset);
  }
  if (options.limit) {
    collection = collection.limit(options.limit);
  }
  return openRecords(table, await collection.toArray());
}

// ============================================================================
// At-Rest Encryption Management
// ============================================================================

const REENCRYPT_CHUNK_SIZE = 200;

/**
 * Background sweep that upgrades existing plaintext records to sealed
 * envelopes ('encrypt', after App Lock setup) or unwraps everything back to
 * plaintext ('decrypt', before App Lock is disabled). Chunked by primary key
 * so it never holds a whole table in memory.
 */
async function reencryptAll(direction: 'encrypt' | 'decrypt'): Promise<Record<string, number>> {
  await ensureReady();
  const state = getDbCryptoState();
  if (!state.hasKey) {
    throw new Error(`reencryptAll(${direction}) requires the encryption key to be configured`);
  }

  const changedByTable: Record<string, number> = {};
  for (const tableName of SENSITIVE_TABLES) {
    const tableObj = (db as unknown as Record<string, Table>)[tableName];
    if (!tableObj) continue;
    const primKeys = await tableObj.toCollection().primaryKeys();
    let changed = 0;

    for (let i = 0; i < primKeys.length; i += REENCRYPT_CHUNK_SIZE) {
      const chunkKeys = primKeys.slice(i, i + REENCRYPT_CHUNK_SIZE);
      const rows = (await tableObj.bulkGet(chunkKeys)) as Array<
        Record<string, unknown> | undefined
      >;
      const updates: unknown[] = [];

      for (const row of rows) {
        if (!row || !recordIsSensitive(tableName, row)) continue;
        if (direction === 'encrypt') {
          if (row._enc) continue; // already sealed
          const sealed = await sealRecord(tableName, row);
          if (sealed !== row) updates.push(sealed);
        } else {
          if (!row._enc) continue; // already plaintext
          updates.push(await openRecord(tableName, row));
        }
      }

      if (updates.length) {
        await tableObj.bulkPut(updates);
        changed += updates.length;
      }
    }
    changedByTable[tableName] = changed;
  }
  return changedByTable;
}

// ============================================================================
// Operation Dispatcher
// ============================================================================

export async function executeOperation(op: DbOperation): Promise<unknown> {
  const { action, table, payload = {} } = op;

  switch (action) {
    // Initialization
    case 'init':
      return initializeDb(payload?.dbName ?? null);
    case 'close':
      return closeDatabase();

    // Generic table operations
    case 'get':
      return tableGet(table!, payload.key);
    case 'put':
      return tablePut(table!, payload.record);
    case 'delete':
      return tableDelete(table!, payload.key);
    case 'update':
      return tableUpdate(table!, payload.key, payload.changes);
    case 'clear':
      return tableClear(table!);
    case 'count':
      return tableCount(table!);
    case 'bulkGet':
      return tableBulkGet(table!, payload.keys!);
    case 'bulkPut':
      return tableBulkPut(table!, payload.records!);
    case 'bulkDelete':
      return tableBulkDelete(table!, payload.keys!);
    case 'toArray':
      return tableToArray(table!);

    // Query operations
    case 'queryEquals':
      return queryEquals(table!, payload.index!, payload.value, payload.options);
    case 'queryEqualsFirst':
      return queryEqualsFirst(table!, payload.index!, payload.value);
    case 'queryEqualsCount':
      return queryEqualsCount(table!, payload.index!, payload.value);
    case 'queryEqualsDelete':
      return queryEqualsDelete(table!, payload.index!, payload.value);
    case 'queryEqualsModify':
      return queryEqualsModify(table!, payload.index!, payload.value, payload.changes);
    case 'queryBetween':
      return queryBetween(table!, payload.index!, payload.lower, payload.upper, payload.options);
    case 'queryStartsWith':
      return queryStartsWith(table!, payload.index!, payload.value as string, payload.options);
    case 'tableCollection':
      return tableCollection(table!, payload.options);

    // Transactions
    case 'transaction':
      return runTransaction(payload.mode!, payload.tables!, payload.operations!);

    // Database management
    case 'getInfo':
      return getDatabaseInfo();
    case 'clearCache':
      return clearCache();
    case 'reset':
      return resetDatabase();

    // At-rest encryption (see db-crypto.ts)
    case 'configureCrypto':
      return configureDbCrypto(
        (payload ?? {}) as { required?: boolean; rawKey?: ArrayBuffer | Uint8Array | null },
      );
    case 'reencryptAll':
      return reencryptAll(
        (payload as { direction?: 'encrypt' | 'decrypt' })?.direction ?? 'encrypt',
      );

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
