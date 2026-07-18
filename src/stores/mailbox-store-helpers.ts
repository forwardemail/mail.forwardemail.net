// Pure helpers extracted from mailboxStore.ts so they can be unit-tested
// without loading the store's I/O graph (Dexie/db, sync worker, Remote, other
// stores). These are message-identity / list-merge / value-coercion helpers
// with no module state and no side effects. Anything touching db/Remote/stores
// (e.g. mergeMissingLabels/mergeMissingFrom) stays in mailboxStore.ts.
//
// Params are intentionally left loosely typed to match the originals verbatim
// (mailboxStore.ts is pervasively untyped) — this is a behavior-preserving
// extraction, not a retype. eslint forbids explicit `any`, so the dynamic
// response/record params below are left untyped (implicit any) like the rest.

import { normalizeMessageForCache } from '../utils/sync-helpers';

// Validate a value the way Dexie validates a primary key, used as a fallback
// guard before writing to IndexedDB. Strings, finite numbers, Dates, and
// arrays of those are valid keys; null/undefined/objects/NaN are not.
export const isValidDexieKeyFallback = (key) => {
  if (key == null) return false;
  if (Array.isArray(key)) return key.every(isValidDexieKeyFallback);
  if (key instanceof Date) return true;
  const type = typeof key;
  if (type === 'string') return true;
  if (type === 'number') return Number.isFinite(key);
  return false;
};

