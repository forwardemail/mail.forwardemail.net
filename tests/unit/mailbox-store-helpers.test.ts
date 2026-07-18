import { describe, expect, it, vi } from 'vitest';
import {
  isValidDexieKeyFallback,
  coerceLabelList,
  hasFromValue,
  getMessageKey,
  mergeMessagePages,
  mergeMissingLabels,
  mergeMissingFrom,
  resolveHasMoreAfterFetch,
  isNoContentResponse,
  extractMessageList,
  mapServerMessage,
  sortParamForOrder,
  buildMessageListRequestKey,
  buildMessageListParams,
  shouldKeepCacheOnEmpty,
  computePrunedIds,
  isStaleListRequest,
} from '../../src/stores/mailbox-store-helpers';

// Mock bulkGet: returns the cached record for each [account, key] tuple in the
// same order as the keys (Dexie's bulkGet contract), undefined when absent.
const mockBulkGet = (records: Record<string, unknown>) =>
  vi.fn((keys: unknown[]) =>
    Promise.resolve((keys as [string, string][]).map(([, key]) => records[key])),
  );

describe('isValidDexieKeyFallback', () => {
  it('accepts strings, finite numbers, and Dates', () => {
    expect(isValidDexieKeyFallback('abc')).toBe(true);
    expect(isValidDexieKeyFallback('')).toBe(true);
    expect(isValidDexieKeyFallback(0)).toBe(true);
    expect(isValidDexieKeyFallback(-1)).toBe(true);
    expect(isValidDexieKeyFallback(1.5)).toBe(true);
    expect(isValidDexieKeyFallback(new Date())).toBe(true);
  });

  it('rejects null/undefined, non-finite numbers, booleans, and plain objects', () => {
    expect(isValidDexieKeyFallback(null)).toBe(false);
    expect(isValidDexieKeyFallback(undefined)).toBe(false);
    expect(isValidDexieKeyFallback(NaN)).toBe(false);
    expect(isValidDexieKeyFallback(Infinity)).toBe(false);
    expect(isValidDexieKeyFallback(true)).toBe(false);
    expect(isValidDexieKeyFallback({})).toBe(false);
  });

  it('validates arrays recursively (compound keys)', () => {
    expect(isValidDexieKeyFallback(['account', 123])).toBe(true);
    expect(isValidDexieKeyFallback([])).toBe(true); // [].every === true
    expect(isValidDexieKeyFallback(['account', null])).toBe(false);
    expect(isValidDexieKeyFallback(['account', ['nested', 1]])).toBe(true);
    expect(isValidDexieKeyFallback(['account', NaN])).toBe(false);
  });
});

describe('coerceLabelList', () => {
  it('trims and filters an array of labels', () => {
    expect(coerceLabelList([' Work ', 'Home', ''])).toEqual(['Work', 'Home']);
  });

  it('splits a comma-separated string', () => {
    expect(coerceLabelList('Work, Home ,, Travel')).toEqual(['Work', 'Home', 'Travel']);
  });

  it('drops the literal "[]" placeholder (any inner whitespace)', () => {
    expect(coerceLabelList(['[]', '[ ]', 'Work'])).toEqual(['Work']);
    expect(coerceLabelList('[]')).toEqual([]);
  });

  it('coerces non-string array entries and drops null/empty', () => {
    expect(coerceLabelList([5, null, undefined, 'ok'])).toEqual(['5', 'ok']);
  });

  it('returns [] for non-array/non-string input', () => {
    expect(coerceLabelList(null)).toEqual([]);
    expect(coerceLabelList(undefined)).toEqual([]);
    expect(coerceLabelList(42)).toEqual([]);
    expect(coerceLabelList({})).toEqual([]);
  });
});

