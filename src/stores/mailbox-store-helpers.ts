// Pure helpers extracted from mailboxStore.ts so they can be unit-tested
// without loading the store's I/O graph (Dexie/db, sync worker, Remote, other
// stores). These are message-identity / list-merge / value-coercion helpers
// with no module state and no side effects. Anything touching db/Remote/stores
// (e.g. mergeMissingLabels/mergeMissingAddressFields) stays in mailboxStore.ts.
//
// Params are intentionally left loosely typed to match the originals verbatim
// (mailboxStore.ts is pervasively untyped) — this is a behavior-preserving
// extraction, not a retype. eslint forbids explicit `any`, so the dynamic
// response/record params below are left untyped (implicit any) like the rest.

import { hasDeletedFlag, normalizeMessageForCache } from '../utils/sync-helpers';
import { lightweightListSupported } from '../utils/api-capabilities';

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

export const hasFromValue = (value) =>
  (typeof value === 'string' && value.trim().length > 0) ||
  (Array.isArray(value) && value.length > 0);

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
// derivable key are always kept (can't dedup what we can't identify). When a
// key is in both, the incoming copy replaces the existing one in place: it is
// the newer server state (flags, labels) of the same message.
//
// `max` (optional, >0): bound the merged result to its last `max` entries by
// dropping from the HEAD. Infinite scroll appends older pages at the tail, so
// the head holds rows the user has scrolled well past; capping the live window
// keeps the in-memory array — and the DOM rows derived from it — from growing
// for the entire life of a folder session. The dropped head is restored by any
// page-1 replace-load (folder reselect, refresh, filter change). `max <= 0`
// (the default) means no cap.
export const mergeMessagePages = <T>(existing: T[] = [], incoming: T[] = [], max = 0): T[] => {
  const merged: T[] = [];
  const positions = new Map();
  const append = (list: T[], replace: boolean) => {
    (list || []).forEach((msg) => {
      const key = getMessageKey(msg);
      if (key == null) {
        merged.push(msg);
        return;
      }
      if (positions.has(key)) {
        if (replace) merged[positions.get(key)] = msg;
        return;
      }
      positions.set(key, merged.length);
      merged.push(msg);
    });
  };
  append(existing, false);
  append(incoming, true);
  if (max > 0 && merged.length > max) {
    return merged.slice(-max);
  }
  return merged;
};

/**
 * Merge a fresh first page into a list that holds several pages.
 *
 * Rows of the old list up to the last row of the fresh page are the same
 * window of the folder, so a row there that the fresh page lacks was deleted
 * or moved elsewhere and is dropped (`removed`). Rows past the window are
 * kept. When the fresh page holds the whole folder (`complete`), or its last
 * row is not in the old list (many new messages arrived), the fresh page
 * replaces the list (`replaced`) and the caller resets paging; in the second
 * case nothing counts as removed.
 */
export const mergeHeadPage = <T extends object>(
  existing: T[] = [],
  incoming: T[] = [],
  { complete = false } = {},
): { messages: T[]; removed: T[]; replaced: boolean } => {
  const lastKey = incoming.length ? getMessageKey(incoming[incoming.length - 1]) : null;
  const boundary =
    complete || lastKey == null ? -1 : existing.findIndex((m) => getMessageKey(m) === lastKey);
  const incomingKeys = new Set(incoming.map(getMessageKey).filter((key) => key != null));
  const notIncoming = (msg: T) => {
    const key = getMessageKey(msg);
    return key != null && !incomingKeys.has(key);
  };
  if (complete) {
    return { messages: incoming, removed: existing.filter(notIncoming), replaced: true };
  }
  // Without the boundary the old rows cannot be placed: they may be deleted
  // or only pushed past the first page, so none counts as removed.
  if (boundary === -1) return { messages: incoming, removed: [], replaced: true };

  const tail = existing.slice(boundary + 1).filter((msg) => {
    const key = getMessageKey(msg);
    return key == null || !incomingKeys.has(key);
  });
  return {
    messages: [...incoming, ...tail],
    removed: existing.slice(0, boundary + 1).filter(notIncoming),
    replaced: false,
  };
};

// IMAP mailbox names are case-sensitive except INBOX.
export const sameFolderPath = (a: unknown, b: unknown) => {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left === right || (left.toUpperCase() === 'INBOX' && right.toUpperCase() === 'INBOX');
};

