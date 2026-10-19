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
import { capIndexedBody, indexableBodyText } from './search-body-text.js';
import {
  armCryptoGate,
  configureDbCrypto,
  changesTouchSensitiveFields,
  isDbCryptoActive,
  getDbCryptoState,
  openRecord,
  openRecords,
  openRecordStrict,
  sealRecord,
  sealRecords,
  recordIsSensitive,
  SENSITIVE_TABLES,
  SENSITIVE_META_KEY_PREFIXES,
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
  serverId?: string | null;
  serverScheduled?: boolean;
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
  cryptoGate?: boolean;
  fields?: string[];
  where?: WhereSpec;
  queryMode?: QueryMode;
  // sortedPage
  order?: string;
  offset?: number;
  limit?: number;
  includeLocalOnly?: boolean;
}

// A where() clause as the client builds it. `equals` is the classic path; the
// others back Dexie's anyOf / startsWith / between on the same index.
export interface WhereSpec {
  op: 'equals' | 'anyOf' | 'startsWith' | 'between';
  value?: unknown;
  values?: unknown[];
  lower?: unknown;
  upper?: unknown;
  includeLower?: boolean;
  includeUpper?: boolean;
}

export type QueryMode =
  | 'toArray'
  | 'first'
  | 'count'
  | 'delete'
  | 'modify'
  | 'primaryKeys'
  | 'summaries'
  | 'fields';

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

function tbl(name: string): Table {
  const tableObj = (db as unknown as Record<string, Table | undefined>)[name];
  if (!tableObj) throw new Error(`Unknown table: ${name}`);
  return tableObj;
}

// ============================================================================
// Generic Table Operations
// ============================================================================

async function tableGet(table: string, key: unknown): Promise<unknown> {
  await ensureReady();
  const record = await (db as unknown as Record<string, Table>)[table].get(key);
  const opened = await openRecord(table, record);
  if (table === 'searchIndex' && opened) return fitSearchIndex(opened);
  return opened;
}

// A result is posted to the asking worker as one structured clone, and
// WebKit kills the whole web process when one gets too big. Older builds
// saved every message's full body text in the search index, which made the
// saved index several gigabytes for a large mailbox: reading it back at
// startup crashed the app on every launch (seen 2026-10-14, a crash every
// thirty seconds as the watchdog reloaded it).
const MAX_SEARCH_INDEX_CHARS = 200_000_000;

type SearchIndexRecord = { data?: Array<Record<string, unknown>> } & Record<string, unknown>;

function searchIndexChars(data: Array<Record<string, unknown>>): number {
  let total = 0;
  for (const entry of data) {
    if (!entry) continue;
    for (const value of Object.values(entry)) {
      if (typeof value === 'string') total += value.length;
    }
  }
  return total;
}

/**
 * Bring a saved search index down to a size that can be sent to a worker:
 * bodies are cut to the length new entries get, and dropped altogether if
 * that is still too much. A changed index is saved back so the work is done
 * once. The search worker fills dropped bodies in again as mail syncs.
 */
async function fitSearchIndex(record: unknown): Promise<unknown> {
  const index = record as SearchIndexRecord;
  if (!Array.isArray(index.data)) return record;
  let changed = false;
  let data = index.data.map((entry) => {
    if (typeof entry?.body !== 'string') return entry;
    const body = capIndexedBody(entry.body);
    if (body === entry.body) return entry;
    changed = true;
    return { ...entry, body };
  });
  if (searchIndexChars(data) > MAX_SEARCH_INDEX_CHARS) {
    changed = true;
    data = data.map((entry) => (entry && 'body' in entry ? { ...entry, body: '' } : entry));
  }
  if (!changed) return record;
  const fitted = { ...index, data };
  try {
    await tablePut('searchIndex', fitted);
  } catch (error) {
    console.warn('[db-engine] could not save the trimmed search index', error);
  }
  return fitted;
}

// Body records hold the raw message and attachment content as well as the
// text. Read them a few at a time so a large mailbox never has gigabytes of
// them in memory at once.
const BODY_TEXT_READ_CHUNK = 50;

/**
 * The searchable text of the given message bodies, without the rest of the
 * record. Missing bodies are left out.
 */