describe('hasFromValue', () => {
  it('is true only for a non-blank string', () => {
    expect(hasFromValue('a@b.com')).toBe(true);
    expect(hasFromValue('   x  ')).toBe(true);
  });

  it('is false for blank strings and non-strings', () => {
    expect(hasFromValue('')).toBe(false);
    expect(hasFromValue('   ')).toBe(false);
    expect(hasFromValue(null)).toBe(false);
    expect(hasFromValue(undefined)).toBe(false);
    expect(hasFromValue(123)).toBe(false);
  });
});

describe('getMessageKey', () => {
  it('prefers id, then uid/Uid/uidnext', () => {
    expect(getMessageKey({ id: 'a', uid: 'b' })).toBe('a');
    expect(getMessageKey({ uid: 'b' })).toBe('b');
    expect(getMessageKey({ Uid: 'c' })).toBe('c');
    expect(getMessageKey({ uidnext: 'd' })).toBe('d');
  });

  it('treats id 0 as a real key (nullish, not falsy, semantics)', () => {
    expect(getMessageKey({ id: 0 })).toBe(0);
  });

  it('falls back to folder-scoped Message-ID when no id/uid', () => {
    expect(getMessageKey({ message_id: '<x@host>', folder: 'INBOX' })).toBe('INBOX:<x@host>');
    expect(getMessageKey({ messageId: '<y@host>' })).toBe(':<y@host>'); // no folder
    expect(getMessageKey({ 'Message-ID': '<z@host>', folder: 'Sent' })).toBe('Sent:<z@host>');
    expect(getMessageKey({ header_message_id: '<h@host>', folder: 'A' })).toBe('A:<h@host>');
  });

  it('scopes Message-ID by folder so forwarded copies do not collapse', () => {
    const a = getMessageKey({ message_id: '<same@host>', folder: 'INBOX' });
    const b = getMessageKey({ message_id: '<same@host>', folder: 'Archive' });
    expect(a).not.toBe(b);
  });

  it('returns null when nothing identifies the message', () => {
    expect(getMessageKey({})).toBeNull();
    expect(getMessageKey(null)).toBeNull();
    expect(getMessageKey(undefined)).toBeNull();
  });
});