// Locate the messages a realtime event names: by server id anywhere, or by
// IMAP UID within the event's folder. UIDs are per folder, so without a folder
// only ids can match.
export const matchesRemoteMessage = (
  msg: { folder?: unknown; id?: unknown; uid?: unknown; Uid?: unknown } | null | undefined,
  { folder = '', uids, ids }: { folder?: string; uids?: Set<number>; ids?: Set<string> },
) => {
  if (!msg) return false;
  const inFolder = !folder || sameFolderPath(msg.folder, folder);
  if (!inFolder) return false;
  if (ids?.size && msg.id != null && ids.has(String(msg.id))) return true;
  if (!folder || !uids?.size) return false;
  const uid = Number(msg.uid ?? msg.Uid);
  return Number.isSafeInteger(uid) && uids.has(uid);
};

// Apply an IMAP flag change (add/remove/set) to a cached message, keeping the
// derived booleans the list and counts read in step with the flag list.
type FlagFields = {
  flags?: unknown;
  is_unread?: unknown;
  is_unread_index?: unknown;
  is_starred?: unknown;
  is_answered?: unknown;
};

export const applyRemoteFlagChange = <T extends object>(
  input: T,
  action: string,
  flags: string[],
): T => {
  const msg = input as T & FlagFields;
  const current = Array.isArray(msg?.flags) ? (msg.flags as unknown[]).map(String) : [];
  const lower = new Set(flags.map((flag) => flag.toLowerCase()));
  let next: string[];
  if (action === 'set') next = [...flags];
  else if (action === 'add') {
    const have = new Set(current.map((flag) => flag.toLowerCase()));
    next = [...current, ...flags.filter((flag) => !have.has(flag.toLowerCase()))];
  } else if (action === 'remove') next = current.filter((flag) => !lower.has(flag.toLowerCase()));
  else return msg;

  const has = (name: string) => next.some((flag) => flag.toLowerCase() === name);
  const isUnread = !has('\\seen');
  const isStarred = has('\\flagged');
  const updated = {
    ...msg,
    flags: next,
    is_unread: isUnread,
    is_unread_index: isUnread && !hasDeletedFlag(next) ? 1 : 0,
    is_starred: isStarred,
    is_flagged: isStarred,
    is_answered: has('\\answered'),
  };
  const same =
    current.length === next.length &&
    current.every((flag, idx) => flag === next[idx]) &&
    msg.is_unread === updated.is_unread &&
    msg.is_unread_index === updated.is_unread_index &&
    msg.is_starred === updated.is_starred &&
    msg.is_answered === updated.is_answered;
  return same ? msg : (updated as T);
};