// Normalize a labels value (array or comma-separated string) into a clean
// string[] — trims entries, drops empties and the literal "[]" placeholder.
export const coerceLabelList = (value) => {
  const normalizeLabel = (label) => {
    const normalized = String(label ?? '').trim();
    if (!normalized || /^\[\s*\]$/.test(normalized)) return '';
    return normalized;
  };
  if (Array.isArray(value)) {
    return value.map((label) => normalizeLabel(label)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((label) => normalizeLabel(label))
      .filter(Boolean);
  }
  return [];
};

export const hasFromValue = (value) => typeof value === 'string' && value.trim().length > 0;

// Derive a stable, collision-safe identity for a message used to dedup list
// pages. Prefer the server-assigned id/uid; fall back to the Message-ID header
// scoped by folder so forwarded copies sharing a Message-ID aren't collapsed.
export const getMessageKey = (msg) => {
  // Prefer server-assigned id/uid which is unique per message per folder.
  // Fallback to Message-ID header scoped by folder to avoid collapsing
  // forwarded emails that share the same Message-ID as the original.
  const uid = msg?.id ?? msg?.uid ?? msg?.Uid ?? msg?.uidnext;
  if (uid != null) return uid;
  const messageId =
    msg?.message_id ?? msg?.messageId ?? msg?.['Message-ID'] ?? msg?.header_message_id;
  if (messageId) {
    const folder = msg?.folder ?? '';
    return `${folder}:${messageId}`;
  }
  return null;
};

// Merge two message-list pages, preserving order (existing first, then
// incoming) and dropping duplicates by getMessageKey. Messages with no
// derivable key are always kept (can't dedup what we can't identify).
//
// `max` (optional, >0): bound the merged result to its last `max` entries by
// dropping from the HEAD. Infinite scroll appends older pages at the tail, so
// the head holds rows the user has scrolled well past; capping the live window
// keeps the in-memory array — and the DOM rows derived from it — from growing
// for the entire life of a folder session. The dropped head is restored by any
// page-1 replace-load (folder reselect, refresh, filter change). `max <= 0`
// (the default) means no cap.
export const mergeMessagePages = (existing = [], incoming = [], max = 0) => {
  const merged = [];
  const seen = new Set();
  const append = (list) => {
    (list || []).forEach((msg) => {
      const key = getMessageKey(msg);
      if (key == null) {
        merged.push(msg);
        return;
      }
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(msg);
    });
  };
  append(existing);
  append(incoming);
  if (max > 0 && merged.length > max) {
    return merged.slice(-max);
  }
  return merged;
};

// Decide whether infinite scroll should keep paging after a message-list page
// fetch resolves. Two independent "more exists" signals:
//   - the fetched page looked full (worker reports hasNextPage, or the
//     main-thread page returned a full `limit` of items), and
//   - the folder's server-reported total exceeds what we've paged so far.
// Either keeps scroll alive. Crucially we also OR in `serverTotal`, because the
// per-source signal is bounded by what's been synced — a folder with hundreds
// of messages whose first server page comes back short (e.g. 47 of a 50 limit)
// would otherwise set hasNextPage=false and strand the rest. (This mirrors the
// cache-read path's hasMorePages() check; without it the post-fetch overwrote
// that optimism back to false — the "stuck at ~47" desktop bug.)
//
// The empty-page guard wins over everything: a page that returns zero items is
// the real end of the folder, so we stop even if a stale-high serverTotal still
// looks like there's more — otherwise scroll spins forever on empty fetches.
export const resolveHasMoreAfterFetch = ({
  source,
  workerHasNextPage,
  listLength,
  limit,
  page,
  serverTotal,
}: {
  source: string;
  workerHasNextPage?: unknown;
  listLength: number;
  limit: number;
  page: number;
  serverTotal?: number | null;
}): boolean => {
  if (!listLength) return false;
  const fetchedFullPage = source === 'worker' ? Boolean(workerHasNextPage) : listLength >= limit;
  const serverHasMore = Number.isFinite(serverTotal) && (serverTotal as number) > page * limit;
  return fetchedFullPage || serverHasMore;
};

// Reads cached message records by compound key ([account, id] or alternate
// identifiers). Injected so these backfills can be unit-tested without Dexie;
// in the store it's wired to `db.messages.bulkGet`.
type MessageBulkGet = (keys: unknown[]) => Promise<Array<Record<string, unknown> | undefined>>;

// Backfill labels onto list messages that arrived without them by reading the
// cached copy from IndexedDB — first by [account, id], then by alternate
// identifiers (uid/message_id/header_message_id). Returns the input list
// unchanged when there's nothing to look up or on any error.
export const mergeMissingLabels = async (
  bulkGet: MessageBulkGet,
  account,
  list,
  labelPresence = [],
) => {
  try {
    const lookup = [];
    const indices = [];
    const fallbackKeys = [];
    const fallbackIndex = new Map();
    list.forEach((msg, idx) => {
      const incoming = coerceLabelList(msg.labels);
      if (!labelPresence[idx] || incoming.length === 0) {
        lookup.push([account, msg.id]);
        indices.push(idx);
      }
    });
    if (!lookup.length) return list;
    const existing = await bulkGet(lookup);
    indices.forEach((msgIdx) => {
      const msg = list[msgIdx] || {};
      const id = msg?.id;
      const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
      for (const candidate of candidates) {
        if (candidate === id) continue;
        fallbackIndex.set(`${msgIdx}:${candidate}`, fallbackKeys.length);
        fallbackKeys.push([account, candidate]);
      }
    });
    const fallbackRecords = fallbackKeys.length ? await bulkGet(fallbackKeys) : [];
    if (!existing?.length) return list;
    const next = list.slice();
    existing.forEach((record, i) => {
      const idx = indices[i];
      if (idx === undefined) return;
      const existingLabels = coerceLabelList(record?.labels);
      if (existingLabels.length) {
        next[idx] = { ...next[idx], labels: existingLabels };
        return;
      }
      const msg = list[idx] || {};
      const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
      for (const candidate of candidates) {
        const key = `${idx}:${candidate}`;
        if (!fallbackIndex.has(key)) continue;
        const fallback = fallbackRecords[fallbackIndex.get(key)];
        const fallbackLabels = coerceLabelList(fallback?.labels);
        if (fallbackLabels.length) {
          next[idx] = { ...next[idx], labels: fallbackLabels };
          break;
        }
      }
    });
    return next;
  } catch {
    return list;
  }
};

// Backfill the `from` address onto list messages that arrived without one,
// same cache-lookup strategy as mergeMissingLabels.
export const mergeMissingFrom = async (bulkGet: MessageBulkGet, account, list = []) => {
  try {
    const lookup = [];
    const indices = [];
    const fallbackKeys = [];
    const fallbackIndex = new Map();
    list.forEach((msg, idx) => {
      if (!hasFromValue(msg?.from)) {
        lookup.push([account, msg.id]);
        indices.push(idx);
      }
    });
    if (!lookup.length) return list;
    const existing = await bulkGet(lookup);
    indices.forEach((msgIdx) => {
      const msg = list[msgIdx] || {};
      const id = msg?.id;
      const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
      for (const candidate of candidates) {
        if (candidate === id) continue;
        fallbackIndex.set(`${msgIdx}:${candidate}`, fallbackKeys.length);
        fallbackKeys.push([account, candidate]);
      }
    });
    const fallbackRecords = fallbackKeys.length ? await bulkGet(fallbackKeys) : [];
    if (!existing?.length) return list;
    const next = list.slice();
    existing.forEach((record, i) => {
      const idx = indices[i];
      if (idx === undefined) return;
      if (hasFromValue(record?.from)) {
        next[idx] = { ...next[idx], from: record.from };
        return;
      }
      const msg = list[idx] || {};
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
    return next;
  } catch {
    return list;
  }
};

// --- loadMessages server-response interpretation (#3 extraction, slice 1) ----
// These three pin the stage of loadMessages that turns a raw page response
// (from the sync worker or the main-thread Remote call) into the store's
// message shape. The per-message mapping was previously duplicated verbatim
// between the preview fetch and the main fetch.

// True when a response carries no page of messages: the worker sets a
// `noContent` flag; the main-thread Remote call returns a null body.
export const isNoContentResponse = (source: string, res): boolean =>
  (source === 'worker' && Boolean(res?.noContent)) || (source === 'main' && res == null);

// Pull the message array out of a response. The worker wraps it as
// `{ messages }`; the main-thread call returns the raw API envelope
// (`Result.List` | `Result` | the array itself). ALWAYS returns an array: a
// truthy non-array body (a malformed/unexpected response) is coerced to [] so
// the main-path `for...of` can't throw on it. This removes an asymmetry — the
// preview path already guarded with Array.isArray and the hasMore calc already
// treats a non-array as length 0, but the main loop iterated `list` blind.
export const extractMessageList = (source: string, res) => {
  const list =
    source === 'worker' ? res?.messages || [] : res?.Result?.List || res?.Result || res || [];
  return Array.isArray(list) ? list : [];
};

// Map one raw server/worker message into the shape the message-list store
// holds: normalize it (unless it's already a cached record carrying `account`),
// then layer the threading fields with their header fallbacks. Returns null for
// a record with no id (the caller skips it). The subject normalizer is injected
// so the store's shared memoized instance — and its cache — is reused.
export const mapServerMessage = (
  raw,
  folder: string,
  account: string,
  normalizeSubject: (subject: string) => string,
) => {
  const normalized = raw?.account ? raw : normalizeMessageForCache(raw, folder, account);
  if (!normalized?.id) return null;
  return {
    ...normalized,
    normalizedSubject: normalized.normalizedSubject || normalizeSubject(normalized.subject),
    pending: false,
    threadId: raw.threadId || raw.ThreadId || raw.thread_id || normalized.thread_id,
    in_reply_to:
      normalized.in_reply_to ||
      raw.in_reply_to ||
      raw.inReplyTo ||
      raw['In-Reply-To'] ||
      raw?.nodemailer?.headers?.['in-reply-to'] ||
      raw?.nodemailer?.headers?.['In-Reply-To'] ||
      null,
    references:
      normalized.references ||
      raw.references ||
      raw.References ||
      raw?.nodemailer?.headers?.references ||
      raw?.nodemailer?.headers?.References ||
      null,
  };
};

// --- loadMessages request identity (#3 extraction, slice a) ------------------

// Map the UI sort order to the API's sort parameter.
export const sortParamForOrder = (order: string): string => {
  if (order === 'oldest') return 'date';
  if (order === 'newest') return '-date';
  if (order === 'subject') return 'subject';
  if (order === 'sender') return 'from';
  return '-date';
};

// Stable dedup identity for an in-flight message-list request. Every field that
// changes the response is included so a different query never dedups onto a
// stale in-flight request.
export const buildMessageListRequestKey = ({
  account,
  folder,
  page,
  limit,
  sort,
  query,
  unreadOnly,
  hasAttachmentsOnly,
}: {
  account: string;
  folder: string;
  page: number;
  limit: number;
  sort: string;
  query: string;
  unreadOnly: boolean;
  hasAttachmentsOnly: boolean;
}): string =>
  `${account}:${folder}:${page}:${limit}:${sort}:${query}:${unreadOnly}:${hasAttachmentsOnly}`;

// Build the /v1/messages query params. The filter flags are only included when
// set (the API treats absence as "no filter"); label filtering is client-side.
export const buildMessageListParams = ({
  folder,
  page,
  limit,
  query,
  unreadOnly,
  hasAttachmentsOnly,
}: {
  folder: string;
  page: number;
  limit: number;
  query: string;
  unreadOnly: boolean;
  hasAttachmentsOnly: boolean;
}) => ({
  folder,
  page,
  limit,
  raw: false,
  attachments: false,
  // Use lightweight mode to skip expensive MIME rebuild + attachment fetching
  // on the server. Bodies/snippets are fetched on-demand when a message is opened.
  lightweight: true,
  ...(query ? { search: query } : {}),
  ...(unreadOnly ? { is_unread: true } : {}),
  ...(hasAttachmentsOnly ? { has_attachments: true } : {}),
});

// --- loadMessages keep/prune predicates + stale guard (#3 extraction, slices b+c) ---

// Whether to KEEP the cached messages instead of clearing them when the server
// returns an empty page. Guards a non-empty folder against a transient empty
// response (flaky backend / cold-start IDB read): only a basic page-1 request
// (no append, no query, no filters) that comes back empty *while we already
// have data* is ignored.
export const shouldKeepCacheOnEmpty = ({
  shouldAppend,
  page,
  query,
  unreadOnly,
  hasAttachmentsOnly,
  mergedLength,
  cachedCount,
  storeCount,
}: {
  shouldAppend: boolean;
  page: number;
  query: string;
  unreadOnly: boolean;
  hasAttachmentsOnly: boolean;
  mergedLength: number;
  cachedCount: number;
  storeCount: number;
}): boolean => {
  const isBasicPage1 = !shouldAppend && page === 1 && !query && !unreadOnly && !hasAttachmentsOnly;
  const hasExistingData = cachedCount > 0 || storeCount > 0;
  return isBasicPage1 && mergedLength === 0 && hasExistingData;
};

// Which locally-cached message ids to prune after a fresh server page: those no
// longer on the server AND not optimistically deleted AND not in the offline
// mutation queue (so an in-flight move/label isn't clobbered). Pure over the
// three id sets.
export const computePrunedIds = (
  cachedPage: Array<{ id?: unknown }>,
  {
    serverIds,
    pendingIds,
    queuedIds,
  }: { serverIds: Set<unknown>; pendingIds: Set<unknown>; queuedIds: Set<unknown> },
): string[] =>
  cachedPage
    .filter(
      (msg) =>
        msg?.id && !serverIds.has(msg.id) && !pendingIds.has(msg.id) && !queuedIds.has(msg.id),
    )
    .map((msg) => msg.id as string);

// True when an awaited response no longer matches the live view: the account
// switched, the folder changed, or a newer request superseded this one. Used
// identically in loadMessages' success and error paths.
export const isStaleListRequest = ({
  activeAccount,
  account,
  activeFolder,
  folder,
  inFlightKey,
  requestKey,
}: {
  activeAccount: string;
  account: string;
  activeFolder: string | undefined;
  folder: string | undefined;
  inFlightKey: string | undefined;
  requestKey: string;
}): boolean =>
  activeAccount !== account ||
  activeFolder?.toUpperCase() !== folder?.toUpperCase() ||
  inFlightKey !== requestKey;