describe('mergeMessagePages', () => {
  it('concatenates with existing first, dropping incoming duplicates by key', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const incoming = [{ id: 'b' }, { id: 'c' }];
    expect(mergeMessagePages(existing, incoming)).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('keeps the existing copy when a key collides (first write wins)', () => {
    const existing = [{ id: 'a', from: 'old' }];
    const incoming = [{ id: 'a', from: 'new' }];
    expect(mergeMessagePages(existing, incoming)).toEqual([{ id: 'a', from: 'old' }]);
  });

  it('always keeps messages with no derivable key', () => {
    const a = { subject: 'one' };
    const b = { subject: 'two' };
    expect(mergeMessagePages([a], [b])).toEqual([a, b]);
  });

  it('dedups within a single page too', () => {
    expect(mergeMessagePages([{ id: 'a' }, { id: 'a' }], [])).toEqual([{ id: 'a' }]);
  });

  it('handles empty/omitted arguments', () => {
    expect(mergeMessagePages()).toEqual([]);
    expect(mergeMessagePages([], [])).toEqual([]);
    expect(mergeMessagePages([{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });

  it('does not cap when max is omitted or non-positive', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const incoming = [{ id: 'c' }, { id: 'd' }];
    const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    expect(mergeMessagePages(existing, incoming)).toEqual(all);
    expect(mergeMessagePages(existing, incoming, 0)).toEqual(all);
    expect(mergeMessagePages(existing, incoming, -5)).toEqual(all);
  });

  it('caps to the last `max` entries, dropping the head (newest, scrolled-past)', () => {
    // existing = pages already loaded (head), incoming = the page just scrolled
    // into view (tail). Capping keeps the tail window the user is looking at.
    const existing = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const incoming = [{ id: 'd' }, { id: 'e' }];
    expect(mergeMessagePages(existing, incoming, 2)).toEqual([{ id: 'd' }, { id: 'e' }]);
    expect(mergeMessagePages(existing, incoming, 4)).toEqual([
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e' },
    ]);
  });

  it('does not cap when the merged length is within max', () => {
    const existing = [{ id: 'a' }];
    const incoming = [{ id: 'b' }];
    expect(mergeMessagePages(existing, incoming, 5)).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('caps after de-duplication, not before', () => {
    // 'b' is a duplicate, so the deduped merge is [a, b, c] (length 3); a cap of
    // 2 then keeps the last two of the DEDUPED list.
    const existing = [{ id: 'a' }, { id: 'b' }];
    const incoming = [{ id: 'b' }, { id: 'c' }];
    expect(mergeMessagePages(existing, incoming, 2)).toEqual([{ id: 'b' }, { id: 'c' }]);
  });
});

describe('mergeMissingLabels', () => {
  it('does not hit the cache when every message has trusted labels', async () => {
    const bulkGet = mockBulkGet({});
    const list = [{ id: '1', labels: ['a'] }];
    const out = await mergeMissingLabels(bulkGet, 'acct', list, [true]);
    expect(out).toBe(list); // unchanged, same reference
    expect(bulkGet).not.toHaveBeenCalled();
  });

  it('backfills labels from the cached record (keyed by [account, id])', async () => {
    const bulkGet = mockBulkGet({ '1': { labels: ['work', 'home'] } });
    const out = await mergeMissingLabels(bulkGet, 'acct', [{ id: '1' }], [false]);
    expect(out).toEqual([{ id: '1', labels: ['work', 'home'] }]);
    expect(bulkGet).toHaveBeenCalledWith([['acct', '1']]);
  });

  it('falls back to an alternate identifier (uid) when the id record has no labels', async () => {
    const bulkGet = mockBulkGet({ '1': { labels: [] }, U1: { labels: ['fromUid'] } });
    const out = await mergeMissingLabels(bulkGet, 'acct', [{ id: '1', uid: 'U1' }], [false]);
    expect(out).toEqual([{ id: '1', uid: 'U1', labels: ['fromUid'] }]);
  });

  it('treats a falsy labelPresence as "incoming labels not authoritative" and prefers the cache', async () => {
    // labelPresence omitted -> [] -> every entry looked up; cache labels win.
    const bulkGet = mockBulkGet({ '1': { labels: ['cached'] } });
    const out = await mergeMissingLabels(bulkGet, 'acct', [{ id: '1', labels: ['incoming'] }]);
    expect(out).toEqual([{ id: '1', labels: ['cached'] }]);
  });

  it('leaves the message untouched when the cache has nothing useful', async () => {
    const bulkGet = mockBulkGet({}); // record undefined
    const out = await mergeMissingLabels(bulkGet, 'acct', [{ id: '1' }], [false]);
    expect(out).toEqual([{ id: '1' }]);
  });

  it('returns the original list on a bulkGet error', async () => {
    const bulkGet = vi.fn(() => Promise.reject(new Error('db dead')));
    const list = [{ id: '1' }];
    const out = await mergeMissingLabels(bulkGet, 'acct', list, [false]);
    expect(out).toBe(list);
  });

  it('only looks up the messages that are missing/untrusted labels', async () => {
    const bulkGet = mockBulkGet({ '2': { labels: ['x'] } });
    const list = [{ id: '1', labels: ['a'] }, { id: '2' }];
    const out = await mergeMissingLabels(bulkGet, 'acct', list, [true, false]);
    expect(out).toEqual([
      { id: '1', labels: ['a'] },
      { id: '2', labels: ['x'] },
    ]);
    expect(bulkGet).toHaveBeenCalledWith([['acct', '2']]); // not id '1'
  });
});

describe('mergeMissingFrom', () => {
  it('does not hit the cache when every message has a from', async () => {
    const bulkGet = mockBulkGet({});
    const list = [{ id: '1', from: 'a@b.com' }];
    const out = await mergeMissingFrom(bulkGet, 'acct', list);
    expect(out).toBe(list);
    expect(bulkGet).not.toHaveBeenCalled();
  });

  it('backfills from from the cached record', async () => {
    const bulkGet = mockBulkGet({ '1': { from: 'alice@x.com' } });
    const out = await mergeMissingFrom(bulkGet, 'acct', [{ id: '1', from: '' }]);
    expect(out).toEqual([{ id: '1', from: 'alice@x.com' }]);
  });

  it('falls back to an alternate identifier when the id record has no from', async () => {
    const bulkGet = mockBulkGet({ '1': { from: '   ' }, M1: { from: 'bob@x.com' } });
    const out = await mergeMissingFrom(bulkGet, 'acct', [{ id: '1', message_id: 'M1' }]);
    expect(out).toEqual([{ id: '1', message_id: 'M1', from: 'bob@x.com' }]);
  });

  it('returns the original list on a bulkGet error', async () => {
    const bulkGet = vi.fn(() => Promise.reject(new Error('db dead')));
    const list = [{ id: '1', from: '' }];
    const out = await mergeMissingFrom(bulkGet, 'acct', list);
    expect(out).toBe(list);
  });
});

describe('resolveHasMoreAfterFetch', () => {
  it('stops when the fetched page is empty (real end), even if serverTotal looks high', () => {
    // Empty-page guard wins — otherwise a stale-high serverTotal spins scroll
    // on endless empty fetches.
    expect(
      resolveHasMoreAfterFetch({
        source: 'worker',
        workerHasNextPage: true,
        listLength: 0,
        limit: 50,
        page: 3,
        serverTotal: 999,
      }),
    ).toBe(false);
  });

  it('keeps paging on a short first page when the server total has more (the ~47 bug)', () => {
    // 47 of a 50 limit would set hasNextPage=false on the per-source signal
    // alone; serverTotal=300 keeps scroll alive so the rest of the folder loads.
    expect(
      resolveHasMoreAfterFetch({
        source: 'worker',
        workerHasNextPage: false,
        listLength: 47,
        limit: 50,
        page: 1,
        serverTotal: 300,
      }),
    ).toBe(true);
  });

  it('stops on a short page when the server total agrees there is no more', () => {
    expect(
      resolveHasMoreAfterFetch({
        source: 'worker',
        workerHasNextPage: false,
        listLength: 47,
        limit: 50,
        page: 1,
        serverTotal: 47,
      }),
    ).toBe(false);
  });

  it('honors the per-source full-page signal when serverTotal is unknown', () => {
    // worker source: trust res.hasNextPage
    expect(
      resolveHasMoreAfterFetch({
        source: 'worker',
        workerHasNextPage: true,
        listLength: 50,
        limit: 50,
        page: 1,
        serverTotal: null,
      }),
    ).toBe(true);
    // main source: a full page (length >= limit) implies more
    expect(
      resolveHasMoreAfterFetch({
        source: 'main',
        listLength: 50,
        limit: 50,
        page: 1,
        serverTotal: null,
      }),
    ).toBe(true);
    // main source: a short page with no serverTotal stops
    expect(
      resolveHasMoreAfterFetch({
        source: 'main',
        listLength: 12,
        limit: 50,
        page: 1,
        serverTotal: null,
      }),
    ).toBe(false);
  });

  it('keeps paging mid-folder on a full page regardless of serverTotal', () => {
    expect(
      resolveHasMoreAfterFetch({
        source: 'main',
        listLength: 50,
        limit: 50,
        page: 2,
        serverTotal: 80,
      }),
    ).toBe(true);
  });
});

describe('isNoContentResponse', () => {
  it('flags a worker no-content response only via the flag', () => {
    expect(isNoContentResponse('worker', { noContent: true })).toBe(true);
    expect(isNoContentResponse('worker', { messages: [] })).toBe(false);
    expect(isNoContentResponse('worker', { noContent: false })).toBe(false);
    // a null worker body is NOT no-content (only the flag is)
    expect(isNoContentResponse('worker', null)).toBe(false);
  });

  it('flags a null/undefined main-thread body only', () => {
    expect(isNoContentResponse('main', null)).toBe(true);
    expect(isNoContentResponse('main', undefined)).toBe(true);
    expect(isNoContentResponse('main', {})).toBe(false);
    // the worker flag is not special-cased on the main path
    expect(isNoContentResponse('main', { noContent: true })).toBe(false);
  });
});

describe('extractMessageList', () => {
  it('reads the worker messages array', () => {
    expect(extractMessageList('worker', { messages: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(extractMessageList('worker', {})).toEqual([]);
  });

  it('reads the main-thread envelope in priority order (Result.List > Result > body)', () => {
    expect(extractMessageList('main', { Result: { List: [{ id: 1 }] } })).toEqual([{ id: 1 }]);
    expect(extractMessageList('main', { Result: [{ id: 2 }] })).toEqual([{ id: 2 }]);
    expect(extractMessageList('main', [{ id: 3 }])).toEqual([{ id: 3 }]);
    expect(extractMessageList('main', null)).toEqual([]);
  });

  it('coerces a truthy non-array (malformed) response to [] so the main loop never throws', () => {
    // Without coercion these return a non-array verbatim and loadMessages'
    // main-path `for (const m of list)` throws on it.
    expect(extractMessageList('main', { unexpected: 'shape' })).toEqual([]);
    expect(extractMessageList('main', { Result: { notAList: true } })).toEqual([]);
    expect(extractMessageList('worker', { messages: { not: 'an array' } })).toEqual([]);
  });
});

describe('mapServerMessage', () => {
  // Injected subject normalizer — distinct output so we can assert it ran.
  const ns = (s: string) => `norm:${s}`;

  it('returns null for a record with no id', () => {
    expect(mapServerMessage({ account: 'a', subject: 'x' }, 'INBOX', 'a', ns)).toBeNull();
  });

  it('uses an already-normalized record (carries account) as-is and layers fields', () => {
    const out = mapServerMessage(
      { account: 'a', id: '1', subject: 'Hi', thread_id: 't1' },
      'INBOX',
      'a',
      ns,
    );
    expect(out).toMatchObject({
      id: '1',
      subject: 'Hi',
      normalizedSubject: 'norm:Hi',
      pending: false,
      threadId: 't1',
      in_reply_to: null,
      references: null,
    });
  });

  it('keeps an existing normalizedSubject instead of recomputing', () => {
    const out = mapServerMessage(
      { account: 'a', id: '1', subject: 'Hi', normalizedSubject: 'precomputed' },
      'INBOX',
      'a',
      ns,
    );
    expect(out.normalizedSubject).toBe('precomputed');
  });

  it('prefers raw threadId aliases over normalized.thread_id', () => {
    const at = (raw: Record<string, unknown>) => mapServerMessage(raw, 'F', 'a', ns).threadId;
    expect(at({ account: 'a', id: '1', threadId: 'A', thread_id: 'B' })).toBe('A');
    expect(at({ account: 'a', id: '1', ThreadId: 'C', thread_id: 'B' })).toBe('C');
    expect(at({ account: 'a', id: '1', thread_id: 'B' })).toBe('B');
  });

  it('resolves in_reply_to through the full header fallback chain', () => {
    const ir = (raw: Record<string, unknown>) => mapServerMessage(raw, 'F', 'a', ns).in_reply_to;
    expect(ir({ account: 'a', id: '1', in_reply_to: 'norm', inReplyTo: 'x' })).toBe('norm');
    expect(ir({ account: 'a', id: '1', inReplyTo: 'camel' })).toBe('camel');
    expect(ir({ account: 'a', id: '1', 'In-Reply-To': 'hdr' })).toBe('hdr');
    expect(ir({ account: 'a', id: '1', nodemailer: { headers: { 'in-reply-to': 'nm' } } })).toBe(
      'nm',
    );
    expect(ir({ account: 'a', id: '1' })).toBeNull();
  });

  it('resolves references through the full header fallback chain', () => {
    const rf = (raw: Record<string, unknown>) => mapServerMessage(raw, 'F', 'a', ns).references;
    expect(rf({ account: 'a', id: '1', references: 'r' })).toBe('r');
    expect(rf({ account: 'a', id: '1', References: 'R' })).toBe('R');
    expect(rf({ account: 'a', id: '1', nodemailer: { headers: { references: 'nmr' } } })).toBe(
      'nmr',
    );
    expect(rf({ account: 'a', id: '1' })).toBeNull();
  });

  it('normalizes a raw (no account) record via normalizeMessageForCache', () => {
    // Delegates to the real normalizer (id derives from raw.id), then layers
    // the same fields — without coupling to the normalizer's full output.
    const out = mapServerMessage({ id: '99', subject: 'Raw', folder: 'INBOX' }, 'INBOX', 'a', ns);
    expect(out).not.toBeNull();
    expect(out.id).toBe('99');
    expect(out.pending).toBe(false);
  });
});

describe('sortParamForOrder', () => {
  it('maps each UI order to its API sort param', () => {
    expect(sortParamForOrder('oldest')).toBe('date');
    expect(sortParamForOrder('newest')).toBe('-date');
    expect(sortParamForOrder('subject')).toBe('subject');
    expect(sortParamForOrder('sender')).toBe('from');
  });

  it('defaults to newest-first (-date) for unknown/empty orders', () => {
    expect(sortParamForOrder('')).toBe('-date');
    expect(sortParamForOrder('whatever')).toBe('-date');
  });
});

describe('buildMessageListRequestKey', () => {
  const base = {
    account: 'a@b.com',
    folder: 'INBOX',
    page: 1,
    limit: 50,
    sort: '-date',
    query: '',
    unreadOnly: false,
    hasAttachmentsOnly: false,
  };

  it('joins every request-identifying field in a stable order', () => {
    expect(buildMessageListRequestKey(base)).toBe('a@b.com:INBOX:1:50:-date::false:false');
  });

  it('changes when any response-affecting field changes (no false dedup)', () => {
    const key = buildMessageListRequestKey(base);
    expect(buildMessageListRequestKey({ ...base, folder: 'Sent' })).not.toBe(key);
    expect(buildMessageListRequestKey({ ...base, page: 2 })).not.toBe(key);
    expect(buildMessageListRequestKey({ ...base, limit: 100 })).not.toBe(key);
    expect(buildMessageListRequestKey({ ...base, sort: 'subject' })).not.toBe(key);
    expect(buildMessageListRequestKey({ ...base, query: 'hi' })).not.toBe(key);
    expect(buildMessageListRequestKey({ ...base, unreadOnly: true })).not.toBe(key);
    expect(buildMessageListRequestKey({ ...base, hasAttachmentsOnly: true })).not.toBe(key);
  });
});

describe('buildMessageListParams', () => {
  const base = {
    folder: 'INBOX',
    page: 1,
    limit: 50,
    query: '',
    unreadOnly: false,
    hasAttachmentsOnly: false,
  };

  it('always includes the base params, with no filters by default', () => {
    expect(buildMessageListParams(base)).toEqual({
      folder: 'INBOX',
      page: 1,
      limit: 50,
      lightweight: true,
      raw: false,
      attachments: false,
    });
  });

  it('includes search only when query is non-empty', () => {
    expect(buildMessageListParams({ ...base, query: 'hello' })).toMatchObject({ search: 'hello' });
    expect('search' in buildMessageListParams(base)).toBe(false);
  });

  it('includes is_unread / has_attachments only when those flags are set', () => {
    expect(buildMessageListParams({ ...base, unreadOnly: true })).toMatchObject({
      is_unread: true,
    });
    expect(buildMessageListParams({ ...base, hasAttachmentsOnly: true })).toMatchObject({
      has_attachments: true,
    });
    const plain = buildMessageListParams(base);
    expect('is_unread' in plain).toBe(false);
    expect('has_attachments' in plain).toBe(false);
  });
});

describe('shouldKeepCacheOnEmpty', () => {
  const base = {
    shouldAppend: false,
    page: 1,
    query: '',
    unreadOnly: false,
    hasAttachmentsOnly: false,
    mergedLength: 0,
    cachedCount: 5,
    storeCount: 0,
  };

  it('keeps cache when a basic page-1 request returns empty but data exists', () => {
    expect(shouldKeepCacheOnEmpty(base)).toBe(true);
    // existing data may come from the store rather than the IDB cache
    expect(shouldKeepCacheOnEmpty({ ...base, cachedCount: 0, storeCount: 3 })).toBe(true);
  });

  it('does NOT keep cache when the server legitimately returns messages', () => {
    expect(shouldKeepCacheOnEmpty({ ...base, mergedLength: 10 })).toBe(false);
  });

  it('does NOT keep cache when there is no existing data to protect', () => {
    expect(shouldKeepCacheOnEmpty({ ...base, cachedCount: 0, storeCount: 0 })).toBe(false);
  });

  it('only applies to a basic page-1 request (append/later-page/query/filters opt out)', () => {
    expect(shouldKeepCacheOnEmpty({ ...base, shouldAppend: true })).toBe(false);
    expect(shouldKeepCacheOnEmpty({ ...base, page: 2 })).toBe(false);
    expect(shouldKeepCacheOnEmpty({ ...base, query: 'hi' })).toBe(false);
    expect(shouldKeepCacheOnEmpty({ ...base, unreadOnly: true })).toBe(false);
    expect(shouldKeepCacheOnEmpty({ ...base, hasAttachmentsOnly: true })).toBe(false);
  });
});

describe('computePrunedIds', () => {
  const page = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: undefined }];

  it('prunes cached ids that are absent from the server set', () => {
    expect(
      computePrunedIds(page, {
        serverIds: new Set(['a']),
        pendingIds: new Set(),
        queuedIds: new Set(),
      }),
    ).toEqual(['b', 'c']);
  });

  it('never prunes an optimistically-deleted (pending) id', () => {
    expect(
      computePrunedIds(page, {
        serverIds: new Set(['a']),
        pendingIds: new Set(['b']),
        queuedIds: new Set(),
      }),
    ).toEqual(['c']);
  });

  it('never prunes an id with a queued offline mutation', () => {
    expect(
      computePrunedIds(page, {
        serverIds: new Set(['a']),
        pendingIds: new Set(),
        queuedIds: new Set(['c']),
      }),
    ).toEqual(['b']);
  });

  it('ignores cache entries that have no id', () => {
    expect(
      computePrunedIds([{ id: undefined }], {
        serverIds: new Set(),
        pendingIds: new Set(),
        queuedIds: new Set(),
      }),
    ).toEqual([]);
  });
});

describe('isStaleListRequest', () => {
  const base = {
    activeAccount: 'a',
    account: 'a',
    activeFolder: 'INBOX',
    folder: 'INBOX',
    inFlightKey: 'k1',
    requestKey: 'k1',
  };

  it('is not stale when account, folder, and request key all still match', () => {
    expect(isStaleListRequest(base)).toBe(false);
  });

  it('is stale when the active account changed', () => {
    expect(isStaleListRequest({ ...base, activeAccount: 'b' })).toBe(true);
  });

  it('is stale on a folder change, but case differences alone are not stale', () => {
    expect(isStaleListRequest({ ...base, activeFolder: 'Sent' })).toBe(true);
    expect(isStaleListRequest({ ...base, activeFolder: 'inbox' })).toBe(false);
  });

  it('is stale when a newer request superseded this one (key mismatch)', () => {
    expect(isStaleListRequest({ ...base, inFlightKey: 'k2' })).toBe(true);
  });
});
