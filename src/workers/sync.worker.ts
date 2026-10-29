/**
 * Dedicated Sync Worker
 *
 * Handles API synchronization and message fetching off the main thread.
 * Database operations are routed through db.worker.js via MessageChannel.
 */

import PostalMime from 'postal-mime';
import * as openpgp from 'openpgp';
import {
  normalizeMessageForCache,
  mergeFlagsAndMetadata,
  mergeServerRow,
  applyPendingFlagChange,
  extractFromField,
  type PendingFlagChange,
} from '../utils/sync-helpers.ts';
import { normalizeSubject } from '../utils/threading.ts';
import { splitSignedMime } from '../utils/pgp-signed-parts';
import {
  bufferToDataUrl,
  applyInlineAttachments,
  extractTextContent,
} from '../utils/mime-utils.js';
import {
  toKey,
  accountKey,
  coerceLabelList,
  hasServerLabels,
  hasFromValue,
  hasMeaningfulDraft,
  buildDraftPayload,
  parseResultList,
  isPgpContent,
  isPgpLockedStatus,
  slimBodyMeta,
  slimCachedAttachments,
  worklistFromHeaders,
  backfillBatchDone,
  type CachedBodyStatus,
} from './sync-pure.ts';
import { createCircuitBreaker, parseRetryAfterMs } from '../utils/circuit-breaker.js';
import { assertAccountScoped } from '../utils/account-scope.ts';

// ============================================================================
// Database Client via MessageChannel
// ============================================================================

let dbPort = null;
let dbRequestId = 0;
const dbPendingRequests = new Map();

// How long a database request may go unanswered. A port whose db worker died
// never replies, and without a deadline every sync waiting on it hangs.
const DB_REQUEST_TIMEOUT_MS = 60_000;
// How long opening a message waits for its cached body before downloading it.
const CACHE_LOOKUP_WAIT_MS = 1_500;
// Set when a database request went unanswered, cleared by the next answer or
// a new port. While set, opening a message does not wait on the cache at all.
let dbStalled = false;

function dbSend(action, table: string | null = null, payload: Record<string, unknown> = {}) {
  return new Promise((resolve, reject) => {
    if (!dbPort) {
      reject(new Error('Database worker not connected'));
      return;
    }

    const id = ++dbRequestId;
    const timer = setTimeout(() => {
      if (!dbPendingRequests.has(id)) return;
      dbPendingRequests.delete(id);
      // The port may be dead (the database moved and this side was not told);
      // the main thread opens a new one.
      if (!dbStalled) {
        dbStalled = true;
        self.postMessage({ type: 'dbStalled', action });
      }
      reject(new Error(`Database request "${action}" timed out after ${DB_REQUEST_TIMEOUT_MS}ms`));
    }, DB_REQUEST_TIMEOUT_MS);
    dbPendingRequests.set(id, { resolve, reject, timer });
    dbPort.postMessage({ id, action, table, payload });
  });
}