// Apply a label change (add/remove/set) the same way.
export const applyRemoteLabelChange = <T extends object>(
  input: T,
  action: string,
  labels: string[],
): T => {
  const msg = input as T & { labels?: unknown };
  const current = coerceLabelList(msg?.labels);
  let next: string[];
  if (action === 'set') next = [...labels];
  else if (action === 'add') next = [...current, ...labels.filter((l) => !current.includes(l))];
  else if (action === 'remove') next = current.filter((l) => !labels.includes(l));
  else return msg;
  const same = current.length === next.length && current.every((l, idx) => l === next[idx]);
  return same ? msg : { ...msg, labels: next };
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
    // labelPresence says which messages came with their labels from the
    // server (an empty list included); only the others take them from the cache
    list.forEach((msg, idx) => {
      if (!labelPresence[idx]) {
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

// Address fields backfilled from the cache, in the order the reader needs them.
// `from` drives the list row; `to`/`cc` drive the reader's recipient lines,
// which read straight off the list record (MessageTab's toDisplay/ccDisplay), so
// a record missing them renders "To:" with nothing after it.
const BACKFILLED_ADDRESS_FIELDS = ['from', 'to', 'cc'] as const;

// The lightweight list leaves out In-Reply-To and References too. Without the
// backfill, every refresh wrote nulls over headers the cache already had (from
// an older full list or an opened message), which split threads apart.
const BACKFILLED_FIELDS = [...BACKFILLED_ADDRESS_FIELDS, 'in_reply_to', 'references'] as const;

// Backfill missing address and threading fields onto list messages by reading
// the cached copy from IndexedDB, same cache-lookup strategy as mergeMissingLabels. A message
// is looked up when ANY of the address fields is absent, and each field is
// filled independently, so a response that carries `from` but no `to` still
// gets its recipients back.
export const mergeMissingAddressFields = async (bulkGet: MessageBulkGet, account, list = []) => {
  try {
    const lookup = [];
    const indices = [];
    const fallbackKeys = [];
    const fallbackIndex = new Map();
    list.forEach((msg, idx) => {
      if (BACKFILLED_FIELDS.some((field) => !hasFromValue(msg?.[field]))) {
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
      const msg = list[idx] || {};
      // Alternate-identifier record, resolved lazily: only messages whose
      // primary-key lookup came up short need it.
      let fallbackRecord;
      const readFallback = () => {
        if (fallbackRecord !== undefined) return fallbackRecord;
        fallbackRecord = null;
        const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
        for (const candidate of candidates) {
          const key = `${idx}:${candidate}`;
          if (!fallbackIndex.has(key)) continue;
          const found = fallbackRecords[fallbackIndex.get(key)];
          if (found) {
            fallbackRecord = found;
            break;
          }
        }
        return fallbackRecord;
      };

      const patch = {};
      for (const field of BACKFILLED_FIELDS) {
        if (hasFromValue(next[idx]?.[field])) continue;
        if (hasFromValue(record?.[field])) {
          patch[field] = record[field];
          continue;
        }
        const fallback = readFallback();
        if (hasFromValue(fallback?.[field])) patch[field] = fallback[field];
      }
      if (Object.keys(patch).length) next[idx] = { ...next[idx], ...patch };
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
  // on the server. Bodies/snippets are fetched on-demand when a message is
  // opened. Only sent while this server is known to include From/To/Cc on
  // lightweight responses, since otherwise every row renders without a sender.
  ...(lightweightListSupported() ? { lightweight: true } : {}),
  ...(query ? { search: query } : {}),
  ...(unreadOnly ? { is_unread: true } : {}),
  ...(hasAttachmentsOnly ? { has_attachments: true } : {}),
});

// A capability verdict can only be learned after the first lightweight page
// returns. Do not commit that known-bad page to the store and wait for a later
// refresh: retry the same request immediately without the query option. Because
// the returned params no longer include `lightweight`, this cannot recurse.
export const getNonLightweightRetryParams = (
  params: Record<string, unknown>,
  messages: Array<{ from?: unknown }> = [],
) => {
  if (params.lightweight !== true || messages.length === 0) {
    return null;
  }
  if (messages.some((message) => hasFromValue(message?.from))) return null;
  const retryParams = { ...params };
  delete retryParams.lightweight;
  return retryParams;
};

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

/**
 * Walk every page of a folder listing and return the union of what the server
 * lists and what was already cached.
 *
 * Emptying a folder cannot work off the cache alone: the cache only holds the
 * pages that have been opened, so a Trash holding thousands of messages would
 * lose a couple of hundred and report success. `complete` is false when the
 * walk was cut short — by a failed page or the page cap — so the caller can
 * say the folder is not actually empty instead of claiming it is.
 */
export const collectFolderMessages = async ({
  fetchPage,
  cached = [],
  maxPages = 400,
}: {
  fetchPage: (page: number) => Promise<Record<string, unknown>[]>;
  cached?: Record<string, unknown>[];
  /** Request size; accepted for callers, not used to decide when to stop. */
  pageSize?: number;
  maxPages?: number;
}): Promise<{ messages: Record<string, unknown>[]; complete: boolean }> => {
  const byId = new Map<string, Record<string, unknown>>();
  for (const msg of cached || []) {
    const id = String(msg?.id ?? '');
    if (id) byId.set(id, msg);
  }

  for (let page = 1; page <= maxPages; page++) {
    let list: Record<string, unknown>[];
    try {
      list = (await fetchPage(page)) || [];
    } catch {
      return { messages: [...byId.values()], complete: false };
    }
    if (!list.length) return { messages: [...byId.values()], complete: true };
    for (const raw of list) {
      const id = String(raw?.id ?? raw?._id ?? '');
      if (id) byId.set(id, { ...(byId.get(id) || {}), ...raw, id });
    }
    // Keep going until a page comes back empty. A short page is not proof
    // the folder is exhausted: the API's pagination middleware clamps `limit`
    // to its own maximum, so a request for 250 can legitimately return fewer
    // with plenty left. Treating that as the end is exactly the silent
    // partial-empty this helper exists to prevent. Costs one extra request.
  }
  return { messages: [...byId.values()], complete: false };
};

// Undo one queued flag or label change that failed for good, on the row as it
// is now. Only what that change touched is put back, so a later change to the
// same message (a star after the read, another label) survives. Returns the
// row unchanged when the message no longer shows the failed change, since
// something newer has already replaced it.
export const revertFlagChange = <T extends Record<string, unknown>>(
  row: T,
  type: string,
  payload: {
    isUnread?: boolean;
    isStarred?: boolean;
    labels?: unknown[];
    previousLabels?: unknown[];
  },
): T => {
  if (!row) return row;
  const flags = Array.isArray(row.flags) ? (row.flags as string[]) : [];
  const withFlag = (flag: string, on: boolean) =>
    on ? (flags.includes(flag) ? flags : [...flags, flag]) : flags.filter((f) => f !== flag);

  if (type === 'toggleRead' && typeof payload.isUnread === 'boolean') {
    const wasUnread = payload.isUnread;
    if (Boolean(row.is_unread) === wasUnread) return row;
    return {
      ...row,
      is_unread: wasUnread,
      is_unread_index: wasUnread ? 1 : 0,
      flags: withFlag('\\Seen', !wasUnread),
    };
  }

  if (type === 'toggleStar' && typeof payload.isStarred === 'boolean') {
    const wasStarred = payload.isStarred;
    if (Boolean(row.is_starred) === wasStarred) return row;
    return { ...row, is_starred: wasStarred, flags: withFlag('\\Flagged', wasStarred) };
  }

  if (type === 'label' && Array.isArray(payload.previousLabels)) {
    const before = payload.previousLabels.map(String);
    const after = Array.isArray(payload.labels) ? payload.labels.map(String) : [];
    const added = after.filter((l) => !before.includes(l));
    const removed = before.filter((l) => !after.includes(l));
    const current = Array.isArray(row.labels) ? (row.labels as unknown[]).map(String) : [];
    const next = current.filter((l) => !added.includes(l));
    for (const l of removed) if (!next.includes(l)) next.push(l);
    if (next.length === current.length && next.every((l, i) => l === current[i])) return row;
    return { ...row, labels: next };
  }

  return row;
};

// Fields a row's rendering, threading or realtime handling reads. Two copies
// of a message that agree on all of them are interchangeable on screen.
const ROW_FIELDS = [
  'id',
  'uid',
  'folder',
  'is_unread',
  'is_starred',
  'is_answered',
  'is_flagged',
  'flags',
  'labels',
  'subject',
  'snippet',
  'from',
  'to',
  'cc',
  'date',
  'dateMs',
  'has_attachment',
  'thread_id',
  'in_reply_to',
  'references',
  'message_id',
  'header_message_id',
] as const;

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
};

/**
 * Keeps the previous object for every row whose fields above did not change,
 * and the previous array when nothing changed at all. A refresh builds new
 * row objects from the cache or the network even when the mail is the same,
 * and new objects re-render every row (and regroup every conversation) on
 * each WebSocket event and sync.
 */
export const reuseUnchangedRows = <M extends object>(prev: M[], next: M[]): M[] => {
  if (!Array.isArray(prev) || !prev.length || !Array.isArray(next)) return next;
  const byId = new Map<unknown, M>();
  for (const row of prev) byId.set((row as { id?: unknown }).id, row);
  let allSame = prev.length === next.length;
  const out = next.map((row, idx) => {
    const old = byId.get((row as { id?: unknown }).id);
    const keep =
      old &&
      (old === row ||
        ROW_FIELDS.every((f) =>
          sameValue((old as Record<string, unknown>)[f], (row as Record<string, unknown>)[f]),
        ));
    const chosen = keep ? old : row;
    if (chosen !== prev[idx]) allSame = false;
    return chosen;
  });
  return allSame ? prev : out;
};

/** True when a rebuilt reply index has the same targets and reply ids. */
export const sameReplyIndex = (
  prevTargets: Set<unknown>,
  prevIndex: Map<unknown, unknown>,
  targets: Set<unknown>,
  index: Map<unknown, unknown>,
) => {
  if (prevTargets.size !== targets.size || prevIndex.size !== index.size) return false;
  for (const t of targets) if (!prevTargets.has(t)) return false;
  const ids = (list: unknown) =>
    (Array.isArray(list) ? list : [])
      .map((m) => String((m as { id?: unknown })?.id ?? ''))
      .join(',');
  for (const [key, list] of index) {
    if (!prevIndex.has(key) || ids(prevIndex.get(key)) !== ids(list)) return false;
  }
  return true;
};
