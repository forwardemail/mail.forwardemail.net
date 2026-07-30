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
  extractFromField,
} from '../utils/sync-helpers.ts';
import { normalizeSubject } from '../utils/threading.ts';
import {
  bufferToDataUrl,
  applyInlineAttachments,
  extractTextContent,
} from '../utils/mime-utils.js';
import {
  toUid,
  toKey,
  accountKey,
  coerceLabelList,
  hasFromValue,
  hasMeaningfulDraft,
  buildDraftPayload,
  parseResultList,
  isPgpContent,
  worklistFromHeaders,
  backfillBatchDone,
} from './sync-pure.ts';
import { createCircuitBreaker, parseRetryAfterMs } from '../utils/circuit-breaker.js';
import { assertAccountScoped } from '../utils/account-scope.ts';

// ============================================================================
// Database Client via MessageChannel
// ============================================================================

let dbPort = null;
let dbRequestId = 0;
const dbPendingRequests = new Map();

function dbSend(action, table = null, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!dbPort) {
      reject(new Error('Database worker not connected'));
      return;
    }

    const id = ++dbRequestId;
    dbPendingRequests.set(id, { resolve, reject });
    dbPort.postMessage({ id, action, table, payload });
  });
}

function handleDbResponse(event) {
  const { id, ok, result, error } = event.data || {};
  const pending = dbPendingRequests.get(id);
  if (!pending) return;

  dbPendingRequests.delete(id);
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
    where: (index) => ({
      equals: (value) => ({
        toArray: () => dbSend('queryEquals', 'messages', { index, value }),
        delete: () => dbSend('queryEqualsDelete', 'messages', { index, value }),
      }),
    }),
  },
  messageBodies: {
    get: (key) => dbSend('get', 'messageBodies', { key }),
    bulkGet: (keys) => dbSend('bulkGet', 'messageBodies', { keys }),
    put: (record) => dbSend('put', 'messageBodies', { record }),
    where: (index) => ({
      equals: (value) => ({
        toArray: () => dbSend('queryEquals', 'messageBodies', { index, value }),
      }),
    }),
  },
  folders: {
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
    body: JSON.stringify(payload),
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
    const err = new Error('Backing off — service temporarily unavailable');
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

async function writeMessages(account, folder, normalized, pendingDeleteIds: string[] = []) {
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
    if (!existing) {
      toUpsert.push(msg);
      changedForIndex.push(msg);
      inserted += 1;
      return;
    }

    const { record, changed } = mergeFlagsAndMetadata(existing, msg);
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

  let manifest = await getManifest(account, folder);
  let lastUID = manifest?.lastUID || 0;
  let lastModSeq = manifest?.lastModSeq || null;
  let page = 1;
  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;

  while (true) {
    if (totalFetched >= maxMessages) break;

    const params = {
      folder,
      page,
      limit,
      after_uid: lastUID || undefined,
      since_modseq: lastModSeq || undefined,
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
    );

    totalFetched += normalized.length;
    totalInserted += writeResult.inserted;
    totalUpdated += writeResult.updated;

    normalized.forEach((item) => {
      lastUID = Math.max(toUid(item.id), toUid(lastUID));
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
// runMetadataTask is forward-only — once initial sync stops at the
// sync_max_headers cap, the oldest synced message becomes a permanent floor
// (the API doesn't expose before_uid). runBackfillTask walks the `page`
// offset backwards in small batches and lets writeMessages dedupe; the
// controller re-schedules the task after each batch so foreground work
// (folder navigation, manual refresh, body fetch) can preempt.
//
// Stop conditions: server returned an empty page BACKFILL_EMPTY_STREAK_LIMIT
// times in a row, hit the per-folder safety cap, or this batch returned
// only duplicates (already in IDB).

const BACKFILL_PAGES_PER_BATCH = 5;
const BACKFILL_EMPTY_STREAK_LIMIT = 3;
const BACKFILL_THROTTLE_MS = 800;
const BACKFILL_DEFAULT_LIMIT = 50;
// Per-folder safety cap. Folders with truly enormous history won't backfill
// forever; users who want more can raise this via a settings extension later.
const BACKFILL_SAFETY_CAP = 20_000;

async function runBackfillTask(task, postProgress) {
  const account = accountKey(task.account);
  const folder = task.folder;
  if (!account || !folder) return { done: true, reason: 'invalid_task' };

  // Without API config there's nothing to fetch. Bail as "done" rather than
  // letting fetchMessageList throw on `new URL('')` below: the caller treats a
  // thrown/zero-progress batch as transient and re-queues, so an unconfigured
  // worker (e.g. a backfill that runs before the init message lands, common in
  // dev) would spin "Syncing <folder>" forever with no network activity.
  if (!apiBase || !authFor(account)) {
    return { done: true, reason: 'not_configured' };
  }

  let manifest = await getManifest(account, folder);
  if (manifest.backfillComplete) {
    return { done: true, reason: 'already_complete' };
  }
  if ((manifest.backfillTotalInserted || 0) >= BACKFILL_SAFETY_CAP) {
    await updateManifest(account, folder, { backfillComplete: true });
    return { done: true, reason: 'safety_cap' };
  }

  const limit = task.pageSize || BACKFILL_DEFAULT_LIMIT;
  // First-ever backfill starts AFTER what forward sync covered. messagesFetched
  // is a running total from runMetadataTask; ceil(/limit) + 1 is the first
  // page below the forward-sync floor. Bumped to >= 2 because page 1 is
  // always the newest and would just duplicate.
  let page =
    manifest.backfillPage ?? Math.max(2, Math.ceil((manifest.messagesFetched || 0) / limit) + 1);
  let emptyStreak = manifest.backfillEmptyStreak || 0;
  let totalInsertedThisRun = 0;
  let pagesThisRun = 0;
  let exhausted = false;

  while (pagesThisRun < BACKFILL_PAGES_PER_BATCH) {
    const params = {
      folder,
      page,
      limit,
      include_body: 0,
      raw: false,
      attachments: false,
    };

    let res;
    try {
      res = await fetchMessageList(account, params);
    } catch (err) {
      // Network/auth hiccup — return partial progress; the controller
      // will retry on the next batch.
      console.warn('[sync.worker] backfill fetch failed:', err);
      break;
    }

    const rawList = parseResultList(res);
    if (!Array.isArray(rawList) || !rawList.length) {
      emptyStreak += 1;
      page += 1;
      pagesThisRun += 1;
      if (emptyStreak >= BACKFILL_EMPTY_STREAK_LIMIT) {
        exhausted = true;
        break;
      }
      continue;
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
      );
      totalInsertedThisRun += writeResult.inserted;
    }

    page += 1;
    pagesThisRun += 1;

    postProgress?.({
      type: 'progress',
      folder,
      stage: 'backfill',
      page,
      fetched: totalInsertedThisRun,
      inserted: totalInsertedThisRun,
    });

    if (totalInsertedThisRun + (manifest.backfillTotalInserted || 0) >= BACKFILL_SAFETY_CAP) {
      exhausted = true;
      break;
    }

    // Throttle so backfill stays well behind any foreground network
    // activity. Yield to the event loop between throttled waits so
    // higher-priority worker messages get processed promptly.
    await new Promise((resolve) => setTimeout(resolve, BACKFILL_THROTTLE_MS));
  }

  const nextManifest = {
    backfillPage: page,
    backfillEmptyStreak: emptyStreak,
    backfillTotalInserted: (manifest.backfillTotalInserted || 0) + totalInsertedThisRun,
    lastBackfillAt: Date.now(),
  };
  if (exhausted) {
    nextManifest.backfillComplete = true;
  }
  await updateManifest(account, folder, nextManifest);

  // backfillBatchDone: a zero-page batch (first fetch threw before the network)
  // reports done so the controller stops re-queuing instead of spinning a tight,
  // no-progress loop; the next metadata sync resumes from the saved page.
  return {
    done: backfillBatchDone({ exhausted, pagesProcessed: pagesThisRun }),
    inserted: totalInsertedThisRun,
    page,
    pagesProcessed: pagesThisRun,
  };
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
        await db.messages.bulkPut([{ ...msg, from: fixedFrom }]);
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
  type BodyCacheRecord = { body?: string | null; attachments?: unknown[] };

  let worklist;
  if (idTargeted) {
    const ids = task.messageIds.slice(0, limit) as string[];
    const records = (await db.messages.bulkGet(
      ids.map((id) => [account, id]),
    )) as BodyHeaderRecord[];
    const headers = records.filter(Boolean);
    if (!headers.length) return;
    const bodies = (await db.messageBodies.bulkGet(
      headers.map((m) => [account, m.id]),
    )) as BodyCacheRecord[];
    worklist = worklistFromHeaders(headers, bodies, headers.length);
  } else {
    const headers = (await db.messages
      .where('[account+folder]')
      .equals([account, folder])
      .toArray()) as BodyHeaderRecord[];
    headers.sort((a, b) => (b.date || b.dateMs || 0) - (a.date || a.dateMs || 0));
    const sample = headers.slice(0, Math.min(maxMessages || headers.length, limit * 2));
    const bodies = (await db.messageBodies.bulkGet(
      sample.map((m) => [account, m.id]),
    )) as BodyCacheRecord[];
    worklist = worklistFromHeaders(sample, bodies, maxMessages).slice(0, limit);
  }

  if (!worklist.length) {
    // Only the folder-wide pass owns the "bodies done" manifest flag.
    if (!idTargeted) {
      await updateManifest(account, folder, { hasBodiesPass: true, lastSyncAt: Date.now() });
    }
    return;
  }

  let completed = 0;
  for (const msg of worklist) {
    // All prefetched ids come from the current folder list, so the task folder
    // is the right one to cache under (and keeps types clean — HeaderLike has
    // no `folder`).
    await fetchAndCacheBody(account, folder, msg, { returnPayload: false });
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
      hasBodiesPass: completed >= worklist.length,
      lastSyncAt: Date.now(),
    });
  }
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
  const persistBody = async (body, textContent, attachments = [], meta = null) => {
    if (dbPort) {
      await db.messageBodies.put({
        id: apiId,
        account,
        folder,
        body,
        textContent,
        attachments,
        meta,
        updatedAt: Date.now(),
      });
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
      attachments,
      meta,
    };
  };
  if (dbPort) {
    try {
      const cached = await db.messageBodies.get([account, apiId]);
      // Detect stale cache: raw PGP/MIME was incorrectly stored as body
      const isStalePgpBody =
        cached?.body && typeof cached.body === 'string' && isPgpContent(cached.body);
      if (cached?.body && !isStalePgpBody) {
        if (returnPayload) {
          return {
            id: apiId,
            folder: cached.folder || folder,
            body: cached.body,
            textContent: cached.textContent || '',
            attachments: cached.attachments || [],
            meta: (cached as { meta?: Record<string, unknown> }).meta || null,
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

  const requestPromise = (async () => {
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
    const result = json?.Result || json;
    const raw = result?.raw;
    let body = '';
    let textContent = '';
    let attachments = [];

    if (raw) {
      const isPgp = isPgpContent(raw);
      if (isPgp) {
        const decrypted = await decryptPgp(raw);
        if (!decrypted) {
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
            const changes = { pgpEncrypted: true, pgpSigned: lastDecryptSigned };
            if (typeof parsed.subject === 'string' && parsed.subject.trim()) {
              changes.subject = parsed.subject;
            }
            await db.messages.where('[account+id]').equals([account, apiId]).modify(changes);
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

async function decryptPgp(armored) {
  lastDecryptError = '';
  lastDecryptSigned = false;
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
          'PGP/MIME message has empty encrypted payload — the API response may be incomplete.';
      } else {
        lastDecryptError = 'No PGP armor block found in message content.';
      }
      return '';
    }

    const message = await openpgp.readMessage({ armoredMessage: pgpBlock });

    const { data, signatures } = await openpgp.decrypt({
      message,
      decryptionKeys: unlockedPgpKeys,
    });
    // Signature PACKETS present, but sender authenticity is NOT verified (we
    // pass no verificationKeys / have no public-key store yet). Callers must
    // present this as "signed (unverified)".
    lastDecryptSigned = Array.isArray(signatures) && signatures.length > 0;
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
    keyCount: unlockedPgpKeys.length,
  };
}

/**
 * Handle MIME parsing request from main thread (Phase 3 optimization)
 * This allows main thread to delegate all MIME parsing to worker
 */
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
    const isLocalOnlyTask = task?.type === 'decryptMessage' || task?.type === 'parseRaw';
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
    await db.folders.where('account').equals(account).delete();
    await db.folders.bulkPut(
      list.map((f) => ({
        ...f,
        account,
        updatedAt: Date.now(),
      })),
    );
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
  const labelPresence = [];
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
    labelPresence.push(incomingLabels.length > 0);
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
        const incoming = coerceLabelList(msg.labels);
        if (incoming.length > 0) return msg;
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
    }

    await db.messages.bulkPut(toStore);
    postToSearch('index', {
      account,
      includeBody: false,
      messages: toStore,
    });
  }

  return { messages: toStore, hasNextPage: list.length >= limit };
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

async function updatePgpKeys(keys = [], passphrases = {}) {
  pgpPassphrases = passphrases || {};
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
      }
    } else {
      unlocked.push(privateKey);
    }
  }
  unlockedPgpKeys = unlocked;
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
        }
      }
      return { success: true, alreadyUnlocked: true, needsPassphrase: false };
    }

    // Key is encrypted and needs a passphrase
    if (checkOnly) {
      // Just checking status, don't try to decrypt
      return { success: false, needsPassphrase: true, retryable: true, invalidKey: false };
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
    dbPort = event.ports[0];
    dbPort.onmessage = handleDbResponse;
    dbPort.start();
    return;
  }

  if (data.type === 'init') {
    apiBase = data.config?.apiBase || '';
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
    updatePgpKeys(data.keys || [], data.passphrases || {});
    return;
  }
  if (data.type === 'connectSearchPort' && event.ports?.[0]) {
    searchPort = event.ports[0];
    searchPort.start();
    return;
  }
};