// Fail every request still waiting on the current port. Used when a new port
// replaces it, since the db worker closes the old one and will not answer.
function rejectPendingDbRequests(error) {
  for (const pending of dbPendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  dbPendingRequests.clear();
}

function handleDbResponse(event) {
  const { id, ok, result, error } = event.data || {};
  const pending = dbPendingRequests.get(id);
  if (!pending) return;

  dbPendingRequests.delete(id);
  clearTimeout(pending.timer);
  dbStalled = false;
  if (ok) {
    pending.resolve(result);
  } else {
    pending.reject(new Error(error || 'Database operation failed'));
  }
}

// Database proxy object
const db = {
  syncManifests: {
    get: (key) => dbSend('get', 'syncManifests', { key }),
    put: (record) => dbSend('put', 'syncManifests', { record }),
  },
  messages: {
    bulkGet: (keys) => dbSend('bulkGet', 'messages', { keys }),
    bulkPut: (records) => dbSend('bulkPut', 'messages', { records }),
    bulkDelete: (keys) => dbSend('bulkDelete', 'messages', { keys }),
    // Field-level write: only `changes` are written, read and merged inside
    // the db worker, so fields another writer changed meanwhile survive.
    update: (key, changes) => dbSend('update', 'messages', { key, changes }),
    where: (index) => ({
      equals: (value) => ({
        toArray: () => dbSend('queryEquals', 'messages', { index, value }),
        delete: () => dbSend('queryEqualsDelete', 'messages', { index, value }),
        modify: (changes) => dbSend('queryEqualsModify', 'messages', { index, value, changes }),
      }),
    }),
  },
  messageBodies: {
    get: (key) => dbSend('get', 'messageBodies', { key }),
    bulkGet: (keys) => dbSend('bulkGet', 'messageBodies', { keys }),
    put: (record) => dbSend('put', 'messageBodies', { record }),
    bulkDelete: (keys) => dbSend('bulkDelete', 'messageBodies', { keys }),
    where: (index) => ({
      equals: (value) => ({
        toArray: () => dbSend('queryEquals', 'messageBodies', { index, value }),
      }),
    }),
  },
  folders: {
    get: (key) => dbSend('get', 'folders', { key }),
    bulkPut: (records) => dbSend('bulkPut', 'folders', { records }),
    where: (index) => ({
      equals: (value) => ({
        delete: () => dbSend('queryEqualsDelete', 'folders', { index, value }),
      }),
    }),
  },
  drafts: {
    put: (record) => dbSend('put', 'drafts', { record }),
    where: (index) => ({
      equals: (value) => ({
        toArray: () => dbSend('queryEquals', 'drafts', { index, value }),
      }),
    }),
  },
};

// ============================================================================
// Worker State
// ============================================================================

let apiBase = '';

// Auth is keyed BY ACCOUNT, never held as a single "current" header. The worker
// outlives account switches: a metadata/backfill loop for account A keeps
// fetching pages after the user switches to B, and B's `init` used to overwrite
// one shared `authHeader`. A's still-running loop then fetched B's mailbox with
// B's credentials and wrote the results under `account: A`, so B's mail appeared
// date-interleaved in A's folders and persisted in IndexedDB across reloads.
// Keying by account makes that mismatch structurally impossible: whatever
// account a task names is the account its requests authenticate as, or the
// request does not go out at all.
const authHeaders = new Map<string, string>();

let unlockedPgpKeys = [];
// Bumped whenever the unlocked keys change. A PGP body cached still encrypted
// (pgpLocked) is tried again once per key set: a pass that ran before the
// keys were unlocked must not leave it encrypted for good, and one encrypted
// to a key we do not have must not be retried on every pass.
let pgpKeysVersion = 0;
const pgpLockedTried = new Map<string, number>();
const lockedTriedWithCurrentKeys = (account: string, id: string) =>
  pgpLockedTried.get(`${account}::${id}`) === pgpKeysVersion;
const canTryLockedBody = (account: string, id: string) =>
  unlockedPgpKeys.length > 0 && !lockedTriedWithCurrentKeys(account, id);
let pgpPassphrases = {};
let searchPort = null;

const authFor = (account: string): string => authHeaders.get(account) || '';

// A task naming an account we hold no credentials for is a stale task from a
// previous session (its account was switched away and its auth evicted). Fail
// it loudly rather than letting it fetch as somebody else.
function requireAuth(account: string): string {
  const header = authFor(account);
  if (!header) {
    throw new Error(`No credentials for account ${account || '(none)'}: account switched`);
  }
  return header;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_BODY_LIMIT = 50;
const FETCH_TIMEOUT_MS = 30000; // 30s timeout for individual fetch calls

const manifests = new Map(); // key: `${account}::${folder}`
const inFlightBodyRequests = new Map(); // key: `${account}::${id}`

// ============================================================================
// Manifest Management
// ============================================================================

async function getManifest(account, folder) {
  const key = toKey(account, folder);
  if (manifests.has(key)) return manifests.get(key);

  let existing = null;
  if (dbPort) {
    try {
      existing = await db.syncManifests.get([account, folder]);
    } catch (err) {
      console.warn('[sync.worker] getManifest failed:', err);
    }
  }

  const manifest = existing || {
    account,
    folder,
    lastUID: 0,
    lastModSeq: null,
    pagesFetched: 0,
    messagesFetched: 0,
    hasBodiesPass: false,
    lastSyncAt: 0,
    updatedAt: 0,
  };
  manifests.set(key, manifest);
  return manifest;
}

async function updateManifest(account, folder, updates = {}) {
  const manifest = await getManifest(account, folder);
  const next = {
    ...manifest,
    ...updates,
    account,
    folder,
    updatedAt: Date.now(),
  };
  manifests.set(toKey(account, folder), next);

  if (dbPort) {
    try {
      await db.syncManifests.put(next);
    } catch (err) {
      console.warn('[sync.worker] updateManifest failed:', err);
    }
  }
  return next;
}

// ============================================================================
// Utilities
// ============================================================================

async function syncDraftRecord(draft, account) {
  const payload = buildDraftPayload(draft);
  const url = draft.serverId
    ? `${apiBase.replace(/\/$/, '')}/v1/messages/${encodeURIComponent(draft.serverId)}`
    : `${apiBase.replace(/\/$/, '')}/v1/messages`;
  const res = await fetchWithTimeout(url, {
    method: draft.serverId ? 'PUT' : 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: requireAuth(account),
      'Content-Type': 'application/json',
    },
    // a new draft is saved read and flagged as a draft, as mail clients save
    // drafts (an update leaves the flags alone)
    body: JSON.stringify(draft.serverId ? payload : { ...payload, flags: ['\\Draft', '\\Seen'] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText || 'Request failed');
  }
  const json = await res.json();
  const serverId =
    json?.id ||
    json?.Id ||
    json?.message_id ||
    json?.messageId ||
    json?.Result?.id ||
    draft.serverId ||
    null;
  const updated = {
    ...draft,
    serverId,
    syncStatus: 'synced',
    lastError: null,
    lastSyncedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.drafts.put(updated);
  return updated;
}

// ============================================================================
// Fetch with Timeout
// ============================================================================

// Independent circuit breaker for the worker's own raw-fetch path (the
// main-thread Remote.request path has its own instance). The body-backfill
// loop is the app's highest-volume request source, so when the backend is
// struggling we fail background GETs fast here too instead of hammering it.
const fetchCircuit = createCircuitBreaker();

function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const method = (options.method || 'GET').toUpperCase();

  // Fail GETs fast while the breaker is open. Mutations (draft sync POST/PUT)
  // always go through — they're low-volume and user-initiated.
  if (method === 'GET' && fetchCircuit.isOpen()) {
    const err = new Error('Backing off: service temporarily unavailable');
    (err as Error & { circuitOpen?: boolean }).circuitOpen = true;
    return Promise.reject(err);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .then((res) => {
      // 429/5xx mean rate-limited or struggling; anything else (incl. 4xx like
      // 404) proves the backend is alive and closes the breaker.
      if (res.status === 429) {
        fetchCircuit.recordFailure(parseRetryAfterMs(res.headers));
      } else if (res.status >= 500) {
        fetchCircuit.recordFailure();
      } else {
        fetchCircuit.recordSuccess();
      }
      return res;
    })
    .catch((err) => {
      // AbortError (our timeout) or a network error — both transient.
      fetchCircuit.recordFailure();
      throw err;
    })
    .finally(() => clearTimeout(timeoutId));
}

// ============================================================================
// Message Operations
// ============================================================================

type PendingFlagMap = Record<string, PendingFlagChange>;

// The main thread's live optimistic changes (postOptimisticOverlay). A task's
// own snapshot is taken when it starts; a change made while a long task runs
// only reaches its later pages through this.
let liveOverlay: { deleteIds: Set<string>; flags: PendingFlagMap } = {
  deleteIds: new Set(),
  flags: {},
};

async function writeMessages(
  account,
  folder,
  normalized,
  taskPendingDeleteIds: string[] = [],
  taskPendingFlags: PendingFlagMap | null = null,
) {
  const pendingDeleteIds = liveOverlay.deleteIds.size
    ? [...new Set([...taskPendingDeleteIds, ...liveOverlay.deleteIds])]
    : taskPendingDeleteIds;
  const pendingFlags: PendingFlagMap | null = Object.keys(liveOverlay.flags).length
    ? { ...(taskPendingFlags || {}), ...liveOverlay.flags }
    : taskPendingFlags;
  if (!dbPort) {
    console.warn('[sync.worker] No db connection for writeMessages');
    return { inserted: 0, updated: 0 };
  }

  // The worker outlives account switches and holds credentials for several
  // accounts at once, so "which account did this batch come from" is a live
  // question here, not a formality. Fail loudly rather than persisting a batch
  // whose records disagree with the partition they are headed for.
  assertAccountScoped('sync.worker.writeMessages', account, normalized);

  const keys = normalized.map((m) => [account, m.id]);
  const existingRecords = await db.messages.bulkGet(keys);
  const pendingSet = pendingDeleteIds.length ? new Set(pendingDeleteIds) : null;

  const toUpsert = [];
  const changedForIndex = [];
  let inserted = 0;
  let updated = 0;

  normalized.forEach((msg, idx) => {
    // Skip messages that were optimistically deleted/moved — prevents the
    // sync worker from re-inserting or updating records the user just removed.
    if (pendingSet?.has(msg.id)) return;

    const existing = existingRecords[idx];
    const pendingFlag = pendingFlags?.[msg.id] || null;
    if (!existing) {
      const fresh = applyPendingFlagChange(msg, pendingFlag);
      toUpsert.push(fresh);
      changedForIndex.push(fresh);
      inserted += 1;
      return;
    }

    const { record, changed } = mergeFlagsAndMetadata(existing, msg, pendingFlag);
    if (changed) {
      toUpsert.push(record);
      changedForIndex.push(record);
      updated += 1;
    }
  });

  if (toUpsert.length) {
    await db.messages.bulkPut(toUpsert);
  }

  if (changedForIndex.length) {
    postToSearch('index', {
      account,
      includeBody: false,
      messages: changedForIndex,
    });
  }

  return { inserted, updated };
}

// ============================================================================
// API Operations
// ============================================================================

// `account` is required, not optional: it selects the credentials this list is
// fetched with, so it must be the same account the caller will file the results
// under. Never default it to a "current" account.
async function fetchMessageList(account, params = {}) {
  const url = new URL(`${apiBase.replace(/\/$/, '')}/v1/messages`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: requireAuth(account),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText || 'Request failed');
  }
  if (res.status === 204) {
    return { __noContent: true };
  }
  return res.json();
}

async function runMetadataTask(task, postProgress) {
  const account = accountKey(task.account);
  const folder = task.folder;
  const limit = task.pageSize || DEFAULT_LIMIT;
  const maxMessages = task.maxMessages || Infinity;

  // Trim a phone's offline history here too, at the first sync of the folder:
  // backfills queue behind every folder's metadata pass and the launch bodies
  // pass, so trimming only there left the whole untrimmed folder for those to
  // read first.
  try {
    await trimFolderToMobileCap(account, folder);
  } catch (err) {
    console.warn('[sync.worker] trimming the offline history failed', err);
  }

  let manifest = await getManifest(account, folder);
  let lastUID = Number.isFinite(manifest?.lastUID) ? manifest.lastUID : 0;
  let lastModSeq = manifest?.lastModSeq || null;
  // Every page of this pass asks for the same window; lastModSeq moves as
  // pages arrive and is only saved for the next pass.
  const sinceModSeq = lastModSeq;
  let page = 1;
  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;

  while (true) {
    if (totalFetched >= maxMessages) break;

    // No after_uid: this pass also has to see flag changes on messages that
    // are already cached, not only messages newer than the last UID.
    const params = {
      folder,
      page,
      limit,
      since_modseq: sinceModSeq || undefined,
      include_body: 0,
      raw: false,
      attachments: false,
    };

    const res = await fetchMessageList(account, params);
    const rawList = parseResultList(res);
    if (!Array.isArray(rawList) || !rawList.length) break;

    const normalized = rawList
      .map((item) => normalizeMessageForCache(item, folder, account))
      .filter((item) => item?.id);

    if (!normalized.length) break;

    const writeResult = await writeMessages(
      account,
      folder,
      normalized,
      task.pendingDeleteIds || [],
      task.pendingFlagMutations || null,
    );

    totalFetched += normalized.length;
    totalInserted += writeResult.inserted;
    totalUpdated += writeResult.updated;

    normalized.forEach((item) => {
      // The id is a server ObjectId, not a UID: Math.max on it gave NaN.
      const uid = Number(item.uid);
      if (Number.isSafeInteger(uid) && uid > lastUID) lastUID = uid;
      if (item.modseq) {
        const modSeqNum = Number(item.modseq);
        if (Number.isFinite(modSeqNum)) {
          lastModSeq = Math.max(lastModSeq || 0, modSeqNum);
        } else {
          lastModSeq = item.modseq;
        }
      }
    });

    manifest = await updateManifest(account, folder, {
      lastUID,
      lastModSeq,
      pagesFetched: (manifest?.pagesFetched || 0) + 1,
      messagesFetched: (manifest?.messagesFetched || 0) + writeResult.inserted,
      lastSyncAt: Date.now(),
    });

    postProgress?.({
      type: 'progress',
      folder,
      stage: 'metadata',
      page,
      fetched: normalized.length,
      inserted: writeResult.inserted,
      updated: writeResult.updated,
      lastUID,
      lastModSeq,
      target: maxMessages,
    });

    if (writeResult.inserted === 0 && writeResult.updated === 0) {
      break;
    }

    if (totalFetched >= maxMessages) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
    page += 1;
  }

  // Opportunistic one-shot heal of rows previously stored with empty `from`.
  // Bounded per session per (account+folder) so we don't re-hit the server
  // on every sync tick. Failures are logged but never propagate.
  await runHealFromFieldPass(account, folder, 25).catch((err) => {
    console.warn('[sync.worker] heal-from pass failed:', err);
  });

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    lastUID,
    lastModSeq,
  };
}

// ============================================================================
// Backfill (background historical pagination)
// ============================================================================
//
// runMetadataTask is forward-only: once initial sync stops at the
// sync_max_headers cap, the oldest synced message becomes a floor. The list
// API pages by offset (page/limit, newest created first) and has no stable
// cursor: its `before` filter matches on any of three dates, so imported mail
// would repeat forever. runBackfillTask therefore walks pages in small
// batches, writes through writeMessages (which dedupes), and guards the offset
// paging instead:
//
// - Messages leaving the folder mid-walk shift later ones onto pages already
//   read. When the server total drops between pages the walk steps back far
//   enough to cover the shift, and the overlap is deduped.
// - An empty or short page only ends the walk when it agrees with the server
//   total (the API clamps `limit` to 100, so pages here never ask for more).
//   An empty page while the total says there is more is transient: the batch
//   stops without marking the folder complete and resumes at the same page.
// - A finished walk records the server total. When the total later grows, or
//   the last full walk is older than BACKFILL_SWEEP_INTERVAL_MS, a new walk
//   starts from page 1.
// - A walk from page 1 that reached the end collects every id the server
//   listed. Cached rows in the folder the listing did not include are then
//   checked one by one against the server and removed only on a 404 (see
//   pruneUnlisted). Nothing is pruned from a partial listing.

const BACKFILL_PAGES_PER_BATCH = 5;
const BACKFILL_EMPTY_STREAK_LIMIT = 3;
const BACKFILL_THROTTLE_MS = 800;
// The server's maximum page size for /v1/messages. Asking for more returns
// 100, which would make every page look short.
const BACKFILL_LIMIT = 100;
// How often a finished folder is walked again from page 1 to pick up anything
// a shifted page skipped and to find messages deleted on the server.
const BACKFILL_SWEEP_INTERVAL_MS = 12 * 60 * 60_000;
// A finished walk that saw fewer messages than the server reports is retried
// from page 1 this many times before it is accepted as done.
const BACKFILL_MAX_RESTARTS = 2;
// Unlisted rows checked against the server per batch.
const PRUNE_VERIFY_PER_BATCH = 25;
// Per-folder safety cap. Folders with truly enormous history won't backfill
// forever; users who want more can raise this via a settings extension later.
const BACKFILL_SAFETY_CAP = 20_000;
// On a phone or tablet (the init message says so) the history kept offline
// per folder is smaller: every cached message is also an entry in the search
// index and its writes, and on iOS all workers share the web content
// process's memory limit. Older mail still opens from the server on scroll.
const MOBILE_BACKFILL_SAFETY_CAP = 2_000;
let memoryConstrained = false;
const backfillSafetyCap = () =>
  memoryConstrained ? MOBILE_BACKFILL_SAFETY_CAP : BACKFILL_SAFETY_CAP;

interface BackfillWalk {
  // Every id the server listed during this walk, when it started at page 1.
  ids: Set<string>;
  startedAt: number;
  // Messages left the folder during the walk. Ids listed before that may
  // belong to them, so the listing cannot be trusted for pruning.
  shifted?: boolean;
}

// The cap only stops a backfill from fetching more. A phone that cached a
// longer history before the cap existed still holds it, and every one of
// those rows is also in the search index. Trim each folder once per worker
// to the newest MOBILE_BACKFILL_SAFETY_CAP: older mail is still on the server
// and opens from there on scroll. Keys only, oldest first, from the
// [account+folder+date] index ("date" stays plaintext under App Lock), so
// nothing is decrypted or cloned whole. Rows without a date are left alone.
const TRIM_DELETE_BATCH = 500;
const trimmedFolders = new Set<string>();
async function trimFolderToMobileCap(account: string, folder: string): Promise<number> {
  const key = toKey(account, folder);
  if (!memoryConstrained || trimmedFolders.has(key)) return 0;
  trimmedFolders.add(key);
  const count = (await dbSend('query', 'messages', {
    index: '[account+folder]',
    where: { op: 'equals', value: [account, folder] },
    queryMode: 'count',
  })) as number;
  const excess = (Number(count) || 0) - MOBILE_BACKFILL_SAFETY_CAP;
  if (excess <= 0) return 0;
  const oldestFirst = ((await dbSend('query', 'messages', {
    index: '[account+folder+date]',
    where: {
      op: 'between',
      lower: [account, folder, -Infinity],
      upper: [account, folder, [[]]],
      includeLower: true,
      includeUpper: true,
    },
    queryMode: 'primaryKeys',
  })) || []) as Array<[string, string]>;
  const doomed = oldestFirst.slice(0, Math.min(excess, oldestFirst.length));
  for (let i = 0; i < doomed.length; i += TRIM_DELETE_BATCH) {
    const keys = doomed.slice(i, i + TRIM_DELETE_BATCH);
    await db.messages.bulkDelete(keys);
    try {
      await db.messageBodies.bulkDelete(keys);
    } catch {
      // A body left behind is harmless; it is never shown without its row.
    }
    postToSearch('remove', { account, ids: keys.map((k) => k[1]) });
  }
  return doomed.length;
}

// Bodies a phone cached before it kept lean copies (see slimBodyMeta) can be
// tens of megabytes each, and every read of one opens and copies all of it.
// Drop those over the limit once per account; they download again, lean,
// when opened. Sizes come from the stored rows, so nothing is decrypted, and
// a few rows are read at a time.
const OVERSIZED_MOBILE_BODY_BYTES = 2_000_000;
const OVERSIZED_BODY_SCAN_PAGE = 10;
const oversizedBodiesPruned = new Set<string>();
async function pruneOversizedMobileBodies(account: string): Promise<number> {
  if (!memoryConstrained || oversizedBodiesPruned.has(account)) return 0;
  oversizedBodiesPruned.add(account);
  const flagKey = `migration:prune-oversized-mobile-bodies:${account}`;
  if (await dbSend('get', 'meta', { key: flagKey })) return 0;
  const doomed: Array<[string, string]> = [];
  for (let offset = 0; ; offset += OVERSIZED_BODY_SCAN_PAGE) {
    const page = ((await dbSend('query', 'messageBodies', {
      index: 'account',
      where: { op: 'equals', value: account },
      queryMode: 'summaries',
      fields: ['account', 'id'],
      options: { offset, limit: OVERSIZED_BODY_SCAN_PAGE },
    })) || []) as Array<{ account?: string; id?: string; approxBytes?: number }>;
    for (const row of page) {
      if (row?.id && Number(row.approxBytes) > OVERSIZED_MOBILE_BODY_BYTES) {
        doomed.push([row.account || account, row.id]);
      }
    }
    if (page.length < OVERSIZED_BODY_SCAN_PAGE) break;
  }
  if (doomed.length) await db.messageBodies.bulkDelete(doomed);
  await dbSend('put', 'meta', { record: { key: flagKey, updatedAt: Date.now() } });
  return doomed.length;
}

// In memory only. A walk resumed by a fresh worker has no listing and so
// never prunes; it still pages and verifies totals as usual.
const backfillWalks = new Map<string, BackfillWalk>();
// Unlisted ids waiting for their per-id check, keyed `${account}::${folder}`.
const pruneQueues = new Map<string, { ids: string[]; startedAt: number }>();

// The server's message count for a folder as of the last folder list. Pages
// also carry it in X-Item-Count when the browser exposes that header (see
// fetchListPage), which is fresher and preferred once seen.
async function readFolderTotal(account: string, folder: string): Promise<number | null> {
  if (!dbPort) return null;
  try {
    const row = (await db.folders.get([account, folder])) as Record<string, unknown> | undefined;
    const value = row?.total ?? row?.totalCount;
    const total = value === null || value === undefined || value === '' ? NaN : Number(value);
    return Number.isFinite(total) && total >= 0 ? total : null;
  } catch {
    return null;
  }
}

async function fetchListPage(
  account: string,
  params: Record<string, unknown>,
): Promise<{ list: unknown[]; total: number | null }> {
  const url = new URL(`${apiBase.replace(/\/$/, '')}/v1/messages`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: requireAuth(account),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText || 'Request failed');
  }
  const header = res.headers?.get?.('X-Item-Count');
  const headerTotal =
    header === null || header === undefined || header === '' ? NaN : Number(header);
  const total = Number.isFinite(headerTotal) && headerTotal >= 0 ? headerTotal : null;
  if (res.status === 204) return { list: [], total };
  const list = parseResultList(await res.json());
  return { list: Array.isArray(list) ? list : [], total };
}

async function runBackfillTask(task, postProgress) {
  const account = accountKey(task.account);
  const folder = task.folder;
  if (!account || !folder) return { done: true, reason: 'invalid_task' };

  // Without API config there's nothing to fetch. Bail as "done" rather than
  // letting the fetch throw on `new URL('')` below: the caller treats a
  // thrown/zero-progress batch as transient and re-queues, so an unconfigured
  // worker (e.g. a backfill that runs before the init message lands, common in
  // dev) would spin "Syncing <folder>" forever with no network activity.
  if (!apiBase || !authFor(account)) {
    return { done: true, reason: 'not_configured' };
  }

  const key = toKey(account, folder);
  const limit = BACKFILL_LIMIT;

  try {
    await trimFolderToMobileCap(account, folder);
  } catch (err) {
    // Trimming only saves memory; the backfill goes on without it.
    console.warn('[sync.worker] trimming the offline history failed', err);
  }

  // Finish checking unlisted rows from a completed walk before anything else.
  if (pruneQueues.get(key)?.ids.length) {
    const result = await pruneUnlisted(account, folder, task.pendingDeleteIds || []);
    return {
      done: !pruneQueues.get(key)?.ids.length,
      reason: 'pruning',
      inserted: 0,
      pruned: result.pruned,
      prunedIds: result.prunedIds,
      pagesProcessed: result.checked ? 1 : 0,
    };
  }

  let manifest = await getManifest(account, folder);
  let total = await readFolderTotal(account, folder);

  if (manifest.backfillComplete) {
    const grown =
      total !== null && Number.isFinite(manifest.backfillTotal) && total > manifest.backfillTotal;
    const sweepDue = Date.now() - (manifest.lastSweepAt || 0) >= BACKFILL_SWEEP_INTERVAL_MS;
    if (!grown && !sweepDue) return { done: true, reason: 'already_complete' };
    manifest = await updateManifest(account, folder, {
      backfillComplete: false,
      backfillPage: 1,
      backfillLimit: limit,
      backfillEmptyStreak: 0,
      backfillRestarts: 0,
      backfillPrevTotal: total,
    });
  }
  if ((manifest.backfillTotalInserted || 0) >= backfillSafetyCap()) {
    await updateManifest(account, folder, {
      backfillComplete: true,
      backfillTotal: total,
      lastSweepAt: Date.now(),
    });
    return { done: true, reason: 'safety_cap' };
  }

  // A first walk starts at page 1. Skipping the pages forward sync already
  // covered saved a few requests, but its running count also grows with every
  // new message, so the start drifted past older history, and only a walk
  // from page 1 yields the full listing that skip detection and pruning need.
  // A saved page from a different page size is converted by offset, rounding
  // down so nothing is skipped.
  let page;
  if (manifest.backfillPage == null) {
    page = 1;
  } else {
    const savedLimit = manifest.backfillLimit || task.pageSize || 50;
    page =
      savedLimit === limit
        ? manifest.backfillPage
        : Math.floor(((manifest.backfillPage - 1) * savedLimit) / limit) + 1;
  }

  // A walk from page 1 collects the listing used for pruning.
  let walk = backfillWalks.get(key) || null;
  if (page === 1) {
    walk = { ids: new Set(), startedAt: Date.now() };
    backfillWalks.set(key, walk);
  } else if (walk && manifest.backfillPage !== page) {
    // The saved position no longer lines up with the listing in memory.
    backfillWalks.delete(key);
    walk = null;
  }

  let prevTotal = Number.isFinite(manifest.backfillPrevTotal) ? manifest.backfillPrevTotal : total;
  // Messages left the folder (going by the last folder list) since the last
  // batch: later ones moved up onto pages already read, so start back far
  // enough to read them.
  if (total !== null && prevTotal !== null && total < prevTotal) {
    page = Math.max(1, page - Math.ceil((prevTotal - total) / limit));
    if (walk) walk.shifted = true;
  }
  if (total !== null) prevTotal = total;
  let emptyStreak = manifest.backfillEmptyStreak || 0;
  let totalInsertedThisRun = 0;
  let pagesThisRun = 0;
  let reachedEnd = false;
  let capped = false;
  let stalled = false;

  while (pagesThisRun < BACKFILL_PAGES_PER_BATCH) {
    let res;
    try {
      res = await fetchListPage(account, {
        folder,
        page,
        limit,
        include_body: 0,
        raw: false,
        attachments: false,
      });
    } catch (err) {
      // Network/auth hiccup: keep the position and let a later batch retry.
      console.warn('[sync.worker] backfill fetch failed:', err);
      break;
    }
    pagesThisRun += 1;
    // Messages left the folder since the last page: later ones moved up onto
    // pages already read. After this page the walk steps back over the shift
    // and reads it again; writeMessages dedupes the overlap.
    const droppedBy =
      res.total !== null && prevTotal !== null && res.total < prevTotal ? prevTotal - res.total : 0;
    if (res.total !== null) {
      total = res.total;
      prevTotal = res.total;
    }
    const stepBack = () => {
      page = Math.max(1, page - Math.ceil(droppedBy / limit));
      if (walk) walk.shifted = true;
    };

    const rawList = res.list;
    if (!rawList.length && droppedBy) {
      stepBack();
      continue;
    }
    if (!rawList.length) {
      const moreOnServer = total !== null && (page - 1) * limit < total;
      if (moreOnServer || (total === null && emptyStreak + 1 < BACKFILL_EMPTY_STREAK_LIMIT)) {
        // Either the server says there is more, or with no total to go on we
        // want a few empty answers in a row before believing it. Stop here
        // without marking anything complete; the next batch asks again.
        emptyStreak += 1;
        stalled = moreOnServer;
        break;
      }
      reachedEnd = true;
      break;
    }
    emptyStreak = 0;

    const normalized = rawList
      .map((item) => normalizeMessageForCache(item, folder, account))
      .filter((item) => item?.id);

    if (normalized.length) {
      const writeResult = await writeMessages(
        account,
        folder,
        normalized,
        task.pendingDeleteIds || [],
        task.pendingFlagMutations || null,
      );
      totalInsertedThisRun += writeResult.inserted;
      const listing = walk;
      if (listing) normalized.forEach((item) => listing.ids.add(String(item.id)));
    }

    if (droppedBy) {
      stepBack();
      await new Promise((resolve) => setTimeout(resolve, BACKFILL_THROTTLE_MS));
      continue;
    }
    page += 1;

    postProgress?.({
      type: 'progress',
      folder,
      stage: 'backfill',
      page,
      fetched: totalInsertedThisRun,
      inserted: totalInsertedThisRun,
    });

    // `limit` is within the server's clamp, so a short page is the last one.
    if (rawList.length < limit) {
      reachedEnd = true;
      break;
    }
    // Only a total that came with this page is fresh enough to end on. The
    // folder list's count can be behind new mail and would stop the walk
    // short of older history.
    if (res.total !== null && (page - 1) * limit >= res.total) {
      reachedEnd = true;
      break;
    }

    if (totalInsertedThisRun + (manifest.backfillTotalInserted || 0) >= backfillSafetyCap()) {
      reachedEnd = true;
      capped = true;
      break;
    }

    // Throttle so backfill stays well behind any foreground network
    // activity. Yield to the event loop between throttled waits so
    // higher-priority worker messages get processed promptly.
    await new Promise((resolve) => setTimeout(resolve, BACKFILL_THROTTLE_MS));
  }

  const nextManifest: Record<string, unknown> = {
    backfillPage: page,
    backfillLimit: limit,
    backfillEmptyStreak: emptyStreak,
    backfillPrevTotal: prevTotal,
    backfillTotalInserted: (manifest.backfillTotalInserted || 0) + totalInsertedThisRun,
    lastBackfillAt: Date.now(),
  };

  let complete = false;
  let restarted = false;
  if (reachedEnd) {
    // A walk stopped by the safety cap is not a full listing either way.
    const verdict = capped ? 'done' : await judgeFinishedWalk(account, folder, walk, total);
    if (verdict === 'restart' && (manifest.backfillRestarts || 0) < BACKFILL_MAX_RESTARTS) {
      // The listing may have missed messages that shifted, or hold ids that
      // left during the walk. Walk again from the top; the overlap dedupes.
      nextManifest.backfillPage = 1;
      nextManifest.backfillRestarts = (manifest.backfillRestarts || 0) + 1;
      nextManifest.backfillPrevTotal = total;
      backfillWalks.delete(key);
      restarted = true;
    } else {
      complete = true;
      Object.assign(nextManifest, {
        backfillComplete: true,
        backfillTotal: total,
        backfillRestarts: 0,
        lastSweepAt: Date.now(),
      });
      if (verdict === 'prune' && walk) {
        await queueUnlisted(account, folder, walk);
      }
      backfillWalks.delete(key);
    }
  }
  await updateManifest(account, folder, nextManifest);

  let pruned = 0;
  let prunedIds: string[] = [];
  if (complete && pruneQueues.get(key)?.ids.length) {
    const result = await pruneUnlisted(account, folder, task.pendingDeleteIds || []);
    pruned = result.pruned;
    prunedIds = result.prunedIds;
  }

  const pruneLeft = Boolean(pruneQueues.get(key)?.ids.length);
  // backfillBatchDone: a zero-page batch (first fetch threw before the network)
  // reports done so the controller stops re-queuing instead of spinning a tight,
  // no-progress loop; the next metadata sync resumes from the saved page. A
  // stalled batch (empty page the total disagrees with) also stops for now.
  return {
    done:
      !pruneLeft &&
      !restarted &&
      backfillBatchDone({ exhausted: complete || stalled, pagesProcessed: pagesThisRun }),
    inserted: totalInsertedThisRun,
    page,
    pagesProcessed: pagesThisRun,
    ...(pruned ? { pruned, prunedIds } : {}),
  };
}

/**
 * Decide what a walk that reached the end of the listing means:
 * 'prune' when it started at page 1 and listed at least the server's total,
 * 'restart' when messages left the folder during the walk (its listing may
 * hold ids that are gone, so a fresh one is needed before pruning) or the
 * cache holds fewer messages for the folder than the server reports (some
 * page was skipped), 'done' otherwise.
 */
async function judgeFinishedWalk(
  account: string,
  folder: string,
  walk: BackfillWalk | null,
  total: number | null,
): Promise<'prune' | 'restart' | 'done'> {
  if (walk?.shifted) return 'restart';
  if (total === null) return 'done';
  // A walk object only exists for a walk that began at page 1.
  if (walk && walk.ids.size >= total) return 'prune';
  let cached = 0;
  try {
    const rows = (await db.messages
      .where('[account+folder]')
      .equals([account, folder])
      .toArray()) as unknown[];
    cached = rows.length;
  } catch {
    return 'done';
  }
  return cached < total ? 'restart' : 'done';
}

// Cached rows of the folder the finished listing did not include. Rows written
// after the walk started (new mail, a local move) are left alone: the listing
// may simply predate them.
async function queueUnlisted(account: string, folder: string, walk: BackfillWalk) {
  let rows: Array<{ id?: string; updatedAt?: number }> = [];
  try {
    rows = (await db.messages
      .where('[account+folder]')
      .equals([account, folder])
      .toArray()) as Array<{
      id?: string;
      updatedAt?: number;
    }>;
  } catch {
    return;
  }
  const ids = rows
    .filter((row) => row?.id && !walk.ids.has(String(row.id)))
    .filter((row) => Number(row.updatedAt || 0) < walk.startedAt)
    .map((row) => String(row.id));
  if (ids.length) pruneQueues.set(toKey(account, folder), { ids, startedAt: walk.startedAt });
}

/**
 * Check queued unlisted rows against the server, a few per batch. A 404 means
 * the message is gone and its cached row, body and search entry are removed.
 * A message found elsewhere has its row moved to that folder. Anything else
 * (found in this folder, an error, a non-ObjectId id) keeps the row.
 */
async function pruneUnlisted(account: string, folder: string, pendingDeleteIds: string[]) {
  const key = toKey(account, folder);
  const queue = pruneQueues.get(key);
  if (!queue?.ids.length) return { pruned: 0, prunedIds: [], checked: 0 };
  const batch = queue.ids.splice(0, PRUNE_VERIFY_PER_BATCH);
  if (!queue.ids.length) pruneQueues.delete(key);
  const skip = new Set(pendingDeleteIds);
  const gone: string[] = [];
  let checked = 0;
  for (const id of batch) {
    if (skip.has(id)) continue;
    let res;
    try {
      const url = new URL(`${apiBase.replace(/\/$/, '')}/v1/messages/${encodeURIComponent(id)}`);
      url.searchParams.set('raw', 'false');
      url.searchParams.set('nodemailer', 'false');
      url.searchParams.set('attachments', 'false');
      res = await fetchWithTimeout(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: requireAuth(account) },
      });
    } catch (err) {
      console.warn('[sync.worker] prune check failed for', id, err);
      if (isPassWideFailure(err)) break;
      continue;
    }
    checked += 1;
    if (res.status === 404) {
      gone.push(id);
      continue;
    }
    if (!res.ok) continue;
    try {
      const detail = await res.json();
      const record = normalizeMessageForCache(detail?.Result || detail, folder, account);
      if (record?.id === id && record.folder && record.folder !== folder) {
        // Moved by another client: follow it rather than dropping it.
        await db.messages.update([account, id], {
          folder: record.folder,
          ...(record.folder_id ? { folder_id: record.folder_id } : {}),
          ...(record.uid ? { uid: record.uid } : {}),
        });
      }
    } catch {
      // Unreadable answer: keep the row.
    }
  }
  if (gone.length) {
    const keys = gone.map((id) => [account, id]);
    await db.messages.bulkDelete(keys);
    try {
      await db.messageBodies.bulkDelete(keys);
    } catch {
      // A body left behind is harmless; it is never shown without its row.
    }
    postToSearch('remove', { account, ids: gone });
  }
  return { pruned: gone.length, prunedIds: gone, checked };
}