async function bodyTexts(
  table: string,
  keys: unknown[],
): Promise<Array<{ id: string; text: string }>> {
  await ensureReady();
  const store = (db as unknown as Record<string, Table>)[table];
  const out: Array<{ id: string; text: string }> = [];
  for (let i = 0; i < keys.length; i += BODY_TEXT_READ_CHUNK) {
    const stored = await store.bulkGet(keys.slice(i, i + BODY_TEXT_READ_CHUNK) as IndexableType[]);
    const records = (await openRecords(table, stored)) as Array<
      Record<string, unknown> | undefined
    >;
    for (const record of records) {
      if (!record?.id) continue;
      out.push({ id: String(record.id), text: indexableBodyText(record) });
    }
  }
  return out;
}

/**
 * One page of an index match, sorted here by the list's sort order. A
 * subject or sender sort has no index, so the folder is read and sorted in
 * this worker and only the page crosses to the main thread. Sending the
 * whole folder to sort there meant cloning and sorting thousands of rows on
 * the main thread on every list load.
 */
async function sortedPage(
  table: string,
  index: string,
  value: unknown,
  order: string,
  offset = 0,
  limit = 50,
): Promise<unknown[]> {
  await ensureReady();
  const stored = await tbl(table)
    .where(index)
    .equals(value as IndexableType)
    .toArray();
  const rows = (await openRecords(table, stored)) as Array<Record<string, unknown>>;
  rows.sort(rowComparator(order));
  return rows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
}

/**
 * The same orders as sortMessages in message-sort.ts. That module cannot be
 * loaded here: it reaches localStorage through date.ts and i18n. The list
 * re-sorts the page with sortMessages anyway, so this only has to agree on
 * which rows make up a page.
 */