// Keyed `${account}::${folder}` — prevents repeated heal scans within a
// single worker lifetime. Cleared automatically when the worker restarts.
const healedFromFieldFolders = new Set<string>();

async function runHealFromFieldPass(account, folder, limit = 25) {
  if (!dbPort || !account || !folder) return { healed: 0, scanned: 0 };
  const sessionKey = `${account}::${folder}`;
  if (healedFromFieldFolders.has(sessionKey)) return { healed: 0, scanned: 0 };
  healedFromFieldFolders.add(sessionKey);

  // Schema indexes `from`, so equals('') is an indexed scan. Filter to this
  // (account, folder) in memory — Dexie compound-index queries don't allow
  // mixing an equality on one indexed key with a different equality on
  // another. The empty-from set is small in practice.
  let empties = [];
  try {
    empties = await db.messages.where('from').equals('').toArray();
  } catch (err) {
    console.warn('[heal-from] query failed:', err);
    return { healed: 0, scanned: 0 };
  }
  const scoped = empties
    .filter((m) => m?.account === account && m?.folder === folder)
    .slice(0, Math.max(1, Math.min(limit, 100)));
  if (!scoped.length) return { healed: 0, scanned: 0 };

  let healed = 0;
  for (const msg of scoped) {
    try {
      const fixedFrom = await refetchAndExtractFrom(msg, account);
      if (fixedFrom && fixedFrom !== msg.from) {
        // Write only the sender. The row was read before a network round
        // trip, so writing all of it back would undo a flag, label or move
        // made in the meantime, or restore a row that was deleted.
        await db.messages.update([account, msg.id], { from: fixedFrom });
        healed += 1;
      }
    } catch (err) {
      console.warn('[heal-from] failed for', msg?.id, err);
    }
  }
  return { healed, scanned: scoped.length };
}

async function refetchAndExtractFrom(msg, account) {
  if (!msg?.id) return '';
  const url = new URL(`${apiBase.replace(/\/$/, '')}/v1/messages/${encodeURIComponent(msg.id)}`);
  if (msg.folder) url.searchParams.set('folder', msg.folder);
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: requireAuth(account),
    },
  });
  if (!res.ok) return '';
  const detail = await res.json();
  if (!detail || typeof detail !== 'object') return '';
  const candidate = extractFromField(detail);
  return hasFromValue(candidate) ? candidate : '';
}

async function runBodiesTask(task, postProgress) {
  const account = accountKey(task.account);
  const folder = task.folder;
  const limit = task.limit || DEFAULT_BODY_LIMIT;
  const maxMessages = task.maxMessages || limit;

  if (!dbPort) {
    console.warn('[sync.worker] No db connection for runBodiesTask');
    return;
  }

  try {
    await pruneOversizedMobileBodies(account);
  } catch (err) {
    console.warn('[sync.worker] dropping oversized cached bodies failed', err);
  }

  // ID-targeted prefetch (adjacent / viewport / hover): warm exactly the
  // messages the user is likely to open next, rather than the folder-wide
  // newest-N pass. This writes only to db.messageBodies and never touches the
  // main-thread render path, so it cannot desync the reader's header/body or
  // disturb the cache-hit debounce — the foreground load just finds a warm
  // cache entry later.
  const idTargeted = Array.isArray(task.messageIds) && task.messageIds.length > 0;

  // The db proxy resolves to `unknown`; cast to the minimal shapes used here so
  // the worklist stays type-clean without leaning on `any`.
  type BodyHeaderRecord = { id: string; date?: number; dateMs?: number; has_attachment?: boolean };
  // Leave out messages whose last fetch failed and are still backing off, and
  // PGP messages cached still encrypted that the keys we have cannot open
  // (none unlocked, or these keys were already tried on them). A locked body
  // the current keys have not tried is decrypted from the cached copy, with
  // no second download.
  const wanted = (headers: BodyHeaderRecord[], statuses: Array<CachedBodyStatus | null>) => {
    const now = Date.now();
    const keptHeaders: BodyHeaderRecord[] = [];
    const keptStatuses: Array<CachedBodyStatus | null> = [];
    headers.forEach((header, idx) => {
      if (isPgpLockedStatus(statuses[idx]) && !canTryLockedBody(account, header.id)) return;
      if (bodyRetryBlocked(account, header.id, now)) return;
      keptHeaders.push(header);
      keptStatuses.push(statuses[idx]);
    });
    return { headers: keptHeaders, statuses: keptStatuses };
  };
  // Which bodies are cached, worked out in the db worker without copying the
  // bodies here (see bodyStatuses in db-engine.ts)
  const statusesOf = async (headers: BodyHeaderRecord[]) =>
    ((await dbSend('bodyStatuses', 'messageBodies', {
      keys: headers.map((m) => [account, m.id]),
    })) || []) as Array<CachedBodyStatus | null>;

  let worklist;
  if (idTargeted) {
    const ids = task.messageIds.slice(0, limit) as string[];
    const records = (await db.messages.bulkGet(
      ids.map((id) => [account, id]),
    )) as BodyHeaderRecord[];
    const headers = records.filter(Boolean);
    if (!headers.length) return;
    const kept = wanted(headers, await statusesOf(headers));
    worklist = worklistFromHeaders(kept.headers, kept.statuses, kept.headers.length);
  } else {
    // Only the newest rows the pass can use, from the date index ("date" is
    // stored in the clear under App Lock). Reading the whole folder decrypted
    // and copied every cached row of it to sort them here.
    const sampleSize = Math.min(maxMessages || Number.MAX_SAFE_INTEGER, limit * 2);
    const headers = ((await dbSend('query', 'messages', {
      index: '[account+folder+date]',
      where: {
        op: 'between',
        lower: [account, folder, -Infinity],
        upper: [account, folder, [[]]],
        includeLower: true,
        includeUpper: true,
      },
      queryMode: 'toArray',
      options: { reverse: true, limit: sampleSize },
    })) || []) as BodyHeaderRecord[];
    const kept = wanted(headers, await statusesOf(headers));
    worklist = worklistFromHeaders(kept.headers, kept.statuses, maxMessages).slice(0, limit);
  }

  if (!worklist.length) {
    // Only the folder-wide pass owns the "bodies done" manifest flag.
    if (!idTargeted) {
      await updateManifest(account, folder, { hasBodiesPass: true, lastSyncAt: Date.now() });
    }
    return;
  }

  let completed = 0;
  let failed = 0;
  for (const msg of worklist) {
    // All prefetched ids come from the current folder list, so the task folder
    // is the right one to cache under (and keeps types clean — HeaderLike has
    // no `folder`).
    try {
      await fetchAndCacheBody(account, folder, msg, { returnPayload: false });
      clearBodyFailure(account, msg.id);
    } catch (err) {
      // One message that will not download (deleted on the server, a parse
      // error, a timeout) must not stop the rest of the pass. It backs off
      // and is tried again on a later pass. A pass-wide problem (the backend
      // is backing off, or this account was signed out) ends the pass.
      if (isPassWideFailure(err)) throw err;
      noteBodyFailure(account, msg.id);
      failed += 1;
      console.warn('[sync.worker] body fetch failed for', msg.id, err);
    }
    completed += 1;
    // Prefetch is silent: a handful of look-ahead bodies must not drive the
    // "Downloading bodies X/Y" sync status UI.
    if (!idTargeted) {
      postProgress?.({
        type: 'progress',
        stage: 'bodies',
        folder,
        completed,
        total: worklist.length,
        target: maxMessages,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (!idTargeted) {
    await updateManifest(account, folder, {
      hasBodiesPass: completed >= worklist.length && failed === 0,
      lastSyncAt: Date.now(),
    });
  }
}

// Per-message memo of failed body downloads, so a message that keeps failing
// is retried with growing gaps instead of on every pass. In memory only: a
// fresh worker gives everything another try.
const BODY_RETRY_BASE_MS = 60_000;
const BODY_RETRY_MAX_MS = 6 * 60 * 60_000;
const bodyFailures = new Map<string, { count: number; retryAt: number }>();

function noteBodyFailure(account: string, id: string, now = Date.now()) {
  const key = `${account}::${id}`;
  const count = (bodyFailures.get(key)?.count || 0) + 1;
  const delay = Math.min(BODY_RETRY_BASE_MS * 2 ** (count - 1), BODY_RETRY_MAX_MS);
  bodyFailures.set(key, { count, retryAt: now + delay });
}

function clearBodyFailure(account: string, id: string) {
  bodyFailures.delete(`${account}::${id}`);
}

function bodyRetryBlocked(account: string, id: string, now = Date.now()) {
  const entry = bodyFailures.get(`${account}::${id}`);
  return Boolean(entry && entry.retryAt > now);
}

function isPassWideFailure(err: unknown): boolean {
  const e = err as { circuitOpen?: boolean; message?: string } | null;
  if (e?.circuitOpen) return true;
  return /No credentials for account|Database worker not connected/.test(String(e?.message || ''));
}

// A body record written for a PGP message the worker could not decrypt: the
// ciphertext is cached in `raw` and there is no readable body yet.
function isPgpLockedBody(
  record: { body?: string | null; raw?: string | null; pgpLocked?: boolean } | null | undefined,
) {
  if (!record || record.body) return false;
  return Boolean(record.pgpLocked) && typeof record.raw === 'string' && isPgpContent(record.raw);
}

async function fetchAndCacheBody(account, folder, msg, options = {}) {
  return fetchAndCacheBodyWithOptions(account, folder, msg, options);
}

async function extractNestedAttachments(att) {
  try {
    if (!att.content || (!att.content.byteLength && typeof att.content !== 'string')) return [];
    const nestedParser = new PostalMime();
    const raw =
      typeof att.content === 'string' ? att.content : new TextDecoder().decode(att.content);
    const nested = await nestedParser.parse(raw);
    const results = [];
    for (const child of nested.attachments || []) {
      if ((child.mimeType || '').toLowerCase() === 'message/rfc822' && child.content) {
        // Recurse into nested message/rfc822
        const deeper = await extractNestedAttachments(child);
        results.push(...deeper);
        const childSubject = '(attached email)';
        const childName = child.filename || `${childSubject}.eml`;
        results.push({
          name: childName,
          filename: childName,
          size: child.size || child.content?.length || 0,
          contentId: child.contentId || undefined,
          disposition: 'attachment',
          href: bufferToDataUrl({
            content: child.content,
            contentType: 'message/rfc822',
          }),
          contentType: 'message/rfc822',
        });
      } else {
        results.push({
          name: child.filename || 'attachment',
          filename: child.filename || 'attachment',
          size: child.size || child.content?.length || 0,
          contentId: child.contentId || undefined,
          disposition: (child.disposition || '').toLowerCase(),
          href: bufferToDataUrl({
            content: child.content,
            contentType: child.mimeType || child.contentType || 'application/octet-stream',
          }),
          contentType: child.mimeType || child.contentType || 'application/octet-stream',
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function parseRawMessage(raw, existingAttachments = []) {
  if (!raw) return null;
  try {
    const parser = new PostalMime();
    const email = await parser.parse(raw);

    // Convert postal-mime attachments to data URLs
    // First pass: collect all parent-level attachments (these take dedup priority).
    // For message/rfc822 parts, add the .eml itself now but defer nested extraction.
    const parentAttachments = [];
    const rfc822Parts = [];
    for (const att of email.attachments || []) {
      if ((att.mimeType || '').toLowerCase() === 'message/rfc822' && att.content) {
        rfc822Parts.push(att);
        const emlName = att.filename || 'attached-email.eml';
        parentAttachments.push({
          name: emlName,
          filename: emlName,
          size: att.size || att.content?.length || 0,
          contentId: att.contentId || undefined,
          disposition: 'attachment',
          href: bufferToDataUrl({
            content: att.content,
            contentType: 'message/rfc822',
          }),
          contentType: 'message/rfc822',
        });
      } else {
        parentAttachments.push({
          name: att.filename || 'attachment',
          filename: att.filename || 'attachment',
          size: att.size || att.content?.length || 0,
          contentId: att.contentId || undefined,
          disposition: (att.disposition || '').toLowerCase(),
          href: bufferToDataUrl({
            content: att.content,
            contentType: att.mimeType || att.contentType || 'application/octet-stream',
          }),
          contentType: att.mimeType || att.contentType || 'application/octet-stream',
        });
      }
    }

    // Second pass: extract nested attachments from rfc822 parts.
    // Added after parent attachments so dedup prefers the parent versions.
    const nestedAttachments = [];
    for (const rfc of rfc822Parts) {
      const nested = await extractNestedAttachments(rfc);
      nestedAttachments.push(...nested);
    }
    const attachments = [...parentAttachments, ...nestedAttachments];

    // Merge with existing attachments and filter out PGP-related files
    // PostalMime attachments come first so they win deduplication (they have data URL hrefs)
    const merged = [...attachments, ...existingAttachments].filter((att) => {
      const filename = (att.filename || att.name || '').toLowerCase();
      const contentType = (att.contentType || '').toLowerCase();

      // Filter out PGP-related attachments
      if (/\.asc$/i.test(filename)) return false;
      if (/^application\/pgp/i.test(contentType)) return false;
      if (filename === 'encrypted.asc' || filename === 'msg.asc') return false;
      if (/version\.txt/i.test(filename)) return false;
      if (/(pgp|gpg)/i.test(filename)) return false;

      return true;
    });

    // Deduplicate by CID or filename+size
    const seen = new Set();
    const deduped = merged.filter((att) => {
      const cid = (att.contentId || '').replace(/^<|>$/g, '');
      const key = cid ? `cid:${cid}` : `file:${att.filename || att.name || ''}:${att.size || 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Use HTML if available, otherwise wrap text in <pre>
    // Never fall back to raw MIME source — it contains headers that should not be displayed
    const body =
      email.html || (email.text ? `<pre style="white-space:pre-wrap">${email.text}</pre>` : '');

    // Apply inline attachments (cid: → data:)
    const inlined = applyInlineAttachments(body, deduped);

    return {
      body: inlined, // Has data URLs embedded - safe to cache!
      rawBody: body,
      attachments: deduped,
      textContent: email.text || extractTextContent(body),
      // Inner MIME headers. For PGP with protected headers (RFC 3156 +
      // draft-autocrypt "memory hole"), the REAL Subject lives here while the
      // outer/cached subject is a placeholder like "...", and the decrypt path
      // uses this to correct the displayed subject.
      subject: typeof email.subject === 'string' ? email.subject : undefined,
    };
  } catch (error) {
    console.warn('[sync.worker] postal-mime parse failed', error);
    return null;
  }
}

async function fetchAndCacheBodyWithOptions(account, folder, msg, options = {}) {
  const { returnPayload = false } = options;
  const apiId = msg?.id || msg?.uid;
  if (!apiId) return;

  const requestKey = `${account}::${apiId}`;
  // Someone is waiting on this body (the reader). Caching it is not their
  // concern: when the database is slow (another tab, a large clean-up), waiting
  // for the write kept the reader on a skeleton until it gave up. Background
  // passes still wait, so they do not run ahead of the database.
  const cacheWrite = async (write, label) => {
    const done = Promise.resolve()
      .then(write)
      .catch((err) => console.warn(`[sync.worker] ${label} failed`, err));
    if (!returnPayload) await done;
  };
  // Set when this worker decrypted the body, so the reader can show the PGP
  // badge and a protected-headers subject straight away.
  let pgpInfo: { encrypted: true; subject?: string } | null = null;
  // pgpKeysVersion when it was decrypted. Keys removed since then took their
  // plaintext with them (invalidatePgpCachedBodies); it is not cached again.
  let decryptedWithKeys = -1;
  const keysChangedSinceDecrypt = () => Boolean(pgpInfo) && decryptedWithKeys !== pgpKeysVersion;
  const persistBody = async (body, textContent, attachments = [], meta = null) => {
    // A phone keeps a lean copy: no raw message, no large attachment content
    // (see slimBodyMeta). The reader gets the same lean copy it would read
    // back from the cache.
    const keptMeta = memoryConstrained ? slimBodyMeta(meta) : meta;
    // Attachments decrypted here are kept whole: the server only has them
    // encrypted, so there is nothing to download them from later.
    const keptAttachments =
      memoryConstrained && !pgpInfo ? slimCachedAttachments(attachments) : attachments;
    if (dbPort && !keysChangedSinceDecrypt()) {
      await cacheWrite(
        () =>
          db.messageBodies.put({
            id: apiId,
            account,
            folder,
            body,
            textContent,
            attachments: keptAttachments,
            meta: keptMeta,
            // The attachment list is worked out: an empty one means there
            // were none to list, not that they still have to be downloaded.
            attachmentsResolved: true,
            updatedAt: Date.now(),
            // Decrypted here with a saved key: removing the keys removes this
            // plaintext copy too (invalidatePgpCachedBodies)
            ...(pgpInfo ? { pgpDecrypted: true } : {}),
          }),
        'caching message body',
      );
    }

    postToSearch('index', {
      account,
      includeBody: true,
      messages: [
        {
          id: apiId,
          folder,
          from: msg.from,
          to: msg.to,
          cc: msg.cc,
          subject: msg.subject,
          snippet: msg.snippet,
          date: msg.date || msg.dateMs,
          labels: msg.labels || msg.labelIds || msg.label_ids || [],
          body,
          textContent,
        },
      ],
    });

    return {
      id: apiId,
      folder,
      body,
      textContent,
      attachments: keptAttachments,
      meta: keptMeta,
      ...(pgpInfo ? { pgp: pgpInfo } : {}),
    };
  };
  // A PGP body cached still encrypted that the current keys may open.
  let lockedCopy = null;
  if (dbPort && !(returnPayload && dbStalled)) {
    try {
      // The reader would rather download again than wait on a busy database.
      const lookup = db.messageBodies.get([account, apiId]);
      const cached = returnPayload
        ? await Promise.race([
            lookup,
            new Promise((resolve) => setTimeout(() => resolve(undefined), CACHE_LOOKUP_WAIT_MS)),
          ])
        : await lookup;
      // Detect stale cache: raw PGP/MIME was incorrectly stored as body
      const isStalePgpBody =
        cached?.body && typeof cached.body === 'string' && isPgpContent(cached.body);
      // Already downloaded and still not decryptable here: hand back the cached
      // ciphertext instead of downloading it again. With keys unlocked since,
      // decrypt that copy below.
      if (isPgpLockedBody(cached) && canTryLockedBody(account, String(apiId))) {
        lockedCopy = cached;
      } else if (isPgpLockedBody(cached)) {
        if (returnPayload) {
          return {
            id: apiId,
            folder: cached.folder || folder,
            pgpLocked: true,
            raw: cached.raw,
            // The reader reads the ciphertext from meta.raw, as on a download.
            meta: {
              ...((cached as { meta?: Record<string, unknown> }).meta || {}),
              raw: cached.raw,
            },
          };
        }
        return;
      }
      if (cached?.body && !isStalePgpBody) {
        if (returnPayload) {
          return {
            id: apiId,
            folder: cached.folder || folder,
            body: cached.body,
            textContent: cached.textContent || '',
            attachments: cached.attachments || [],
            meta: (cached as { meta?: Record<string, unknown> }).meta || null,
            ...((cached as { pgpDecrypted?: boolean }).pgpDecrypted ? { pgpDecrypted: true } : {}),
          };
        }
        return;
      }
    } catch {
      // ignore cache lookup errors
    }
  }

  if (inFlightBodyRequests.has(requestKey)) {
    const pending = await inFlightBodyRequests.get(requestKey);
    if (returnPayload) return pending;
    return;
  }

  const downloadDetail = async () => {
    const url = new URL(
      `${apiBase.replace(/\/$/, '')}/v1/messages/${encodeURIComponent(apiId)}?folder=${encodeURIComponent(folder || '')}&raw=true`,
    );

    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: requireAuth(account),
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText || 'Request failed');
    }
    const json = await res.json();
    return json?.Result || json;
  };

  const requestPromise = (async () => {
    // A locked PGP copy is decrypted where it is: the ciphertext is the same.
    const result = lockedCopy
      ? {
          ...((lockedCopy as { meta?: Record<string, unknown> }).meta || {}),
          raw: lockedCopy.raw,
        }
      : await downloadDetail();
    const raw = result?.raw;
    let body = '';
    let textContent = '';
    let attachments = [];

    if (raw) {
      const isPgp = isPgpContent(raw);
      if (isPgp) {
        decryptedWithKeys = pgpKeysVersion;
        const decrypted = await decryptPgp(raw);
        if (!decrypted) {
          pgpLockedTried.set(`${account}::${apiId}`, pgpKeysVersion);
          // Keep the ciphertext so later passes do not download it again. The
          // reader decrypts from `raw` (handleCachedPgpRaw), and changing PGP
          // keys clears these records (invalidatePgpCachedBodies).
          if (dbPort) {
            await cacheWrite(
              () =>
                db.messageBodies.put({
                  id: apiId,
                  account,
                  folder,
                  body: '',
                  textContent: '',
                  attachments: [],
                  raw,
                  // The ciphertext is already in `raw`; do not store it twice.
                  meta: { ...result, raw: undefined },
                  pgpLocked: true,
                  updatedAt: Date.now(),
                }),
              'caching locked PGP body',
            );
          }
          // Return raw data so main thread can attempt PGP decryption without re-fetching
          return { id: apiId, folder, pgpLocked: true, raw, meta: result };
        }
        const parsed = await parseRawMessage(decrypted);
        if (parsed) {
          body = parsed.body;
          textContent = parsed.textContent;
          attachments = parsed.attachments;
          // Record the badge flags and, for protected-headers senders, the
          // real subject (the cached outer subject is a placeholder).
          try {
            const changes: Record<string, unknown> = {
              pgpEncrypted: true,
              pgpSigned: lastDecryptSigned,
              pgpSignature: lastDecryptSignature,
            };
            pgpInfo = { encrypted: true };
            if (typeof parsed.subject === 'string' && parsed.subject.trim()) {
              pgpInfo.subject = parsed.subject;
              if (parsed.subject !== msg?.subject) {
                changes.subject = parsed.subject;
                // The server's subject (a placeholder), put back when the
                // keys are removed (forgetPgpPlaintext)
                if (typeof msg?.subject === 'string') changes.pgpOuterSubject = msg.subject;
              }
            }
            // Only these fields are written; the rest of the row is left as
            // it is in the database now.
            if (!keysChangedSinceDecrypt()) {
              await cacheWrite(
                () => db.messages.update([account, apiId], changes),
                'recording PGP badge',
              );
            }
          } catch {
            // Best effort; the interactive decrypt path persists the same info.
          }
        }
      } else {
        const parsed = await parseRawMessage(raw);
        if (parsed) {
          body = parsed.body;
          textContent = parsed.textContent;
          attachments = parsed.attachments;
        }
      }
    } else {
      const serverText =
        result?.Plain ||
        result?.text ||
        result?.body ||
        result?.preview ||
        result?.nodemailer?.text ||
        result?.nodemailer?.preview;
      const html =
        result?.html ||
        result?.Html ||
        result?.textAsHtml ||
        result?.nodemailer?.html ||
        result?.nodemailer?.textAsHtml ||
        serverText ||
        msg.snippet ||
        '';

      const detailAttachments = result?.nodemailer?.attachments || result?.attachments || [];
      attachments = (detailAttachments || []).map((att) => {
        const contentId = att.cid || att.contentId;
        const disposition = (att.disposition || att.contentDisposition || '')
          .toString()
          .toLowerCase();
        const isInline = disposition === 'inline' || !!contentId;
        const hasUrl = !!att.url;

        let href;
        if (hasUrl) {
          href = att.url;
        } else if (isInline && att.content) {
          href = bufferToDataUrl(att);
        }

        return {
          name: att.name || att.filename,
          filename: att.filename || att.name,
          size: att.size || att.content?.byteLength || att.content?.length || 0,
          contentId,
          disposition,
          href,
          contentType: att.contentType || att.mimeType || att.type,
          needsDownload: !href && !hasUrl,
        };
      });
      const inlined = applyInlineAttachments(html, attachments);
      body = inlined;
      textContent = serverText || extractTextContent(inlined);
    }

    return await persistBody(body, textContent, attachments, result);
  })();

  inFlightBodyRequests.set(requestKey, requestPromise);
  try {
    const result = await requestPromise;
    if (returnPayload) return result;
  } finally {
    inFlightBodyRequests.delete(requestKey);
  }
}

/**
 * Extract PGP armor block from raw content (handles PGP/MIME).
 */
function extractPgpArmor(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const beginIdx = raw.indexOf('-----BEGIN PGP MESSAGE-----');
  const endIdx = raw.indexOf('-----END PGP MESSAGE-----');
  if (beginIdx >= 0 && endIdx > beginIdx) {
    return raw.substring(beginIdx, endIdx + '-----END PGP MESSAGE-----'.length);
  }
  return raw;
}

let lastDecryptError = '';
let lastDecryptSigned = false;
// What checking the signatures found, for the last decrypt
let lastDecryptSignature: PgpSignatureCheck | null = null;

/**
 * The outcome of checking a decrypted message's signatures.
 * - verified: a signature checks out against a key the user holds (a pinned
 *   contact key or their own). `signers` are that key's addresses; whether one
 *   is the From address is for the reader to compare.
 * - invalid: a signature from a key the user holds does not match the
 *   content. Either the message changed after signing or it was forged.
 * - unverified: signed, but by no key the user holds, so nothing can be said.
 * - revoked: the signing key is held, but its owner has revoked it. The
 *   signature may be intact; the key can no longer vouch for anything.
 */
interface PgpSignatureCheck {
  status: 'verified' | 'invalid' | 'unverified' | 'revoked';
  signers: string[];
}

async function checkSignatures(signatures, keys): Promise<PgpSignatureCheck | null> {
  if (!Array.isArray(signatures) || !signatures.length) return null;
  let sawUnknown = false;
  for (const sig of signatures) {
    const signer = (keys || []).find((key) => key.getKeyIDs().some((id) => id.equals(sig.keyID)));
    if (!signer) {
      sawUnknown = true;
      continue;
    }
    try {
      await sig.verified;
    } catch (err) {
      // openpgp rejects a signature from a revoked key the same way as one
      // that does not match. Telling them apart matters: one is a key the
      // owner retired, the other a message changed after signing.
      const revoked = /revoked/i.test(String((err as Error)?.message || err));
      return { status: revoked ? 'revoked' : 'invalid', signers: keyAddresses(signer) };
    }
    return { status: 'verified', signers: keyAddresses(signer) };
  }
  return sawUnknown ? { status: 'unverified', signers: [] } : null;
}

function keyAddresses(key): string[] {
  try {
    return key.users
      .map((user) => user.userID?.email)
      .filter((email) => typeof email === 'string' && email)
      .map((email) => email.toLowerCase());
  } catch {
    return [];
  }
}

async function decryptPgp(armored) {
  lastDecryptError = '';
  lastDecryptSigned = false;
  lastDecryptSignature = null;
  await pgpKeysReady.catch(() => {});
  if (!armored || !unlockedPgpKeys.length) return '';

  const hasInlineArmor = armored.includes('-----BEGIN PGP MESSAGE-----');
  const hasMimeHeaders = armored.includes('multipart/encrypted');

  try {
    // Extract just the PGP armor if embedded in MIME content
    let pgpBlock = extractPgpArmor(armored);

    // For PGP/MIME: if no inline armor found, extract the encrypted part from MIME structure
    if (!pgpBlock.includes('-----BEGIN PGP MESSAGE-----') && isPgpContent(armored)) {
      // Strategy 1: Manual boundary parsing (most reliable for PGP/MIME)
      const boundaryMatch = armored.match(/boundary="?([^";\s]+)"?/i);
      if (boundaryMatch) {
        const boundary = boundaryMatch[1];
        const parts = armored.split('--' + boundary);
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (part.includes('application/octet-stream') || part.includes('application/pgp-keys')) {
            const headerEnd =
              part.indexOf('\r\n\r\n') !== -1
                ? part.indexOf('\r\n\r\n') + 4
                : part.indexOf('\n\n') !== -1
                  ? part.indexOf('\n\n') + 2
                  : -1;
            if (headerEnd > 0) {
              const body = part.substring(headerEnd).trim();
              const extracted = extractPgpArmor(body);
              if (extracted.includes('-----BEGIN PGP MESSAGE-----')) {
                pgpBlock = extracted;
                break;
              }
            }
          }
        }
      }

      // Strategy 2: PostalMime fallback
      if (!pgpBlock.includes('-----BEGIN PGP MESSAGE-----')) {
        try {
          const parser = new PostalMime();
          const parsed = await parser.parse(armored);
          const pgpPart = parsed.attachments?.find(
            (a) => a.mimeType === 'application/octet-stream' && a.content,
          );
          if (pgpPart?.content) {
            const decoded =
              typeof pgpPart.content === 'string'
                ? pgpPart.content
                : new TextDecoder().decode(pgpPart.content);
            const extracted = extractPgpArmor(decoded);
            if (extracted.includes('-----BEGIN PGP MESSAGE-----')) {
              pgpBlock = extracted;
            }
          }
        } catch {
          // PostalMime fallback failed, continue
        }
      }
    }

    if (!pgpBlock.includes('-----BEGIN PGP MESSAGE-----')) {
      if (hasMimeHeaders) {
        console.warn(
          '[sync.worker] PGP/MIME extraction failed. Raw length:',
          armored?.length,
          'Has BEGIN:',
          hasInlineArmor,
          'First 500 chars:',
          armored?.substring(0, 500),
        );
        lastDecryptError =
          'PGP/MIME message has empty encrypted payload. The API response may be incomplete.';
      } else {
        lastDecryptError = 'No PGP armor block found in message content.';
      }
      return '';
    }

    const message = await openpgp.readMessage({ armoredMessage: pgpBlock });

    const keys = signatureVerificationKeys();
    const { data, signatures } = await openpgp.decrypt({
      message,
      decryptionKeys: unlockedPgpKeys,
      verificationKeys: keys,
    });
    lastDecryptSigned = Array.isArray(signatures) && signatures.length > 0;
    lastDecryptSignature = await checkSignatures(signatures, keys);
    return data || '';
  } catch (err) {
    lastDecryptError = err?.message || String(err);
    console.warn('[sync.worker] PGP decryption failed:', lastDecryptError);
    return '';
  }
}

// ============================================================================
// PGP Decryption Task Handler
// ============================================================================

/**
 * Handle on-demand message decryption from main thread
 * This allows the main thread to request decryption without importing openpgp
 */
async function handleDecryptMessageTask(task) {
  const { raw } = task;

  if (!raw || typeof raw !== 'string') {
    return {
      success: false,
      reason: 'invalid_input',
      message: 'No raw message provided',
      keyCount: unlockedPgpKeys.length,
    };
  }

  if (!isPgpContent(raw)) {
    return {
      success: false,
      reason: 'not_pgp',
      message: 'Message is not PGP encrypted',
      keyCount: unlockedPgpKeys.length,
    };
  }

  if (!unlockedPgpKeys.length) {
    return {
      success: false,
      reason: 'no_keys',
      message: 'No unlocked PGP keys available. Add or unlock a key in Settings.',
      keyCount: 0,
    };
  }

  // Attempt decryption with all unlocked keys (openpgp.js tries each automatically)
  const decrypted = await decryptPgp(raw);
  if (!decrypted) {
    const detail = lastDecryptError ? ` (${lastDecryptError})` : '';
    return {
      success: false,
      reason: 'decrypt_failed',
      message: `None of your ${unlockedPgpKeys.length} unlocked key(s) could decrypt this message.${detail}`,
      keyCount: unlockedPgpKeys.length,
    };
  }

  // Parse the decrypted content
  let parsed = null;
  try {
    parsed = await parseRawMessage(decrypted);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    // Parsing failed (parseRawMessage also returns null on internal errors),
    // so return the raw decrypted content rather than dying on parsed.body.
    return {
      success: true,
      body: decrypted,
      textContent: extractTextContent(decrypted),
      attachments: [],
      rawDecrypted: true,
      signed: lastDecryptSigned,
      signature: lastDecryptSignature,
      keyCount: unlockedPgpKeys.length,
    };
  }

  return {
    success: true,
    body: parsed.body,
    textContent: parsed.textContent,
    attachments: parsed.attachments,
    // Protected-headers subject from the decrypted inner MIME (undefined
    // when the sender didn't encrypt the subject).
    subject: parsed.subject,
    signed: lastDecryptSigned,
    signature: lastDecryptSignature,
    keyCount: unlockedPgpKeys.length,
  };
}

/**
 * Handle MIME parsing request from main thread (Phase 3 optimization)
 * This allows main thread to delegate all MIME parsing to worker
 */
/**
 * Encrypt an outbound message to a set of recipient public keys.
 *
 * Runs here rather than on the main thread for the same reason decryption
 * does: openpgp is large and the key material already lives in this worker.
 * Signing is opportunistic — if a private key is unlocked the message is
 * signed too, but a locked key must never block sending an encrypted message.
 */
async function handleEncryptMessageTask(task) {
  const { plaintext, recipientKeys = [], sign = true } = task;

  if (!plaintext || typeof plaintext !== 'string') {
    return { success: false, reason: 'invalid_input', message: 'Nothing to encrypt' };
  }
  if (!Array.isArray(recipientKeys) || !recipientKeys.length) {
    return { success: false, reason: 'no_recipient_keys', message: 'No recipient keys provided' };
  }

  let publicKeys;
  try {
    publicKeys = await Promise.all(
      recipientKeys.map((armored) => openpgp.readKey({ armoredKey: armored })),
    );
  } catch (err) {
    return {
      success: false,
      reason: 'bad_recipient_key',
      message: `A recipient public key could not be read: ${err?.message || err}`,
    };
  }

  try {
    const message = await openpgp.createMessage({ text: plaintext });
    const armored = await openpgp.encrypt({
      message,
      encryptionKeys: publicKeys,
      ...(sign && unlockedPgpKeys.length ? { signingKeys: unlockedPgpKeys } : {}),
      format: 'armored',
    });
    return {
      success: true,
      armored,
      signed: Boolean(sign && unlockedPgpKeys.length),
      recipientCount: publicKeys.length,
    };
  } catch (err) {
    return {
      success: false,
      reason: 'encrypt_failed',
      message: err?.message || 'Encryption failed',
    };
  }
}

/**
 * The unlocked key to sign as `from`: the one with that address among its
 * user ids, else the first. Several accounts' keys can be loaded at once.
 */
function signingKeyFor(from) {
  const address = String(from || '')
    .trim()
    .toLowerCase();
  if (address) {
    const match = unlockedPgpKeys.find((key) => keyAddresses(key).includes(address));
    if (match) return match;
  }
  return unlockedPgpKeys[0] || null;
}

/**
 * Make a detached signature over a MIME entity, for an RFC 3156
 * multipart/signed message (pgp-mime.ts buildPgpSignedMessage).
 *
 * The signature covers the entity's exact bytes with CRLF line endings, which
 * is how receivers canonicalize it before checking. `micalg` names the hash
 * the signature used, since the outer Content-Type has to say it.
 */
async function handleSignMessageTask(task) {
  const { plaintext, from } = task;
  if (!plaintext || typeof plaintext !== 'string') {
    return { success: false, reason: 'invalid_input', message: 'Nothing to sign' };
  }
  await pgpKeysReady.catch(() => {});
  const signingKey = signingKeyFor(from);
  if (!signingKey) {
    return {
      success: false,
      reason: 'no_signing_key',
      message:
        'No unlocked PGP key to sign with. Add your key and save its passphrase in Settings, or open an encrypted message to unlock it.',
    };
  }
  try {
    const canonical = plaintext.replace(/\r?\n/g, '\r\n');
    const message = await openpgp.createMessage({
      binary: new TextEncoder().encode(canonical),
    });
    const armored = await openpgp.sign({
      message,
      signingKeys: signingKey,
      detached: true,
      format: 'armored',
    });
    const signature = await openpgp.readSignature({ armoredSignature: armored });
    const hashId = signature.packets?.[0]?.hashAlgorithm;
    const hashName = hashId !== undefined ? openpgp.enums.read(openpgp.enums.hash, hashId) : '';
    return {
      success: true,
      signature: armored,
      micalg: `pgp-${String(hashName || 'sha256').toLowerCase()}`,
    };
  } catch (err) {
    return { success: false, reason: 'sign_failed', message: err?.message || 'Signing failed' };
  }
}

/**
 * Check the signature on a received multipart/signed message (no encryption),
 * against the same keys a signature inside an encrypted message is checked
 * against. `raw` is the full RFC 822 source; see pgp-signed-parts.ts for why
 * the signed part has to come from it byte for byte.
 */
async function handleVerifySignedTask(task: { raw?: string }) {
  const parts = splitSignedMime(task?.raw ?? '');
  if (!parts) return { success: false, reason: 'not_signed' };
  await pgpKeysReady.catch(() => {});
  try {
    const signature = await openpgp.readSignature({ armoredSignature: parts.signature });
    // A text signature is made over the canonical text and a binary one over
    // the bytes; both are the CRLF form here, but openpgp wants the matching kind.
    const isText = signature.packets?.[0]?.signatureType === openpgp.enums.signature.text;
    const message = isText
      ? await openpgp.createMessage({ text: parts.signed })
      : await openpgp.createMessage({ binary: new TextEncoder().encode(parts.signed) });
    const keys = signatureVerificationKeys();
    const verification = await openpgp.verify({ message, signature, verificationKeys: keys });
    const check = await checkSignatures(verification.signatures, keys);
    return { success: true, signature: check || { status: 'unverified', signers: [] } };
  } catch (err) {
    return {
      success: false,
      reason: 'verify_failed',
      message: (err as Error)?.message || String(err),
    };
  }
}

async function handleParseRawTask(task) {
  const { raw, existingAttachments = [] } = task;

  if (!raw) {
    return { success: false, error: 'No raw message provided' };
  }

  const parsed = await parseRawMessage(raw, existingAttachments);
  if (!parsed) {
    return { success: false, error: 'Parse failed' };
  }

  return {
    success: true,
    body: parsed.body,
    rawBody: parsed.rawBody,
    textContent: parsed.textContent,
    attachments: parsed.attachments,
  };
}

// ============================================================================
// Task Handlers
// ============================================================================

async function handleTask(taskId, task) {
  try {
    // Auth is checked per task account, not against a shared header, so a task
    // left over from a switched-away account fails here instead of borrowing
    // the live account's credentials. PGP tasks are local-only (no fetch).
    const isLocalOnlyTask =
      task?.type === 'decryptMessage' ||
      task?.type === 'parseRaw' ||
      task?.type === 'encryptMessage' ||
      task?.type === 'signMessage' ||
      task?.type === 'verifySigned';
    if (!apiBase || (!isLocalOnlyTask && !authFor(accountKey(task?.account)))) {
      throw new Error('Worker not initialized');
    }
    if (!task?.type) throw new Error('Missing task type');

    let summary = null;
    if (task.type === 'metadata') {
      summary = await runMetadataTask(task, (p) => {
        self.postMessage({ ...p, taskId });
      });
    } else if (task.type === 'backfill') {
      summary = await runBackfillTask(task, (p) => {
        self.postMessage({ ...p, taskId });
      });
    } else if (task.type === 'bodies' || task.type === 'prefetch') {
      // 'prefetch' is an ID-targeted body warm; runBodiesTask branches on
      // task.messageIds and stays silent (no progress, no manifest write).
      await runBodiesTask(task, (p) => {
        self.postMessage({ ...p, taskId });
      });
    } else if (task.type === 'drafts') {
      await runDraftSyncTask(task, (p) => {
        self.postMessage({ ...p, taskId });
      });
    } else if (task.type === 'decryptMessage') {
      summary = await handleDecryptMessageTask(task);
    } else if (task.type === 'parseRaw') {
      summary = await handleParseRawTask(task);
    } else if (task.type === 'encryptMessage') {
      summary = await handleEncryptMessageTask(task);
    } else if (task.type === 'signMessage') {
      summary = await handleSignMessageTask(task);
    } else if (task.type === 'verifySigned') {
      summary = await handleVerifySignedTask(task);
    } else {
      throw new Error(`Unsupported task type: ${task.type}`);
    }
    self.postMessage({
      type: 'taskComplete',
      taskId,
      folder: task.folder,
      taskType: task.type,
      account: task.account,
      ...(summary || {}),
    });
  } catch (err) {
    self.postMessage({
      type: 'taskError',
      taskId,
      folder: task?.folder,
      account: task?.account,
      error: err?.message || String(err),
    });
  }
}

async function fetchFolders(account) {
  const url = new URL(`${apiBase.replace(/\/$/, '')}/v1/folders`);
  // Request max folders to avoid pagination truncation (API default is 25)
  url.searchParams.set('limit', '100');
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: requireAuth(account),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText || 'Request failed');
  }
  const json = await res.json();
  const raw = json?.Result || json || [];
  const list = Array.isArray(raw) ? raw : raw.Items || raw.items || [];

  if (dbPort) {
    // Replace the account's folders in one transaction so a failure between
    // the delete and the write cannot leave the account with no folders.
    const records = list.map((f) => ({
      ...f,
      account,
      updatedAt: Date.now(),
    }));
    await dbSend('transaction', null, {
      mode: 'rw',
      tables: ['folders'],
      operations: [
        {
          action: 'queryEqualsDelete',
          table: 'folders',
          payload: { index: 'account', value: account },
        },
        { action: 'bulkPut', table: 'folders', payload: { records } },
      ],
    });
  }

  return { folders: list };
}

async function fetchMessagePage(payload = {}) {
  const account = accountKey(payload.account);
  const folder = payload.folder;
  const limit = payload.limit || DEFAULT_LIMIT;

  const params = {
    folder,
    page: payload.page || 1,
    limit,
    raw: false,
    attachments: false,
    // Forward the caller's lightweight choice. This used to be dropped here, so
    // the worker path silently fetched the full shape while the main-thread
    // fallback fetched lightweight: the same list request returned senders or
    // not depending on which path served it. The caller decides (see
    // api-capabilities), and both paths must honour the same decision.
    ...(payload.lightweight ? { lightweight: true } : {}),
    ...(payload.fields ? { fields: payload.fields } : {}),
    ...(payload.sort ? { sort: payload.sort } : {}),
    ...(payload.search ? { search: payload.search } : {}),
    ...(payload.is_unread ? { is_unread: true } : {}),
    ...(payload.has_attachments || payload.has_attachment ? { has_attachments: true } : {}),
  };

  const res = await fetchMessageList(account, params);
  if (res?.__noContent) {
    return { messages: null, hasNextPage: false, noContent: true };
  }
  const rawList = parseResultList(res);
  const list = Array.isArray(rawList) ? rawList : [];
  if (!list.length) {
    return { messages: [], hasNextPage: false };
  }

  const normalized = [];
  const labelPresence: boolean[] = [];
  for (const item of list) {
    const record = normalizeMessageForCache(item, folder, account);
    if (!record?.id) continue;
    const incomingLabels = coerceLabelList(record.labels);
    normalized.push({
      ...record,
      normalizedSubject: normalizeSubject(record.subject),
      threadId: item.threadId || item.ThreadId || item.thread_id || record.thread_id,
      in_reply_to:
        record.in_reply_to ||
        item.in_reply_to ||
        item.inReplyTo ||
        item['In-Reply-To'] ||
        item?.nodemailer?.headers?.['in-reply-to'] ||
        item?.nodemailer?.headers?.['In-Reply-To'] ||
        null,
      references:
        record.references ||
        item.references ||
        item.References ||
        item?.nodemailer?.headers?.references ||
        item?.nodemailer?.headers?.References ||
        null,
    });
    labelPresence.push(hasServerLabels(item) || incomingLabels.length > 0);
  }

  let toStore = normalized;
  if (normalized.length && dbPort) {
    if (labelPresence.some((hasLabels) => !hasLabels)) {
      const keys = normalized.map((msg) => [account, msg.id]);
      const existingRecords = await db.messages.bulkGet(keys);
      const fallbackKeys = [];
      const fallbackIndex = new Map();
      normalized.forEach((msg, idx) => {
        const uid = msg?.uid;
        const candidates = [uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
        for (const candidate of candidates) {
          if (candidate === msg?.id) continue;
          fallbackIndex.set(`${idx}:${candidate}`, fallbackKeys.length);
          fallbackKeys.push([account, candidate]);
        }
      });
      const fallbackRecords = fallbackKeys.length ? await db.messages.bulkGet(fallbackKeys) : [];
      toStore = normalized.map((msg, idx) => {
        if (labelPresence[idx]) return msg;
        const existing = existingRecords[idx];
        const existingLabels = coerceLabelList(existing?.labels);
        if (existingLabels.length) {
          return { ...msg, labels: existingLabels };
        }
        const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
        for (const candidate of candidates) {
          const key = `${idx}:${candidate}`;
          if (!fallbackIndex.has(key)) continue;
          const fallback = fallbackRecords[fallbackIndex.get(key)];
          const fallbackLabels = coerceLabelList(fallback?.labels);
          if (fallbackLabels.length) {
            return { ...msg, labels: fallbackLabels };
          }
        }
        return msg;
      });
    }

    if (toStore.length) {
      const fromKeys = [];
      const fromIndices = [];
      const fallbackKeys = [];
      const fallbackIndex = new Map();
      toStore.forEach((msg, idx) => {
        if (hasFromValue(msg?.from)) return;
        fromKeys.push([account, msg.id]);
        fromIndices.push(idx);
        const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
        for (const candidate of candidates) {
          if (candidate === msg?.id) continue;
          fallbackIndex.set(`${idx}:${candidate}`, fallbackKeys.length);
          fallbackKeys.push([account, candidate]);
        }
      });
      if (fromKeys.length) {
        const existingFrom = await db.messages.bulkGet(fromKeys);
        const fallbackRecords = fallbackKeys.length ? await db.messages.bulkGet(fallbackKeys) : [];
        const next = toStore.slice();
        existingFrom.forEach((record, i) => {
          const idx = fromIndices[i];
          if (idx === undefined) return;
          if (hasFromValue(record?.from)) {
            next[idx] = { ...next[idx], from: record.from };
            return;
          }
          const msg = toStore[idx] || {};
          const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
          for (const candidate of candidates) {
            const key = `${idx}:${candidate}`;
            if (!fallbackIndex.has(key)) continue;
            const fallback = fallbackRecords[fallbackIndex.get(key)];
            if (hasFromValue(fallback?.from)) {
              next[idx] = { ...next[idx], from: fallback.from };
              break;
            }
          }
        });
        toStore = next;
      }

      // The lightweight list leaves out In-Reply-To and References. Keep the
      // ones already cached (from an older full list or an opened message)
      // rather than writing nulls over them, which split threads apart.
      const headerIndices: number[] = [];
      toStore.forEach((msg: Record<string, unknown>, idx: number) => {
        if (!hasFromValue(msg?.in_reply_to) || !hasFromValue(msg?.references)) {
          headerIndices.push(idx);
        }
      });
      if (headerIndices.length) {
        const cached = (await db.messages.bulkGet(
          headerIndices.map((idx) => [account, toStore[idx].id]),
        )) as Array<Record<string, unknown> | undefined>;
        const next = toStore.slice();
        cached.forEach((record: Record<string, unknown> | undefined, i: number) => {
          const idx = headerIndices[i];
          const patch: Record<string, unknown> = {};
          for (const field of ['in_reply_to', 'references'] as const) {
            if (!hasFromValue(next[idx]?.[field]) && hasFromValue(record?.[field])) {
              patch[field] = record?.[field];
            }
          }
          if (Object.keys(patch).length) next[idx] = { ...next[idx], ...patch };
        });
        toStore = next;
      }
    }

    toStore = await writeMessagePageRows(account, toStore, payload);
  }

  return { messages: toStore, hasNextPage: list.length >= limit };
}

/**
 * Write a list page into the cache without clobbering local state. Each row
 * is merged into the cached one (mergeServerRow keeps the PGP badge, the
 * decrypted subject and fields the list shape left out), a pending read/star
 * change from this device stays on top, and an id the user just deleted or
 * moved away is not written back. Returns the rows as they now stand, with
 * the pending-delete ones left as the server sent them so the caller can still
 * see that the server reported them.
 */
async function writeMessagePageRows(account, rows, payload: Record<string, unknown> = {}) {
  const pendingDeletes = new Set(
    Array.isArray(payload.pendingDeleteIds) ? (payload.pendingDeleteIds as string[]) : [],
  );
  const pendingFlags = (payload.pendingFlagMutations as PendingFlagMap) || null;
  assertAccountScoped('sync.worker.messagePage', account, rows);
  const existing = (await db.messages.bulkGet(rows.map((msg) => [account, msg.id]))) as Array<
    Record<string, unknown> | undefined
  >;
  const merged = rows.map((msg, idx) => {
    if (pendingDeletes.has(msg.id)) return msg;
    return mergeServerRow(existing[idx], applyPendingFlagChange(msg, pendingFlags?.[msg.id]));
  });
  const toWrite = merged.filter((msg) => !pendingDeletes.has(msg.id));
  if (toWrite.length) {
    await db.messages.bulkPut(toWrite);
    postToSearch('index', {
      account,
      includeBody: false,
      messages: toWrite,
    });
  }
  return merged;
}

async function fetchMessageDetail(payload = {}) {
  const account = accountKey(payload.account);
  const message = payload.message || {};
  const folder = payload.folder || message.folder;
  const record = await fetchAndCacheBodyWithOptions(account, folder, message, {
    returnPayload: true,
  });
  return record || { id: message?.id, folder, missing: true };
}

async function runDraftSyncTask(task, postProgress) {
  if (!dbPort) {
    throw new Error('Database worker not connected');
  }
  const account = accountKey(task?.account);
  const drafts = await db.drafts.where('account').equals(account).toArray();
  const pending = drafts.filter((draft) => draft && draft.syncStatus !== 'synced');
  const candidates = pending.filter((draft) => hasMeaningfulDraft(draft));
  if (!candidates.length) {
    postProgress?.({ type: 'progress', stage: 'drafts', account, total: 0, synced: 0, failed: 0 });
    return;
  }

  let synced = 0;
  let failed = 0;
  postProgress?.({
    type: 'progress',
    stage: 'drafts',
    account,
    total: candidates.length,
    synced,
    failed,
  });
  for (const draft of candidates) {
    try {
      await syncDraftRecord(draft, account);
      synced += 1;
    } catch (err) {
      failed += 1;
      const failedDraft = {
        ...draft,
        syncStatus: 'pending',
        lastError: err?.message || 'Draft sync failed',
        updatedAt: Date.now(),
      };
      await db.drafts.put(failedDraft);
    }
    postProgress?.({
      type: 'progress',
      stage: 'drafts',
      account,
      total: candidates.length,
      synced,
      failed,
    });
  }
}

async function handleRequest(requestId, action, payload) {
  try {
    // unlockPgpKey is local-only; every other action fetches as payload.account.
    const isLocalOnlyAction = action === 'unlockPgpKey';
    if (!apiBase || (!isLocalOnlyAction && !authFor(accountKey(payload?.account)))) {
      throw new Error('Worker not initialized');
    }
    let result = null;
    if (action === 'folders') {
      const account = accountKey(payload?.account);
      result = await fetchFolders(account);
    } else if (action === 'messagePage') {
      result = await fetchMessagePage(payload || {});
    } else if (action === 'messageDetail') {
      result = await fetchMessageDetail(payload || {});
    } else if (action === 'unlockPgpKey') {
      result = await unlockPgpKeyWithPassphrase(payload || {});
    } else {
      throw new Error(`Unsupported request action: ${action}`);
    }
    self.postMessage({ type: 'requestComplete', requestId, action, result });
  } catch (err) {
    self.postMessage({
      type: 'requestError',
      requestId,
      action,
      error: err?.message || String(err),
    });
  }
}

// ============================================================================
// PGP Key Management
// ============================================================================

// Settles once the latest key set is in place. updatePgpKeys runs from the
// message handler without being awaited, so a messageDetail arriving right
// after launch used to find no keys, cache the message as locked and send the
// reader down the slow main-thread unlock. decryptPgp waits on this instead.
let pgpKeysReady: Promise<void> = Promise.resolve();

// Public keys the user has pinned for contacts (pgp-recipients.ts), parsed
let contactPublicKeys = [];

/** Keys a signature can be checked against: pinned contacts and the user's own. */
function signatureVerificationKeys() {
  const own = [];
  for (const key of unlockedPgpKeys) {
    try {
      own.push(key.toPublic());
    } catch {
      // a key that cannot give its public half signs nothing we can check
    }
  }
  return [...contactPublicKeys, ...own];
}

async function updateContactKeys(armoredKeys = []) {
  const parsed = [];
  for (const armored of Array.isArray(armoredKeys) ? armoredKeys : []) {
    if (typeof armored !== 'string' || !armored) continue;
    try {
      parsed.push(await openpgp.readKey({ armoredKey: armored }));
    } catch {
      // the composer reports unreadable pinned keys; skip it here
    }
  }
  contactPublicKeys = parsed;
}

async function updatePgpKeys(keys = [], passphrases = {}, contactKeys = []) {
  await updateContactKeys(contactKeys);
  pgpPassphrases = passphrases || {};
  const previous: Array<{ getFingerprint: () => string }> = unlockedPgpKeys;
  const unlocked = [];
  for (const key of keys) {
    if (!key?.value) continue;

    let privateKey;
    try {
      privateKey = await openpgp.readPrivateKey({ armoredKey: key.value });
    } catch (err) {
      console.warn('[sync.worker] Skipping invalid PGP private key', key?.name, err?.message);
      if (key?.name) {
        delete pgpPassphrases[key.name];
      }
      continue;
    }

    if (!privateKey.isDecrypted()) {
      const passphrase = pgpPassphrases[key.name];
      if (passphrase) {
        try {
          const unlockedKey = await openpgp.decryptKey({
            privateKey,
            passphrase,
          });
          unlocked.push(unlockedKey);
        } catch (err) {
          console.warn('[sync.worker] Failed to auto-unlock PGP key', key.name, err?.message);
          delete pgpPassphrases[key.name];
        }
      } else {
        // Unlocked for this session only (passphrase not remembered). A key
        // refresh carries no passphrase for it, and replacing the set dropped
        // it, so the next encrypted message asked for the passphrase again.
        const fingerprint = privateKey.getFingerprint();
        const kept = previous.find((k) => k.getFingerprint() === fingerprint);
        if (kept) unlocked.push(kept);
      }
    } else {
      unlocked.push(privateKey);
    }
  }
  unlockedPgpKeys = unlocked;
  pgpKeysVersion += 1;
}

function isRetryablePgpUnlockError(errorMessage = '') {
  return /passphrase|password|session key decryption failed|checksum/i.test(
    String(errorMessage || ''),
  );
}

/**
 * Unlock a specific PGP key with a passphrase from the main thread
 * This is called when the user provides a passphrase via the modal
 * If no passphrase is provided, checks if the key is unprotected
 */
async function unlockPgpKeyWithPassphrase({
  keyName,
  passphrase,
  keyValue,
  remember = false,
  checkOnly = false,
}) {
  if (!keyValue) {
    return {
      success: false,
      needsPassphrase: false,
      retryable: false,
      invalidKey: true,
      error: 'Missing key value',
    };
  }

  // A key refresh in progress replaces the whole set when it finishes, which
  // would drop a key unlocked here in the meantime.
  await pgpKeysReady.catch(() => {});

  let privateKey;
  try {
    privateKey = await openpgp.readPrivateKey({ armoredKey: keyValue });
  } catch (error) {
    return {
      success: false,
      needsPassphrase: false,
      retryable: false,
      invalidKey: true,
      error: error?.message || 'That is not a valid PGP private key.',
    };
  }

  try {
    if (privateKey.isDecrypted()) {
      // Key is already unlocked (unprotected key) - no passphrase needed
      if (!checkOnly) {
        const alreadyUnlocked = unlockedPgpKeys.find(
          (k) => k.getFingerprint() === privateKey.getFingerprint(),
        );
        if (!alreadyUnlocked) {
          unlockedPgpKeys.push(privateKey);
          pgpKeysVersion += 1;
        }
      }
      return { success: true, alreadyUnlocked: true, needsPassphrase: false };
    }

    // Key is encrypted and needs a passphrase
    if (checkOnly) {
      // Just checking status, don't try to decrypt
      return { success: false, needsPassphrase: true, retryable: true, invalidKey: false };
    }

    // Already unlocked in this worker: decryptKey runs the key's S2K
    // derivation, which costs a hundred milliseconds or more per call (far
    // more for an argon2 key), and the reader asked for it on every open.
    const fingerprint = privateKey.getFingerprint();
    if (unlockedPgpKeys.some((k) => k.getFingerprint() === fingerprint)) {
      if (remember && keyName && passphrase) pgpPassphrases[keyName] = passphrase;
      return {
        success: true,
        alreadyUnlocked: true,
        keyCount: unlockedPgpKeys.length,
        needsPassphrase: false,
      };
    }

    if (!passphrase) {
      return {
        success: false,
        needsPassphrase: true,
        retryable: true,
        invalidKey: false,
        error: 'Key requires passphrase',
      };
    }

    const unlockedKey = await openpgp.decryptKey({
      privateKey,
      passphrase,
    });

    // Store the passphrase if requested
    if (remember && keyName) {
      pgpPassphrases[keyName] = passphrase;
    }

    // Add to unlocked keys or replace existing
    const existingIndex = unlockedPgpKeys.findIndex(
      (k) => k.getFingerprint() === unlockedKey.getFingerprint(),
    );

    if (existingIndex >= 0) {
      unlockedPgpKeys[existingIndex] = unlockedKey;
    } else {
      unlockedPgpKeys.push(unlockedKey);
      pgpKeysVersion += 1;
    }

    return {
      success: true,
      keyCount: unlockedPgpKeys.length,
      needsPassphrase: false,
    };
  } catch (error) {
    const errorMessage = error?.message || 'Failed to unlock key';
    const retryable = isRetryablePgpUnlockError(errorMessage);
    return {
      success: false,
      needsPassphrase: retryable,
      retryable,
      invalidKey: !retryable,
      error: errorMessage,
    };
  }
}

// ============================================================================
// Search Worker Communication
// ============================================================================

function postToSearch(action, payload) {
  if (!searchPort) {
    return;
  }
  searchPort.postMessage({ action, payload });
}

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = (event) => {
  const data = event?.data || {};

  // Handle database port connection
  if (data.type === 'connectDbPort' && event.ports?.[0]) {
    if (dbPort && dbPort !== event.ports[0]) {
      rejectPendingDbRequests(new Error('Database worker reconnected'));
      try {
        dbPort.close();
      } catch {
        // already closed
      }
    }
    dbPort = event.ports[0];
    dbPort.onmessage = handleDbResponse;
    dbPort.start();
    dbStalled = false;
    return;
  }

  if (data.type === 'init') {
    apiBase = data.config?.apiBase || '';
    if (typeof data.config?.memoryConstrained === 'boolean') {
      memoryConstrained = data.config.memoryConstrained;
    }
    const account = accountKey(data.config?.account);
    const header = data.config?.authHeader || '';
    // Register (don't replace) so work still running for a previously active
    // account keeps authenticating as that account until it finishes. Switching
    // A -> B -> A also reuses A's entry rather than racing a re-init.
    if (header) authHeaders.set(account, header);
    else authHeaders.delete(account);
    return;
  }

  // An account was signed out: drop its credentials so any task still naming it
  // fails instead of running under whoever is active now.
  if (data.type === 'revokeAuth') {
    authHeaders.delete(accountKey(data.account));
    return;
  }
  if (data.type === 'task') {
    handleTask(data.taskId, data.task);
    return;
  }
  if (data.type === 'request') {
    handleRequest(data.requestId, data.action, data.payload);
    return;
  }
  if (data.type === 'pgpKeys') {
    pgpKeysReady = updatePgpKeys(
      data.keys || [],
      data.passphrases || {},
      data.contactKeys || [],
    ).catch((err) => {
      console.warn('[sync.worker] PGP key update failed', err?.message);
    });
    return;
  }
  if (data.type === 'optimisticOverlay') {
    liveOverlay = {
      deleteIds: new Set(Array.isArray(data.deleteIds) ? data.deleteIds.map(String) : []),
      flags: data.flags && typeof data.flags === 'object' ? data.flags : {},
    };
    return;
  }
  if (data.type === 'connectSearchPort' && event.ports?.[0]) {
    searchPort = event.ports[0];
    searchPort.start();
    return;
  }
};