function rowComparator(order: string) {
  const time = (row: Record<string, unknown>) => {
    const value = row.dateMs ?? row.date;
    const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
    return Number.isFinite(ms) ? ms : 0;
  };
  const text = (row: Record<string, unknown>, ...fields: string[]) => {
    for (const field of fields) {
      const value = row[field];
      if (typeof value === 'string' && value) return value;
    }
    return '';
  };
  const newestFirst = (a: Record<string, unknown>, b: Record<string, unknown>) => time(b) - time(a);
  const byText =
    (...fields: string[]) =>
    (a: Record<string, unknown>, b: Record<string, unknown>) =>
      text(a, ...fields).localeCompare(text(b, ...fields), undefined, { sensitivity: 'base' }) ||
      newestFirst(a, b);
  switch (order) {
    case 'oldest':
      return (a: Record<string, unknown>, b: Record<string, unknown>) => time(a) - time(b);
    case 'subject':
      return byText('normalizedSubject', 'subject');
    case 'sender':
      return byText('from', 'From');
    default:
      return newestFirst;
  }
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

// One where() clause on an index, as a Dexie Collection.
function whereCollection(table: string, index: string, spec: WhereSpec) {
  const clause = tbl(table).where(index);
  switch (spec?.op) {
    case 'anyOf':
      return clause.anyOf((spec.values || []) as IndexableType[]);
    case 'startsWith':
      return clause.startsWith(String(spec.value ?? ''));
    case 'between':
      return clause.between(
        spec.lower as IndexableType,
        spec.upper as IndexableType,
        spec.includeLower ?? true,
        spec.includeUpper ?? false,
      );
    case 'equals':
      return clause.equals(spec.value as IndexableType);
    default:
      throw new Error(`Unsupported where clause: ${String(spec?.op)}`);
  }
}

/**
 * Generic where() query. Backs the client's anyOf(), and the count / first /
 * delete / modify terminals of startsWith() and between(), which used to be
 * sent as exact-match queries.
 */
async function queryWhere(
  table: string,
  index: string,
  spec: WhereSpec,
  mode: QueryMode = 'toArray',
  options: QueryOptions = {},
  changes?: unknown,
  fields: string[] = [],
): Promise<unknown> {
  await ensureReady();
  // anyOf([]) is a valid "match nothing" in Dexie; short-circuit it so an
  // empty bulk delete does not cost an IDB round trip.
  if (spec?.op === 'anyOf' && !spec.values?.length) {
    if (mode === 'toArray' || mode === 'primaryKeys') return [];
    if (mode === 'first') return undefined;
    return 0;
  }
  let collection = whereCollection(table, index, spec);
  switch (mode) {
    case 'count':
      return collection.count();
    case 'delete':
      return collection.delete();
    case 'first':
      return openRecord(table, await collection.first());
    case 'primaryKeys':
      return collection.primaryKeys();
    case 'modify':
      return modifyCollection(table, collection, changes);
    case 'summaries': {
      // A page of lightweight rows for housekeeping (cache eviction): the
      // requested plaintext fields plus the stored size. Rows are never
      // decrypted and full bodies never cross the worker boundary.
      if (options.offset) collection = collection.offset(options.offset);
      if (options.limit) collection = collection.limit(options.limit);
      const rows = (await collection.toArray()) as Array<Record<string, unknown>>;
      return rows.map((row) => {
        const summary: Record<string, unknown> = {};
        for (const field of fields) summary[field] = row[field];
        summary.approxBytes = approxStoredBytes(row);
        return summary;
      });
    }
    case 'fields': {
      // Decrypted rows cut down to the requested fields, so a scan that needs
      // a few fields of many rows (the reply index) does not clone whole
      // records to the main thread. Unlike summaries, these are opened.
      if (options.offset) collection = collection.offset(options.offset);
      if (options.limit) collection = collection.limit(options.limit);
      const opened = (await openRecords(table, await collection.toArray())) as Array<
        Record<string, unknown>
      >;
      return opened.map((row) => {
        const picked: Record<string, unknown> = {};
        for (const field of fields) if (row[field] !== undefined) picked[field] = row[field];
        return picked;
      });
    }
    case 'toArray':
    default:
      if (options.reverse) collection = collection.reverse();
      if (options.sortBy) {
        return openRecords(table, await collection.sortBy(options.sortBy));
      }
      if (options.offset) collection = collection.offset(options.offset);
      if (options.limit) collection = collection.limit(options.limit);
      return openRecords(table, await collection.toArray());
  }
}

function approxStoredBytes(row: unknown): number {
  try {
    return JSON.stringify(row)?.length || 0;
  } catch {
    return 0;
  }
}

async function modifyCollection(
  table: string,
  collection: ReturnType<typeof whereCollection>,
  changes: unknown,
): Promise<number> {
  if (!changes || typeof changes !== 'object') {
    throw new Error('modify requires a changes object');
  }
  if (isDbCryptoActive() && changesTouchSensitiveFields(table, changes)) {
    // Same sealed-field hazard as tableUpdate: read, merge, reseal outside
    // any IDB transaction.
    const stored = await collection.toArray();
    if (!stored.length) return 0;
    const resealed = await Promise.all(
      stored.map(async (record) => {
        const opened = (await openRecord(table, record)) as Record<string, unknown>;
        return sealRecord(table, { ...opened, ...(changes as Record<string, unknown>) });
      }),
    );
    await tbl(table).bulkPut(resealed);
    return stored.length;
  }
  return collection.modify(changes as Record<string, unknown>);
}

// ============================================================================
// Transaction Operations
// ============================================================================

// A transaction op after its crypto work is done. Everything here runs inside
// one Dexie transaction, so it may only await Dexie promises: awaiting
// WebCrypto there lets IndexedDB auto-commit and the rest of the ops would run
// outside the transaction.
type PreparedOp =
  | { kind: 'put'; table: string; record: unknown }
  | { kind: 'bulkPut'; table: string; records: unknown[] }
  | { kind: 'delete'; table: string; key: unknown }
  | { kind: 'bulkDelete'; table: string; keys: unknown[] }
  | { kind: 'clear'; table: string }
  | { kind: 'update'; table: string; key: unknown; changes: Record<string, unknown> }
  | { kind: 'replaceIfPresent'; table: string; key: unknown; record: unknown }
  | { kind: 'bulkReplace'; table: string; records: unknown[] }
  | { kind: 'get'; table: string; key: unknown }
  | { kind: 'bulkGet'; table: string; keys: unknown[] }
  | { kind: 'count'; table: string }
  | {
      kind: 'query';
      table: string;
      index: string;
      spec: WhereSpec;
      mode: QueryMode;
      changes?: Record<string, unknown>;
    };

async function prepareTxOp(op: DbOperation): Promise<PreparedOp> {
  const { action, table = '', payload = {} } = op;
  const changes = payload.changes as Record<string, unknown>;
  const sensitiveChange = () => isDbCryptoActive() && changesTouchSensitiveFields(table, changes);
  switch (action) {
    case 'put':
      return { kind: 'put', table, record: await sealRecord(table, payload.record) };
    case 'bulkPut':
      return { kind: 'bulkPut', table, records: await sealRecords(table, payload.records || []) };
    case 'delete':
      return { kind: 'delete', table, key: payload.key };
    case 'bulkDelete':
      return { kind: 'bulkDelete', table, keys: payload.keys || [] };
    case 'clear':
      return { kind: 'clear', table };
    case 'update': {
      if (!sensitiveChange()) return { kind: 'update', table, key: payload.key, changes };
      const stored = await tbl(table).get(payload.key as IndexableType);
      const opened = (await openRecord(table, stored)) as Record<string, unknown> | undefined;
      const record = opened ? await sealRecord(table, { ...opened, ...changes }) : undefined;
      return { kind: 'replaceIfPresent', table, key: payload.key, record };
    }
    case 'get':
      return { kind: 'get', table, key: payload.key };
    case 'bulkGet':
      return { kind: 'bulkGet', table, keys: payload.keys || [] };
    case 'count':
      return { kind: 'count', table };
    case 'queryEqualsDelete':
      return {
        kind: 'query',
        table,
        index: payload.index!,
        spec: { op: 'equals', value: payload.value },
        mode: 'delete',
      };
    case 'query': {
      const mode = payload.queryMode || 'toArray';
      if (!['delete', 'count', 'modify', 'primaryKeys'].includes(mode)) {
        throw new Error(`Unsupported query mode in transaction: ${mode}`);
      }
      if (mode === 'modify') {
        if (sensitiveChange()) {
          const stored = await whereCollection(table, payload.index!, payload.where!).toArray();
          const records = await Promise.all(
            stored.map(async (row) => {
              const opened = (await openRecord(table, row)) as Record<string, unknown>;
              return sealRecord(table, { ...opened, ...changes });
            }),
          );
          return { kind: 'bulkReplace', table, records };
        }
        return {
          kind: 'query',
          table,
          index: payload.index!,
          spec: payload.where!,
          mode: 'modify',
          changes,
        };
      }
      return { kind: 'query', table, index: payload.index!, spec: payload.where!, mode };
    }
    default:
      throw new Error(`Unsupported transaction action: ${action}`);
  }
}

function runPreparedOp(op: PreparedOp): Promise<unknown> {
  const t = tbl(op.table);
  switch (op.kind) {
    case 'put':
      return t.put(op.record);
    case 'bulkPut':
      return t.bulkPut(op.records);
    case 'delete':
      return t.delete(op.key as IndexableType);
    case 'bulkDelete':
      return t.bulkDelete(op.keys as IndexableType[]);
    case 'clear':
      return t.clear();
    case 'update':
      return t.update(op.key as IndexableType, op.changes);
    case 'replaceIfPresent':
      if (!op.record) return Promise.resolve(0);
      // Only write back when the row still exists, as Table.update would.
      return t.get(op.key as IndexableType).then((current) => {
        if (!current) return 0;
        return t.put(op.record).then(() => 1);
      });
    case 'bulkReplace':
      return op.records.length
        ? t.bulkPut(op.records).then(() => op.records.length)
        : Promise.resolve(0);
    case 'get':
      return t.get(op.key as IndexableType);
    case 'bulkGet':
      return t.bulkGet(op.keys as IndexableType[]);
    case 'count':
      return t.count();
    case 'query': {
      if (op.spec?.op === 'anyOf' && !op.spec.values?.length) {
        return Promise.resolve(op.mode === 'primaryKeys' ? [] : 0);
      }
      const collection = whereCollection(op.table, op.index, op.spec);
      if (op.mode === 'delete') return collection.delete();
      if (op.mode === 'count') return collection.count();
      if (op.mode === 'primaryKeys') return collection.primaryKeys();
      return collection.modify(op.changes || {});
    }
    default:
      return Promise.reject(new Error('Unknown prepared op'));
  }
}

/**
 * Run a list of operations as ONE IndexedDB transaction: either every write
 * lands or none does. Crypto (sealing writes, read-merge-reseal updates) is
 * done before the transaction opens and opening read results after it
 * commits, because awaiting WebCrypto inside would let it auto-commit early.
 */
async function runTransaction(
  mode: TransactionMode,
  tables: string | string[],
  operations: DbOperation[],
): Promise<unknown[]> {
  await ensureReady();

  const tableList = Array.isArray(tables) ? tables : [tables];
  const names = tableList
    .map((t) => {
      if (typeof t === 'string') return t;
      const tableObj = t as { name?: string; _table?: string; table?: string; tableName?: string };
      return tableObj?.name || tableObj?._table || tableObj?.table || tableObj?.tableName;
    })
    .filter(Boolean) as string[];
  for (const op of operations || []) {
    if (op.table && !names.includes(op.table)) names.push(op.table);
  }
  const tableObjects = names.map((name) => tbl(name));

  const prepared: PreparedOp[] = [];
  for (const op of operations || []) {
    prepared.push(await prepareTxOp(op));
  }

  const rawResults = await db!.transaction(mode, tableObjects, async () => {
    const results: unknown[] = [];
    for (const op of prepared) {
      results.push(await runPreparedOp(op));
    }
    return results;
  });

  return Promise.all(
    rawResults.map((result, i) => {
      const op = prepared[i];
      if (op.kind === 'get') return openRecord(op.table, result);
      if (op.kind === 'bulkGet') return openRecords(op.table, result as unknown[]);
      return result;
    }),
  );
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

// Drops the copies of server data for every account. Drafts and the outbox
// exist only on this device and are kept unless `includeLocalOnly` is passed
// explicitly; recovery from a storage error must never reach for them. The
// meta table (mutation queue, flags) is always kept.
async function clearCache(options: { includeLocalOnly?: boolean } = {}): Promise<{
  success: boolean;
  cleared: string[];
}> {
  await ensureReady();
  const tables = db as unknown as Record<string, Table | undefined>;
  const names = [...SERVER_COPY_TABLES, 'settingsLabels'];
  if (options.includeLocalOnly) names.push('drafts', 'outbox');
  const cleared: string[] = [];
  for (const name of names) {
    const tableObj = tables[name];
    if (!tableObj) continue;
    await tableObj.clear();
    cleared.push(name);
  }
  return { success: true, cleared };
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
// Progress of an interrupted encrypt sweep, so the next boot can finish it.
// Plaintext on purpose: it holds a table name and a primary key, and it has
// to be readable before the key is configured.
export const SWEEP_PROGRESS_KEY = 'db_crypto_sweep_progress';

interface SweepProgress {
  key: string;
  direction: 'encrypt';
  table: string;
  lastKey: IndexableType | null;
  updatedAt: number;
}

let sweepInFlight: Promise<Record<string, number>> | null = null;

/**
 * Background sweep that upgrades existing plaintext records to sealed
 * envelopes ('encrypt', after App Lock setup) or unwraps everything back to
 * plaintext ('decrypt', before App Lock is disabled). Chunked by primary key
 * so it never holds a whole table in memory. The encrypt direction records
 * its position after every chunk and picks up from there if it is cut short.
 */
async function reencryptAll(direction: 'encrypt' | 'decrypt'): Promise<Record<string, number>> {
  await ensureReady();
  requireKey(`reencryptAll(${direction})`);

  // Never run two sweeps over the same rows at once.
  while (sweepInFlight) {
    await sweepInFlight.catch(() => {});
  }

  const run = (async () => {
    let resumeTable: string | null = null;
    let resumeKey: IndexableType | null = null;
    if (direction === 'encrypt') {
      const progress = (await db!.meta.get(SWEEP_PROGRESS_KEY)) as SweepProgress | undefined;
      if (progress?.direction === 'encrypt' && SENSITIVE_TABLES.includes(progress.table)) {
        resumeTable = progress.table;
        resumeKey = progress.lastKey ?? null;
      }
    }

    const changedByTable: Record<string, number> = {};
    let reachedResumePoint = resumeTable === null;
    for (const tableName of SENSITIVE_TABLES) {
      if (!reachedResumePoint) {
        if (tableName !== resumeTable) continue;
        reachedResumePoint = true;
      }
      const startAfter = tableName === resumeTable ? resumeKey : null;
      const onProgress =
        direction === 'encrypt'
          ? (lastKey: IndexableType | null) => writeSweepProgress(tableName, lastKey)
          : null;
      if (onProgress) await onProgress(startAfter);
      changedByTable[tableName] = await sweepTable(tableName, direction, startAfter, onProgress);
    }
    if (direction === 'encrypt') {
      await db!.meta.delete(SWEEP_PROGRESS_KEY);
    }
    return changedByTable;
  })();

  sweepInFlight = run;
  try {
    return await run;
  } finally {
    if (sweepInFlight === run) sweepInFlight = null;
  }
}

async function writeSweepProgress(table: string, lastKey: IndexableType | null): Promise<void> {
  const record: SweepProgress = {
    key: SWEEP_PROGRESS_KEY,
    direction: 'encrypt',
    table,
    lastKey,
    updatedAt: Date.now(),
  };
  await db!.meta.put(record);
}

/**
 * Finish an encrypt sweep that a previous session started but never
 * completed (app closed, crash, reload). Called once the key is configured.
 */
async function resumePendingSweep(): Promise<void> {
  if (!initialized || !db || sweepInFlight) return;
  try {
    const progress = await db.meta.get(SWEEP_PROGRESS_KEY);
    if (!progress) return;
    const state = getDbCryptoState();
    if (!state.hasKey || !state.required || !state.sealWrites) return;
    await reencryptAll('encrypt');
  } catch (err) {
    console.warn('[db.worker] Resuming the encryption sweep failed:', err);
  }
}

function requireKey(operation: string): void {
  if (!getDbCryptoState().hasKey) {
    throw new Error(`${operation} requires the encryption key to be configured`);
  }
}

// Structured clone keeps property order, so two reads of an untouched row
// serialize identically.
function sameStoredRow(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Seal or unseal every sensitive row of one table, a chunk at a time.
 *
 * The crypto has to run outside an IDB transaction, so each chunk is a
 * read-modify-write: rows are read, converted, and then written back inside a
 * transaction only if they are still exactly what was read. A row that was
 * moved, edited or deleted in the meantime is left as the concurrent write
 * left it. That write already went through sealRecord with the current
 * config, so it is in the right state for this sweep's direction.
 */
async function sweepTable(
  tableName: string,
  direction: 'encrypt' | 'decrypt',
  startAfter: IndexableType | null = null,
  onProgress: ((lastKey: IndexableType | null) => Promise<void>) | null = null,
): Promise<number> {
  const tableObj = (db as unknown as Record<string, Table | undefined>)[tableName];
  if (!tableObj) return 0;
  let changed = 0;
  let cursorKey: IndexableType | null = startAfter;

  for (;;) {
    const collection =
      cursorKey === null ? tableObj.toCollection() : tableObj.where(':id').above(cursorKey);
    const chunkKeys = (await collection
      .limit(REENCRYPT_CHUNK_SIZE)
      .primaryKeys()) as IndexableType[];
    if (!chunkKeys.length) break;

    const rows = (await tableObj.bulkGet(chunkKeys)) as Array<Record<string, unknown> | undefined>;
    const planned: Array<{ key: IndexableType; before: unknown; after: unknown }> = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || !recordIsSensitive(tableName, row)) continue;
      if (direction === 'encrypt') {
        if (row._enc) continue; // already sealed
        const sealed = await sealRecord(tableName, row);
        if (sealed !== row) planned.push({ key: chunkKeys[i], before: row, after: sealed });
      } else {
        if (!row._enc) continue; // already plaintext
        let opened: unknown;
        try {
          opened = await openRecordStrict(tableName, row);
        } catch (err) {
          // Writing back the stripped shell would destroy the sealed content.
          console.error(`[db.worker] Could not decrypt a ${tableName} row; leaving it`, err);
          continue;
        }
        planned.push({ key: chunkKeys[i], before: row, after: opened });
      }
    }

    if (planned.length) {
      changed += await db!.transaction('rw', tableObj, async () => {
        const current = await tableObj.bulkGet(planned.map((p) => p.key));
        const toWrite = planned
          .filter((p, i) => current[i] && sameStoredRow(current[i], p.before))
          .map((p) => p.after);
        if (toWrite.length) await tableObj.bulkPut(toWrite);
        return toWrite.length;
      });
    }

    cursorKey = chunkKeys[chunkKeys.length - 1];
    if (onProgress) await onProgress(cursorKey);
  }
  return changed;
}

// Copies of server data: the tables Settings > Clear Cache drops, and the
// meta families that cache contacts, calendars and downloaded attachments.
// Turning App Lock off drops these and lets sync fetch them again, rather
// than decrypting them. Decrypting a large cache took many minutes (a 10 GB
// one was reported) with the settings button stuck on "Disabling...".
const SERVER_COPY_TABLES = [
  'messages',
  'messageBodies',
  'folders',
  'syncManifests',
  'searchIndex',
  'indexMeta',
  'settings',
];
const SERVER_COPY_META_PREFIXES = [
  'contacts_',
  'att_blob_',
  'att_cache_manifest',
  'calendars_',
  'calendar_events_',
];

async function clearServerCopies(): Promise<string[]> {
  const tables = db as unknown as Record<string, Table | undefined>;
  const cleared: string[] = [];
  for (const tableName of SERVER_COPY_TABLES) {
    const tableObj = tables[tableName];
    if (!tableObj) continue;
    await tableObj.clear();
    cleared.push(tableName);
  }
  for (const prefix of SERVER_COPY_META_PREFIXES) {
    // A key range delete: attachment blobs are never read into memory.
    await db!.meta.where('key').startsWith(prefix).delete();
  }
  return cleared;
}

/**
 * Leave at-rest encryption for good (App Lock being turned off). Drops the
 * server copies and decrypts what exists only on this device: drafts, the
 * outbox, queued changes and saved searches. Needs the key, like
 * reencryptAll, so the local-only data is never lost.
 */
async function unsealForDisable(): Promise<{
  cleared: string[];
  decrypted: Record<string, number>;
}> {
  await ensureReady();
  requireKey('unsealForDisable');
  // An encrypt sweep still running would seal rows behind this one.
  while (sweepInFlight) {
    await sweepInFlight.catch(() => {});
  }

  const cleared = await clearServerCopies();
  await db!.meta.delete(SWEEP_PROGRESS_KEY);

  const decrypted: Record<string, number> = {};
  for (const tableName of SENSITIVE_TABLES) {
    if (SERVER_COPY_TABLES.includes(tableName)) continue;
    decrypted[tableName] = await sweepTable(tableName, 'decrypt');
  }
  return { cleared, decrypted };
}

/**
 * Give up on sealed data that can no longer be opened (App Lock turned off
 * without the key). Server copies are dropped wholesale. In the local-only
 * tables and the sensitive meta families only rows that are actually sealed
 * are removed: plaintext rows written before App Lock, or after it was
 * abandoned, are still readable and are kept. This replaces the old
 * clearCache call, which left every sealed meta row (queued changes, saved
 * searches, the attachment manifest) orphaned and unreadable forever.
 */
async function abandonSealed(): Promise<{ cleared: string[]; removed: Record<string, number> }> {
  await ensureReady();
  while (sweepInFlight) {
    await sweepInFlight.catch(() => {});
  }
  const cleared = await clearServerCopies();
  await db!.meta.delete(SWEEP_PROGRESS_KEY);

  const removed: Record<string, number> = {};
  for (const tableName of SENSITIVE_TABLES) {
    if (SERVER_COPY_TABLES.includes(tableName) || tableName === 'meta') continue;
    const tableObj = (db as unknown as Record<string, Table | undefined>)[tableName];
    if (!tableObj) continue;
    removed[tableName] = await tableObj.filter((row) => Boolean(row?._enc)).delete();
  }
  let metaRemoved = 0;
  for (const prefix of SENSITIVE_META_KEY_PREFIXES) {
    metaRemoved += await db!.meta
      .where('key')
      .startsWith(prefix)
      .filter((row) => Boolean((row as unknown as Record<string, unknown>)?._enc))
      .delete();
  }
  removed.meta = metaRemoved;
  return { cleared, removed };
}

function primaryKeyOf(tableObj: Table, record: Record<string, unknown>): IndexableType {
  const keyPath = tableObj.schema.primKey.keyPath;
  if (Array.isArray(keyPath)) return keyPath.map((k) => record[k]) as IndexableType;
  return record[keyPath as string] as IndexableType;
}

/**
 * Put rows back exactly as they were stored (sealed envelopes stay sealed),
 * without overwriting anything written since. Used after a recovery rebuild
 * to bring back drafts, the outbox and queued changes.
 */
async function restoreRaw(
  table: string,
  records: Array<Record<string, unknown>>,
): Promise<{ restored: number; merged: number }> {
  await ensureReady();
  const tableObj = tbl(table);
  if (!records?.length) return { restored: 0, merged: 0 };
  return db!.transaction('rw', tableObj, async () => {
    const keys = records.map((r) => primaryKeyOf(tableObj, r));
    const existing = (await tableObj.bulkGet(keys)) as Array<Record<string, unknown> | undefined>;
    const toPut: Array<Record<string, unknown>> = [];
    let merged = 0;
    records.forEach((record, i) => {
      const current = existing[i];
      if (!current) {
        toPut.push(record);
        return;
      }
      // A mutation queue written since the rebuild: keep both sets of queued
      // changes rather than dropping the older ones. Sealed queues cannot be
      // merged here, so the newer one wins.
      if (
        table === 'meta' &&
        typeof record.key === 'string' &&
        record.key.startsWith('mutation_queue_') &&
        Array.isArray(record.value) &&
        Array.isArray(current.value)
      ) {
        const seen = new Set(
          (current.value as Array<{ id?: unknown }>).map((m) => JSON.stringify(m?.id ?? m)),
        );
        const extra = (record.value as Array<{ id?: unknown }>).filter(
          (m) => !seen.has(JSON.stringify(m?.id ?? m)),
        );
        if (extra.length) {
          toPut.push({ ...current, value: [...extra, ...(current.value as unknown[])] });
          merged += 1;
        }
      }
    });
    if (toPut.length) await tableObj.bulkPut(toPut);
    return { restored: toPut.length - merged, merged };
  });
}

// ============================================================================
// Operation Dispatcher
// ============================================================================

export async function executeOperation(op: DbOperation): Promise<unknown> {
  const { action, table, payload = {} } = op;

  switch (action) {
    // Initialization
    case 'init':
      // The main thread asks for the gate when it is about to push a crypto
      // config, so nothing sensitive is written or read before it lands.
      if (payload?.cryptoGate && !initialized) armCryptoGate();
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
    case 'bodyTexts':
      return bodyTexts(table!, payload.keys || []);
    case 'sortedPage':
      return sortedPage(
        table!,
        payload.index!,
        payload.value,
        String(payload.order || 'newest'),
        Number(payload.offset || 0),
        Number(payload.limit || 50),
      );
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
    case 'query':
      return queryWhere(
        table!,
        payload.index!,
        payload.where!,
        payload.queryMode,
        payload.options,
        payload.changes,
        payload.fields,
      );

    // Transactions
    case 'transaction':
      return runTransaction(payload.mode!, payload.tables!, payload.operations!);

    // Database management
    case 'getInfo':
      return getDatabaseInfo();
    case 'clearCache':
      return clearCache({ includeLocalOnly: Boolean(payload?.includeLocalOnly) });
    case 'restoreRaw':
      return restoreRaw(table!, (payload.records || []) as Array<Record<string, unknown>>);
    case 'reset':
      return resetDatabase();

    // At-rest encryption (see db-crypto.ts)
    case 'configureCrypto': {
      const state = await configureDbCrypto(
        (payload ?? {}) as {
          required?: boolean;
          rawKey?: ArrayBuffer | Uint8Array | null;
          sealWrites?: boolean;
        },
      );
      if (state.hasKey && state.required && state.sealWrites) {
        // Not awaited: the sweep can take minutes and must not hold up boot.
        void resumePendingSweep();
      }
      return state;
    }
    case 'unsealForDisable':
      return unsealForDisable();
    case 'abandonSealed':
      return abandonSealed();
    case 'reencryptAll':
      return reencryptAll(
        (payload as { direction?: 'encrypt' | 'decrypt' })?.direction ?? 'encrypt',
      );

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
