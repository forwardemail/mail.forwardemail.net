import { writable, get } from 'svelte/store';
import Dexie from 'dexie';
import { Remote } from '../utils/remote';
import { hasMorePages } from '../utils/pagination.js';
import { isDemoMode } from '../utils/demo-mode';
import { db } from '../utils/db';
import { Local } from '../utils/storage';
import { searchStore } from './searchStore';
import { cacheManager } from '../utils/cache-manager';
import { normalizeSubject, parseReferences } from '../utils/threading';
import { formatFriendlyDate } from '../utils/date';
import { normalizeMessageForCache, getMessageApiId } from '../utils/sync-helpers';
import { getSyncSettings } from '../utils/sync-settings';
import { sendSyncRequest, onSyncTaskComplete } from '../utils/sync-worker-client.js';
import { createPerfTracer } from '../utils/perf-logger.ts';
import { memoize } from '../utils/store-utils.ts';
import { getEffectiveSettingValue } from './settingsStore';
import { sortMessages, normalizeSortDate, getMessageUidValue } from '../utils/message-sort.ts';
import { decodeMimeHeader } from '../utils/mime-utils.js';
import { validateFolderName } from '../utils/folder-validation.ts';
import { queueMutation, getQueuedMessageIds } from '../utils/mutation-queue';
import { nextCandidate } from '../svelte/mailbox/utils/mailbox-helpers.js';
import { selectedConversation } from './mailboxActions';
import {
  folders,
  selectedFolder,
  expandedFolders,
  folderContextMenu,
  folderOperationInProgress,
} from './folderStore';
import {
  messages,
  selectedMessage,
  searchResults,
  searchActive,
  searching,
  loading,
  page,
  hasNextPage,
  messageBody,
  attachments,
  messageLoading,
  filteredMessages,
} from './messageStore';
import {
  threadingEnabled,
  sidebarOpen,
  showFilters,
  sortOrder,
  query,
  unreadOnly,
  hasAttachmentsOnly,
  filterByLabel,
  starredOnly,
} from './viewStore';
import {
  selectedConversationIds,
  selectedConversationCount,
  filteredConversations,
  replyTargets,
  replyMessageIndex,
} from './conversationStore';
import { effectiveLayoutMode } from './settingsStore';
import { normalizeLayoutMode } from './settingsRegistry';
import { warn } from '../utils/logger.ts';
import { folderMessageCache } from './folder-message-cache';
import { isOnline } from '../utils/network-status';
import { getAuthHeader } from '../utils/auth';
import {
  isValidDexieKeyFallback,
  coerceLabelList,
  mergeMessagePages,
  mergeMissingLabels,
  mergeMissingFrom,
  resolveHasMoreAfterFetch,
} from './mailbox-store-helpers';
import { createPendingDeleteTracker, createPendingFlagTracker } from './optimistic-trackers';

// Folders that are always protected from rename/delete
const ALWAYS_PROTECTED = new Set(['INBOX', 'OUTBOX']);

const EXPANDED_FOLDERS_KEY = 'folder_expansion_state';
const FOLDERS_CACHE_TTL = 15000;
const folderLoadState = new Map();

// Sliding-window cap for the live in-memory message list. Infinite scroll
// appends a page on every scroll-to-bottom (shouldAppend, below), so without a
// bound both the `messages` array and the rendered DOM rows grow for the entire
// life of a folder session — a real footprint creep on long-lived desktop
// sessions. 1000 rows (~50 default pages of 20) is far past any normal scroll
// while still bounding pathological sessions. Only the append path is capped;
// page-1 replace-loads (folder reselect, refresh, filter change) restore the
// full newest head.
const MAX_LIVE_MESSAGES = 1000;

// Optimistic-update trackers (pending deletes + flag mutations) live in
// optimistic-trackers.ts so their reconciliation logic can be unit-tested.
// Instantiated once here, then rebound to the original function names so every
// call site and the actions API stay unchanged.
const pendingDeleteTracker = createPendingDeleteTracker();
const addPendingDeletes = pendingDeleteTracker.add;
const filterPendingDeletes = pendingDeleteTracker.filter;
export const getPendingDeleteIds = pendingDeleteTracker.getIds;
const confirmDeletes = pendingDeleteTracker.confirm;

const pendingFlagTracker = createPendingFlagTracker();
const addPendingFlagMutation = pendingFlagTracker.add;
const applyPendingFlagMutations = pendingFlagTracker.apply;
const confirmFlagMutations = pendingFlagTracker.confirm;

const invalidateFolderInMemCache = (account, folder) => {
  const prefix = `${account}:${folder}:`;
  for (const key of folderMessageCache.keys()) {
    if (key.startsWith(prefix)) {
      folderMessageCache.delete(key);
    }
  }
};

const isMobileViewport = () => typeof window !== 'undefined' && window.innerWidth <= 900;

// IndexedDB reader injected into the mergeMissing* backfills (which live in
// mailbox-store-helpers so their logic can be unit-tested with a mock bulkGet).
const bulkGetMessages = (keys: unknown[]) => db.messages.bulkGet(keys as never);

const createMailboxStore = () => {
  // Track in-flight message list requests to prevent duplicates
  let inFlightMessageListRequest = null;
  let syncRefreshTimer = null;
  let lastSyncRefresh = { account: null, folder: null, at: 0 };
  const error = writable('');
  const toastsRef = writable(null);

  // Performance optimizations
  // Memoize subject normalization to avoid repeated regex operations
  const normalizeSubjectMemoized = memoize(normalizeSubject, 5000);

  const replyIndexState = new Map();
  const REPLY_INDEX_TTL = 60 * 1000;
  const REPLY_INDEX_LOOKBACK_DAYS = 30;

  // Helpers
  const formatDate = (value) => formatFriendlyDate(value);

  const getLimit = () => {
    // Fixed internal page size for infinite-scroll pagination. The user-facing
    // "messages per page" setting was removed in favor of infinite scroll on
    // every client; pages are an internal chunking detail now.
    const settings = getSyncSettings();
    return settings.pageSize || 50;
  };

  const selectFolder = (path) => {
    // Re-selecting the same folder clears active filters so the user isn't stuck
    const reselecting = get(selectedFolder) === path;
    if (reselecting) {
      query.set('');
      unreadOnly.set(false);
      hasAttachmentsOnly.set(false);
      starredOnly.set(false);
      filterByLabel.set([]);
      searchActive.set(false);
      searchResults.set([]);
    }

    selectedFolder.set(path);
    page.set(1);
    selectedConversationIds.set([]);
    selectedMessage.set(null);

    const effectiveQuery = buildSearchQuery(get(query) || '');
    if (effectiveQuery) {
      searchMessages(get(query) || '');
    } else {
      loadMessages();
    }
  };

  const selectMessage = (msg) => {
    selectedMessage.set(msg);
  };

  const buildSearchQuery = (rawTerm = '') => {
    const trimmed = String(rawTerm || '').trim();
    const parts = [];
    if (trimmed) parts.push(trimmed);
    if (get(unreadOnly)) parts.push('is:unread');
    if (get(hasAttachmentsOnly)) parts.push('has:attachment');
    if (get(starredOnly)) parts.push('is:starred');
    return parts.join(' ').trim();
  };

  const refreshReplyTargets = async ({ account: overrideAccount, force = false } = {}) => {
    const account = overrideAccount || Local.get('email') || 'default';
    const sentFolder = getSentFolderPath();
    if (!sentFolder) return;
    const now = Date.now();
    const state = replyIndexState.get(account) || { at: 0, folder: '' };
    if (!force && state.at && now - state.at < REPLY_INDEX_TTL && state.folder === sentFolder) {
      return;
    }
    replyIndexState.set(account, { at: now, folder: sentFolder });

    try {
      const since = now - REPLY_INDEX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      let sentMessages = await db.messages
        .where('[account+folder+date]')
        .between([account, sentFolder, since], [account, sentFolder, Dexie.maxKey], true, true)
        .toArray();

      // If no sent messages in IDB, bootstrap from API so the reply index
      // works even if the user has never opened the Sent folder.
      if (!sentMessages.length) {
        try {
          const res = await Remote.request(
            'MessageList',
            { folder: sentFolder, limit: 200 },
            { method: 'GET', pathOverride: '/v1/messages' },
          );
          const items = Array.isArray(res) ? res : res?.data || res?.messages || [];
          if (items.length) {
            const normalized = items.map((m) => normalizeMessageForCache(m, account, sentFolder));
            await db.messages.bulkPut(normalized).catch(() => {});
            sentMessages = normalized;
          }
        } catch (fetchErr) {
          warn('[replies] Failed to bootstrap sent messages from API', fetchErr);
        }
      }

      const targets = new Set();
      const index = new Map();
      sentMessages.forEach((msg) => {
        const inReplyTo = msg?.in_reply_to || msg?.inReplyTo || msg?.['In-Reply-To'];
        if (inReplyTo) {
          targets.add(inReplyTo);
          if (!index.has(inReplyTo)) index.set(inReplyTo, []);
          index.get(inReplyTo).push(msg);
        }
        const references = parseReferences(msg?.references || msg?.References);
        references.forEach((ref) => {
          targets.add(ref);
          if (!index.has(ref)) index.set(ref, []);
          index.get(ref).push(msg);
        });
      });
      replyTargets.set(targets);
      replyMessageIndex.set(index);
    } catch (err) {
      warn('[replies] Failed to build reply target index', err);
    }
  };

  // Stale-search guard — stops overlapping calls from flickering results.
  let searchMessagesGeneration = 0;
  const searchMessages = async (term) => {
    const rawTerm = term ?? '';
    const q = rawTerm.trim();
    const searchQuery = buildSearchQuery(q);
    query.set(rawTerm);
    const generation = ++searchMessagesGeneration;

    if (!searchQuery) {
      searchResults.set([]);
      searchActive.set(false);
      hasNextPage.set(true);
      page.set(1);
      await loadMessages();
      return;
    }

    searching.set(true);
    try {
      const folder = get(selectedFolder);
      const results =
        (await searchStore.actions.search(searchQuery, {
          folder,
          crossFolder: false,
          limit: 200,
          // Force indexed search across the folder, not just the visible page
          candidates: [],
        })) || [];

      if (generation !== searchMessagesGeneration) return;

      searchResults.set(results);
      searchActive.set(true);
      hasNextPage.set(false);

      const allowAutoSelect = !isMobileViewport();
      if (allowAutoSelect && results.length) {
        selectedMessage.set(results[0]);
      }
      if (!results.length) {
        selectedMessage.set(null);
      }
    } catch (err) {
      console.error('[mailboxStore] search failed', err);
      const toasts = get(toastsRef);
      toasts?.show?.('Search failed. Please try again.', 'error');
    } finally {
      if (generation === searchMessagesGeneration) searching.set(false);
    }
  };

  let suppressFilterSearch = true;
  const handleFilterChange = () => {
    if (suppressFilterSearch) return;
    searchMessages(get(query) || '');
  };
  unreadOnly.subscribe(handleFilterChange);
  hasAttachmentsOnly.subscribe(handleFilterChange);
  filterByLabel.subscribe(handleFilterChange);
  starredOnly.subscribe(handleFilterChange);
  Promise.resolve().then(() => {
    suppressFilterSearch = false;
  });

  const toggleConversationSelection = (item) => {
    const current = get(selectedConversationIds);
    if (!item?.id) return;
    const next = current.includes(item.id)
      ? current.filter((id) => id !== item.id)
      : current.concat(item.id);
    selectedConversationIds.set(next);
  };

  const selectAllVisible = () => {
    const list = get(filteredConversations);
    if (!list.length) return;
    const current = get(selectedConversationIds);
    const allSelected = list.every((c) => current.includes(c.id));
    selectedConversationIds.set(allSelected ? [] : list.map((c) => c.id));
  };

  const setSelectedIds = (ids = []) => {
    selectedConversationIds.set(Array.isArray(ids) ? ids : []);
  };

  const updateFolderUnreadCounts = async () => {
    // Demo mode is IndexedDB-free (WebKitGTK stalls IndexedDB under tauri://).
    // This recomputes per-folder counts via `await db.messages...count()`, which
    // would hang; demo folder badge counts are served by the demo Folders
    // interceptor (recomputeFolderCounts) instead, so skip the db recompute.
    if (isDemoMode()) return;
    try {
      const account = Local.get('email') || 'default';
      const currentFolders = get(folders);
      if (!currentFolders?.length) return;

      // Get unread counts per folder using indexed lookups
      const unreadCounts = new Map();

      for (const folder of currentFolders) {
        const path = folder?.path;
        if (!path || typeof path !== 'string') continue;
        try {
          const key = [account, path, 1];
          const isValidKey =
            typeof Dexie.isValidKey === 'function'
              ? Dexie.isValidKey(key)
              : isValidDexieKeyFallback(key);
          if (!isValidKey) continue;
          const count = await db.messages
            .where('[account+folder+is_unread_index]')
            .equals(key)
            .count();
          unreadCounts.set(path, count || 0);
        } catch (err) {
          warn('[mailboxStore] Failed to count unread messages', err);
        }
      }

      // Update folder counts
      const updatedFolders = currentFolders.map((folder) => {
        const computed = unreadCounts.has(folder.path)
          ? unreadCounts.get(folder.path)
          : folder.count || 0;
        const total = Number.isFinite(folder.totalCount) ? folder.totalCount : null;
        const next = total != null ? Math.min(computed, total) : computed;
        return { ...folder, count: next };
      });

      folders.set(updatedFolders);

      // Sync badge count to INBOX unread count
      const inbox = updatedFolders.find((f) => f.path?.toUpperCase?.() === 'INBOX');
      if (inbox && typeof inbox.count === 'number') {
        import('../utils/notification-manager.js')
          .then(({ setBadgeCount }) => setBadgeCount(inbox.count))
          .catch(() => {});
      }
    } catch (err) {
      warn('[mailboxStore] Failed to update folder unread counts', err);
    }
  };

  const loadFolders = async (options = {}) => {
    // Bail early when no credentials are available (e.g. on the login page).
    // Settings.svelte is always mounted and its currentAccount subscription
    // calls loadFolders() — without this guard it triggers sync-worker and
    // Remote.request errors because auth headers are missing.
    const hasAuth = !!getAuthHeader({ allowApiKey: true });
    if (!hasAuth) {
      return;
    }

    const account = Local.get('email') || 'default';
    const { force = false } = options;
    const state = folderLoadState.get(account) || { promise: null, lastFetchAt: 0 };
    if (state.promise) {
      return state.promise;
    }

    // Demo mode fast-path: serve folders straight from the synchronous demo
    // interceptor (Remote.request → getDemoData). Demo has no real IndexedDB
    // cache and the sync worker isn't demo-aware, so touching either only
    // risks a worker stall (DB_WORKER_INIT_TIMEOUT, seen on slow CI) — the
    // exact failure that left the demo sidebar with zero folders while
    // messages still rendered. Keep demo fully in-memory and worker-independent.
    if (isDemoMode()) {
      const demoPromise = (async () => {
        const res = await Remote.request('Folders', {}, { method: 'GET' });
        const raw = res?.Result || res || [];
        const list = Array.isArray(raw) ? raw : raw.Items || raw.items || [];
        const mapped = buildFolderList(list);
        folders.set(mapped);
        const currentFolder = get(selectedFolder);
        if ((!currentFolder || currentFolder === '') && mapped.length) {
          const inbox = mapped.find((f) => f.path?.toUpperCase?.() === 'INBOX');
          const defaultFolder = inbox?.path || mapped[0]?.path;
          if (defaultFolder) selectedFolder.set(defaultFolder);
        }
        updateFolderUnreadCounts();
        state.lastFetchAt = Date.now();
      })();
      state.promise = demoPromise;
      folderLoadState.set(account, state);
      try {
        return await demoPromise;
      } finally {
        state.promise = null;
        folderLoadState.set(account, state);
      }
    }

    if (!force && state.lastFetchAt && Date.now() - state.lastFetchAt < FOLDERS_CACHE_TTL) {
      // TTL still valid but store may be empty (blanked by resetMailboxStateForAccount)
      const currentFolders = get(folders);
      if (!currentFolders?.length) {
        // Hydrate from IndexedDB cache (~5ms local read, no network)
        const cached = await db.folders.where('account').equals(account).toArray();
        if (cached?.length) {
          const mappedCached = buildFolderList(cached);
          folders.set(mappedCached);
          // Only set default folder if none is currently selected
          const currentFolder = get(selectedFolder);
          if (!currentFolder || currentFolder === '') {
            const inbox = mappedCached.find((f) => f.path?.toUpperCase?.() === 'INBOX');
            const defaultFolder = inbox?.path || mappedCached[0]?.path;
            if (defaultFolder) {
              selectedFolder.set(defaultFolder);
            }
          }
        }
      }
      return;
    }

    const promise = (async () => {
      try {
        // cache first — IndexedDB is only a cache. A DB failure here (e.g. the
        // db worker times out / is mid-recovery: DB_WORKER_INIT_TIMEOUT) must
        // NOT abort the load. loadMessages already tolerates a dead cache and
        // falls through to the network/demo source; loadFolders must too,
        // otherwise a transient worker stall leaves the sidebar with zero
        // folders even though the list is available from the server (or, in
        // demo mode, the synchronous demo interceptor).
        let cached = [];
        try {
          cached = await db.folders.where('account').equals(account).toArray();
        } catch (cacheErr) {
          warn('loadFolders cache read failed; continuing to source', cacheErr);
        }
        if (cached?.length) {
          const mappedCached = buildFolderList(cached);
          folders.set(mappedCached);

          // Set default folder from cache if none selected
          const currentFolder = get(selectedFolder);
          if ((!currentFolder || currentFolder === '') && mappedCached.length) {
            const inbox = mappedCached.find((f) => f.path?.toUpperCase?.() === 'INBOX');
            const defaultFolder = inbox?.path || mappedCached[0]?.path;
            if (defaultFolder) {
              selectedFolder.set(defaultFolder);
            }
          }

          // Update unread counts from cached messages
          updateFolderUnreadCounts();
        }
        let list = null;
        try {
          const res = await sendSyncRequest('folders', { account });
          list = res?.folders || [];
        } catch {
          // Fallback to main thread fetch
          const res = await Remote.request(
            'Folders',
            {},
            { method: 'GET', pathOverride: '/v1/folders?limit=100', timeout: 120_000 },
          );
          const raw = res?.Result || res || [];
          list = Array.isArray(raw) ? raw : raw.Items || raw.items || [];

          // Use transaction for atomic folder cache update (fallback path only).
          // Persisting to cache is best-effort: if the db worker is down the
          // write will fail, but we already have `list` from the source and
          // must still render it — so a failed cache write must not abort.
          try {
            await db.transaction('rw', db.folders, async () => {
              await db.folders.where('account').equals(account).delete();
              await db.folders.bulkPut(
                list.map((f) => ({
                  ...f,
                  account,
                  updatedAt: Date.now(),
                })),
              );
            });
          } catch (writeErr) {
            warn('loadFolders cache write failed; continuing with in-memory list', writeErr);
          }
        }

        const mapped = buildFolderList(list || []);

        const activeNow = Local.get('email') || 'default';
        if (activeNow !== account) {
          throw new Error('account_switched');
        }

        folders.set(mapped);

        // Always set default folder to INBOX if no folder is selected
        const currentFolder = get(selectedFolder);
        if ((!currentFolder || currentFolder === '') && mapped.length) {
          const inbox = mapped.find((f) => f.path?.toUpperCase?.() === 'INBOX');
          const defaultFolder = inbox?.path || mapped[0]?.path;
          if (defaultFolder) {
            selectedFolder.set(defaultFolder);
          }
        }

        // Update unread counts from messages
        updateFolderUnreadCounts();
        state.lastFetchAt = Date.now();
      } catch (err) {
        if (err?.message === 'account_switched') {
          // Silently discard — caller will detect via generation check
          return;
        }
        warn('loadFolders failed', err);
        throw err;
      }
    })();

    state.promise = promise;
    folderLoadState.set(account, state);
    try {
      return await promise;
    } finally {
      state.promise = null;
      folderLoadState.set(account, state);
    }
  };

  const buildFolderList = (list = []) => {
    const readNumber = (value) => {
      if (value == null || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const mapped = list.map((f) => {
      const path = f.path || f.Name || f.name || f.fullName || f.fullname || '';
      const depth =
        typeof f.level === 'number'
          ? f.level
          : typeof f.Level === 'number'
            ? f.Level
            : Math.max(0, path.split('/').filter(Boolean).length - 1);
      const unreadRaw =
        f.unread ??
        f.unread_count ??
        f.unreadCount ??
        f.unseen ??
        f.unseen_count ??
        f.unseenCount ??
        null;
      const unreadCount = readNumber(unreadRaw);
      const totalCount = readNumber(f.total ?? f.messages ?? f.message_count ?? f.count);

      return {
        id: f.id || f._id || f.folder_id || f.uid || f.uidnext || f.uidvalidity || f.uid_validity,
        path,
        name: f.name || f.path || f.fullName || f.fullname,
        icon: f.icon || f.Icon || f.path?.toLowerCase?.() || 'folder',
        level: depth,
        count: unreadCount ?? 0,
        totalCount,
        countSource: unreadCount !== null ? 'server' : 'local',
        flags: f.flags || f.Flags || [],
        specialUse: f.specialUse || f.special_use || undefined,
      };
    });
    const SYSTEM_FOLDER_ORDER: Record<string, number> = {
      INBOX: 0,
      DRAFTS: 1,
      DRAFT: 1,
      SENT: 2,
      'SENT MAIL': 2,
      'SENT ITEMS': 2,
      ARCHIVE: 3,
      JUNK: 4,
      SPAM: 4,
      TRASH: 5,
      DELETED: 5,
      'DELETED ITEMS': 5,
      OUTBOX: 6,
    };
    const SPECIAL_USE_ORDER: Record<string, number> = {
      '\\Inbox': 0,
      '\\Drafts': 1,
      '\\Sent': 2,
      '\\Archive': 3,
      '\\Junk': 4,
      '\\Trash': 5,
    };
    // Get the priority for a folder, checking specialUse flag first,
    // then path name, then top-level segment for subfolders.
    const getFolderPriority = (folder: { path?: string; specialUse?: string }): number => {
      // Check IMAP specialUse flag first (strongest signal)
      if (folder.specialUse && SPECIAL_USE_ORDER[folder.specialUse] !== undefined) {
        return SPECIAL_USE_ORDER[folder.specialUse];
      }
      const upperPath = (folder.path || '').toUpperCase();
      if (SYSTEM_FOLDER_ORDER[upperPath] !== undefined) return SYSTEM_FOLDER_ORDER[upperPath];
      const sep = upperPath.indexOf('/');
      if (sep > 0) {
        const parent = upperPath.substring(0, sep);
        if (SYSTEM_FOLDER_ORDER[parent] !== undefined) return SYSTEM_FOLDER_ORDER[parent];
      }
      return 100;
    };
    mapped.sort((a, b) => {
      const oa = getFolderPriority(a);
      const ob = getFolderPriority(b);
      if (oa !== ob) return oa - ob;
      const pa = (a.path || '').toUpperCase();
      const pb = (b.path || '').toUpperCase();
      return pa.localeCompare(pb);
    });
    return mapped;
  };

  const loadMessages = async () => {
    const account = Local.get('email') || 'default';
    const folder = get(selectedFolder);
    const currentPage = get(page);
    const limit = getLimit();
    const startIdx = (currentPage - 1) * limit;
    const currentSort = get(sortOrder);
    // Auto-select first message only in classic layout on desktop, unless explicitly disabled
    // In full/productivity mode, don't auto-select to avoid putting message ID in URL
    const autoSelectDisabled = Local.get('auto_select_first') === 'false';
    const isClassicLayout = normalizeLayoutMode(get(effectiveLayoutMode)) === 'classic';
    const allowAutoSelect = !isMobileViewport() && !autoSelectDisabled && isClassicLayout;
    // Append on every page after the first. Infinite scroll is the pagination
    // mechanism on all viewports now (the numbered pager was removed), so
    // desktop must accumulate pages too. Previously this was gated to mobile,
    // so on desktop page 2 REPLACED page 1 — the list was stuck at a single
    // page (~50 messages) and never grew on scroll. That also made old mail
    // look like it stopped at the oldest message of that first page (e.g.
    // ~July 2025 for a low-volume inbox); older pages exist but never loaded.
    const shouldAppend = currentPage > 1;
    const sortParam = (() => {
      if (currentSort === 'oldest') return 'date';
      if (currentSort === 'newest') return '-date';
      if (currentSort === 'subject') return 'subject';
      if (currentSort === 'sender') return 'from';
      return '-date';
    })();
    const queryParam = (get(query) || '').trim();
    const isBasicQuery =
      !queryParam && !get(unreadOnly) && !get(hasAttachmentsOnly) && !get(starredOnly);
    const tracer = createPerfTracer('messages.list', {
      folder,
      page: currentPage,
      limit,
      sort: sortParam,
      query: queryParam,
      unreadOnly: get(unreadOnly),
      attachmentsOnly: get(hasAttachmentsOnly),
    });

    error.set('');
    refreshReplyTargets({ account }).catch(() => {});

    let cachedPage = [];

    // Synchronous in-memory cache check — runs in same microtask as selectedFolder.set()
    // so Svelte batches both updates into one render (no skeleton flash)
    const memKey = `${account}:${folder}:${currentPage}`;
    const memCached = folderMessageCache.get(memKey);
    if (memCached?.messages?.length) {
      cachedPage = memCached.messages;
      const nextMessages = shouldAppend
        ? mergeMessagePages(get(messages), cachedPage, MAX_LIVE_MESSAGES)
        : cachedPage;
      messages.set(applyPendingFlagMutations(filterPendingDeletes(nextMessages)));
      hasNextPage.set(memCached.hasNextPage);
      loading.set(false);
      if (allowAutoSelect && (!get(selectedMessage) || get(selectedMessage)?.folder !== folder)) {
        selectedMessage.set(findFirstMessage(nextMessages, currentSort));
      }
    }

    // Demo mode keeps messages in-memory: the demo interceptor is the source of
    // truth, so skip the db.messages read entirely. Persisting ephemeral demo
    // data is pointless, and the db worker's IndexedDB read stalls on
    // Linux/WebKitGTK — folders rendered but the message list stayed stuck on
    // its skeleton because loadMessages hung here, before its demo/Remote
    // fallback. Mirrors loadFolders' demo fast-path.
    if (!isDemoMode())
      try {
        tracer.stage('cache_read_start');
        let pageSlice = [];
        if (currentSort === 'newest' || currentSort === 'oldest') {
          const range = db.messages
            .where('[account+folder+date]')
            .between([account, folder, Dexie.minKey], [account, folder, Dexie.maxKey], true, true);
          const ordered = currentSort === 'newest' ? range.reverse() : range;
          pageSlice = await ordered.offset(startIdx).limit(limit).toArray();
        } else {
          const cached = await db.messages
            .where('[account+folder]')
            .equals([account, folder])
            .toArray();
          const sorted = sortMessages(cached, currentSort);
          pageSlice = sorted.slice(startIdx, startIdx + limit);
        }
        cachedPage = pageSlice.map((msg) => {
          const decodedSubject = decodeMimeHeader(msg.subject || msg.Subject || '(No subject)');
          return {
            ...msg,
            subject: decodedSubject,
            normalizedSubject:
              msg.normalizedSubject ||
              normalizeSubjectMemoized(decodedSubject || msg.subject || ''),
            is_starred:
              msg.is_starred ??
              (Array.isArray(msg.flags) ? msg.flags.includes('\\Flagged') : false),
          };
        });
        tracer.stage('cache_read_end', { count: cachedPage.length });
        if (cachedPage.length) {
          const activeNow = Local.get('email') || 'default';
          if (activeNow !== account) {
            return;
          }
          // Only update the store if LRU didn't already provide data — avoids
          // a redundant messages.set() that causes visible flicker during sync.
          if (!memCached?.messages?.length) {
            const nextCached = shouldAppend
              ? mergeMessagePages(get(messages), cachedPage, MAX_LIVE_MESSAGES)
              : cachedPage;
            messages.set(applyPendingFlagMutations(filterPendingDeletes(nextCached)));
            loading.set(false);
            if (
              allowAutoSelect &&
              (!get(selectedMessage) || get(selectedMessage)?.folder !== folder)
            ) {
              selectedMessage.set(findFirstMessage(nextCached, currentSort));
            }
          }
          folderMessageCache.set(memKey, {
            messages: cachedPage,
            hasNextPage: get(hasNextPage),
          });
          if (isBasicQuery) {
            try {
              const totalCount = await db.messages
                .where('[account+folder]')
                .equals([account, folder])
                .count();
              // The cached count alone caps pagination at whatever's been
              // synced locally — on desktop that stalls infinite scroll well
              // before the folder's real end. Also consult the folder's
              // server-reported total so we keep `hasNextPage` true when the
              // server has more; the next-page load fetches it from the API
              // (line ~1178 then sets the authoritative value), and the remote
              // circuit breaker keeps a degraded env from storming.
              const folderRec = get(folders).find(
                (f) => f.path?.toUpperCase?.() === folder?.toUpperCase?.(),
              );
              const serverTotal = Number.isFinite(folderRec?.totalCount)
                ? folderRec.totalCount
                : null;
              if ((Local.get('email') || 'default') === account) {
                hasNextPage.set(
                  hasMorePages({
                    cachedCount: totalCount,
                    serverTotal,
                    offset: startIdx,
                    limit,
                  }),
                );
              }
            } catch {
              // ignore count failures
            }
          }
        }
      } catch (err) {
        warn('cached load failed', err);
      }

    // Build request key for deduplication
    const requestKey = `${account}:${folder}:${currentPage}:${limit}:${sortParam}:${queryParam}:${get(unreadOnly)}:${get(hasAttachmentsOnly)}`;

    // If same request is already in flight, wait for it instead of making duplicate
    if (inFlightMessageListRequest?.key === requestKey) {
      try {
        const res = await inFlightMessageListRequest.promise;
        tracer.end({ status: 'deduped' });
        return res;
      } catch {
        tracer.stage('dedupe_failed');
        // Previous request failed, proceed with new one
      }
    }

    // Register eagerly BEFORE async network calls to close the race window
    // where concurrent loadMessages() callers miss the dedup guard
    let resolveInflight!: (v: unknown) => void;
    let _rejectInflight!: (e: unknown) => void;
    const inflightDeferred = new Promise((res, rej) => {
      resolveInflight = res;
      _rejectInflight = rej;
    });
    inFlightMessageListRequest = { key: requestKey, promise: inflightDeferred };

    // Prevent scheduleSyncRefresh from immediately scheduling a redundant call
    // while this load is still in progress (covers initial load gap)
    lastSyncRefresh = { account, folder, at: Date.now() };

    const fetchWithFallback = async (params, stageLabel) => {
      if (stageLabel) tracer.stage(stageLabel);
      // Demo mode: the sync worker isn't demo-aware and can hang (it doesn't
      // resolve against the synchronous demo interceptor), leaving the message
      // list stuck on its loading skeleton. Skip it and serve straight from
      // the demo-intercepted Remote.request — mirrors loadFolders' demo
      // fast-path. The 'main' source parsing handles the demo array shape.
      if (!isDemoMode()) {
        try {
          const res = await sendSyncRequest('messagePage', {
            account,
            ...params,
          });
          return { source: 'worker', res };
        } catch {
          // fall through to the main-thread Remote request below
        }
      }
      const res = await Remote.request('MessageList', params, {
        method: 'GET',
        pathOverride: '/v1/messages',
        timeout: 60_000,
      });

      return { source: 'main', res };
    };

    const requestParams = {
      folder,
      page: currentPage,
      limit,
      raw: false,
      attachments: false,
      ...(queryParam ? { search: queryParam } : {}),
      ...(get(unreadOnly) ? { is_unread: true } : {}),
      ...(get(hasAttachmentsOnly) ? { has_attachments: true } : {}),
      // Note: label filtering is done client-side in filteredMessages derived store
    };

    // Only show skeleton when cache is completely empty — if we have cached data
    // already displayed, keep it visible while the network refreshes in the background
    if (!cachedPage.length) {
      loading.set(true);
    }

    const previewLimit = Math.min(20, limit);
    if (!cachedPage.length && limit > previewLimit) {
      fetchWithFallback({ ...requestParams, limit: previewLimit }, 'preview_start')
        .then(({ source, res }) => {
          if (inFlightMessageListRequest?.key !== requestKey) return;
          const isNoContent =
            (source === 'worker' && res?.noContent) || (source === 'main' && res == null);
          if (isNoContent) return;
          const list =
            source === 'worker'
              ? res?.messages || []
              : res?.Result?.List || res?.Result || res || [];
          if (!Array.isArray(list) || !list.length) return;
          tracer.stage('preview_end', { source, count: list.length });
          const mapped = list
            .map((m) => {
              const normalized = m?.account ? m : normalizeMessageForCache(m, folder, account);
              return {
                ...normalized,
                normalizedSubject:
                  normalized.normalizedSubject || normalizeSubjectMemoized(normalized.subject),
                pending: false,
                threadId: m.threadId || m.ThreadId || m.thread_id || normalized.thread_id,
                in_reply_to:
                  normalized.in_reply_to ||
                  m.in_reply_to ||
                  m.inReplyTo ||
                  m['In-Reply-To'] ||
                  m?.nodemailer?.headers?.['in-reply-to'] ||
                  m?.nodemailer?.headers?.['In-Reply-To'] ||
                  null,
                references:
                  normalized.references ||
                  m.references ||
                  m.References ||
                  m?.nodemailer?.headers?.references ||
                  m?.nodemailer?.headers?.References ||
                  null,
              };
            })
            .filter((m) => m.id);
          if (!mapped.length) return;
          const activeNow = Local.get('email') || 'default';
          if (activeNow !== account) return;
          if (get(selectedFolder) !== folder) return;
          const nextPreview = shouldAppend
            ? mergeMessagePages(get(messages), mapped, MAX_LIVE_MESSAGES)
            : mapped;
          messages.set(applyPendingFlagMutations(filterPendingDeletes(nextPreview)));
          loading.set(false);
          if (
            allowAutoSelect &&
            (!get(selectedMessage) || get(selectedMessage)?.folder !== folder)
          ) {
            selectedMessage.set(findFirstMessage(nextPreview, currentSort));
          }
        })
        .catch(() => {
          // ignore preview errors; full request will handle
        });
    }

    // Track this request (inFlightMessageListRequest already set eagerly above)
    const requestPromise = fetchWithFallback(requestParams, 'request_start');

    try {
      const { source, res } = await requestPromise;
      const activeNow = Local.get('email') || 'default';
      const activeFolder = get(selectedFolder);
      const isStaleRequest =
        activeNow !== account ||
        activeFolder?.toUpperCase() !== folder?.toUpperCase() ||
        inFlightMessageListRequest?.key !== requestKey;
      if (isStaleRequest) {
        tracer.stage('stale_request_continue_cache', { source });
      }
      const isNoContent =
        (source === 'worker' && res?.noContent) || (source === 'main' && res == null);
      if (isNoContent) {
        if (!isStaleRequest) {
          loading.set(false);
          error.set('');
        }
        tracer.end({ status: 'no_content', source });
        return;
      }
      const list =
        source === 'worker' ? res?.messages || [] : res?.Result?.List || res?.Result || res || [];
      // Keep infinite scroll alive while the server still has more than we've
      // paged, not just while the last fetched page looked full — otherwise a
      // short first server page strands the rest of a large folder (the
      // "stuck at ~47" desktop bug). Mirrors the cache-read path above.
      const folderRec = get(folders).find(
        (f) => f.path?.toUpperCase?.() === folder?.toUpperCase?.(),
      );
      const serverTotal = Number.isFinite(folderRec?.totalCount) ? folderRec.totalCount : null;
      const hasMore = resolveHasMoreAfterFetch({
        source,
        workerHasNextPage: res?.hasNextPage,
        listLength: Array.isArray(list) ? list.length : 0,
        limit,
        page: currentPage,
        serverTotal,
      });
      if (!isStaleRequest) {
        hasNextPage.set(Boolean(hasMore));
      }
      // shouldPrune is calculated after `merged` is declared below
      tracer.stage('request_end', { source, count: list.length });

      const mapped = [];
      const labelPresence = [];
      for (const m of list) {
        const normalized = m?.account ? m : normalizeMessageForCache(m, folder, account);
        if (!normalized?.id) continue;
        const incomingLabels = coerceLabelList(normalized.labels);
        mapped.push({
          ...normalized,
          normalizedSubject:
            normalized.normalizedSubject || normalizeSubjectMemoized(normalized.subject),
          pending: false,
          threadId: m.threadId || m.ThreadId || m.thread_id || normalized.thread_id,
          in_reply_to:
            normalized.in_reply_to ||
            m.in_reply_to ||
            m.inReplyTo ||
            m['In-Reply-To'] ||
            m?.nodemailer?.headers?.['in-reply-to'] ||
            m?.nodemailer?.headers?.['In-Reply-To'] ||
            null,
          references:
            normalized.references ||
            m.references ||
            m.References ||
            m?.nodemailer?.headers?.references ||
            m?.nodemailer?.headers?.References ||
            null,
        });
        labelPresence.push(incomingLabels.length > 0);
      }
      tracer.stage('map_end', { count: mapped.length });

      // If the active account changed while this request was in flight,
      // still write to IDB for this account's cache.
      if (activeNow !== account) {
        tracer.stage('stale_account_continue_cache', { source });
      }

      let merged = mapped;
      if (mapped.length) {
        merged = await mergeMissingLabels(bulkGetMessages, account, mapped, labelPresence);
        merged = await mergeMissingFrom(bulkGetMessages, account, merged);
      }

      // Guard against transient empty responses: if the server returns zero
      // messages for a non-search, non-filtered page-1 request but we already
      // have cached data (in IDB or the current store), keep the existing
      // messages instead of clearing the inbox.
      // This handles intermittent backend storage issues (e.g. stale reads
      // from distributed SQLite) that briefly return empty result sets,
      // as well as cold-start scenarios where the IDB read fails after
      // webview suspension (e.g. Tauri app returning from background)
      // but the messages store still holds the previous data.
      const isBasicPage1 =
        !shouldAppend &&
        currentPage === 1 &&
        !queryParam &&
        !get(unreadOnly) &&
        !get(hasAttachmentsOnly);
      const existingStoreMessages = get(messages) || [];
      const hasExistingData = cachedPage.length || existingStoreMessages.length;
      if (isBasicPage1 && !merged.length && hasExistingData) {
        tracer.end({
          status: 'transient_empty_kept_cache',
          cachedCount: cachedPage.length,
          storeCount: existingStoreMessages.length,
        });
        loading.set(false);
        error.set('');
        return;
      }

      // Prune stale cache entries on any non-append replace-load so messages
      // deleted or moved via the API (or another client) don't linger after a
      // refresh. Restricted to non-empty server responses — the transient-empty
      // branch above already short-circuits that case to guard against a flaky
      // API returning [] for a non-empty folder.
      const shouldPrune = !shouldAppend && cachedPage.length && merged.length;

      if (!isStaleRequest) {
        const nextMessages = shouldAppend
          ? mergeMessagePages(get(messages), merged, MAX_LIVE_MESSAGES)
          : merged;
        messages.set(applyPendingFlagMutations(filterPendingDeletes(nextMessages)));
        if (
          allowAutoSelect &&
          merged.length &&
          (!get(selectedMessage) || get(selectedMessage)?.folder !== folder)
        ) {
          selectedMessage.set(findFirstMessage(filterPendingDeletes(nextMessages), currentSort));
        } else if (
          !merged.length &&
          get(selectedMessage)?.folder === folder &&
          !get(searchActive)
        ) {
          // Only clear selection when no results and search is NOT active.
          // When search is active, selectedMessage is managed by searchMessages(),
          // not loadMessages() — clearing it here would drop the active search result.
          selectedMessage.set(null);
        }
      }

      confirmDeletes(new Set(merged.map((m) => m.id)));
      confirmFlagMutations(merged);

      let prunedIds: string[] = [];
      // Demo mode is fully IndexedDB-free: WebKitGTK (Tauri's Linux WebView)
      // stalls IndexedDB even on the main thread under the tauri:// scheme, so
      // ANY awaited db op can hang. Demo data is ephemeral and never needs
      // persisting, and markFolderAsRead reads the in-memory store (not
      // db.messages) in demo, so skip the write entirely. The visible list is
      // already updated by messages.set() above.
      if (!isDemoMode() && (merged.length || shouldPrune)) {
        // Resolve in-flight mutation IDs before opening the tx so we don't
        // clobber an optimistic move/label whose server round-trip hasn't
        // completed yet. If the queue read fails, skip pruning this pass.
        let queuedIds: Set<string> = new Set();
        let queueReadFailed = false;
        if (shouldPrune) {
          try {
            queuedIds = await getQueuedMessageIds(account);
          } catch {
            queueReadFailed = true;
          }
        }
        await db.transaction('rw', db.messages, db.messageBodies, async () => {
          if (merged.length) {
            await db.messages.bulkPut(
              merged.map((msg) => ({
                ...msg,
                account,
                updatedAt: Date.now(),
              })),
            );
          }
          if (shouldPrune && !queueReadFailed) {
            tracer.stage('cache_prune_start');
            const serverIds = new Set(merged.map((msg) => msg.id).filter(Boolean));
            const pendingIds = new Set(getPendingDeleteIds());
            prunedIds = cachedPage
              .filter(
                (msg) =>
                  msg?.id &&
                  !serverIds.has(msg.id) &&
                  !pendingIds.has(msg.id) &&
                  !queuedIds.has(msg.id),
              )
              .map((msg) => msg.id);
            if (prunedIds.length) {
              const pairs = prunedIds.map((id) => [account, id]);
              await db.messages.bulkDelete(pairs);
              await db.messageBodies.bulkDelete(pairs);
            }
            tracer.stage('cache_prune_end', { count: prunedIds.length });
          }
        });
        if (prunedIds.length) {
          // Search index removal lives outside the Dexie tx — awaiting a
          // non-Dexie promise inside a tx aborts it.
          searchStore.actions.removeFromIndex(prunedIds).catch(() => {});
        }
      }

      // Update in-memory cache with fresh network data
      if (merged.length) {
        folderMessageCache.set(`${account}:${folder}:${currentPage}`, {
          messages: merged,
          hasNextPage: Boolean(hasMore),
        });
      }

      if (folder === getSentFolderPath()) {
        refreshReplyTargets({ account, force: true }).catch(() => {});
      }

      // Check quota and evict if needed (async, non-blocking)
      setTimeout(() => {
        cacheManager.checkQuotaAndEvict().catch((err) => {
          console.error('[mailboxStore] Quota check failed:', err);
          const toasts = get(toastsRef);
          if (err.name === 'QuotaExceededError' || err.message?.includes('quota')) {
            toasts?.show?.(
              'Storage full. Some emails may not be cached. Please clear old emails.',
              'warning',
            );
          }
        });
      }, 0);

      if (source !== 'worker' && !isDemoMode()) {
        // Update local search index with retry logic (fallback path).
        // Skipped in demo mode: indexing ephemeral demo messages is pointless,
        // and awaiting the search worker can stall on Linux/WebKitGTK, which
        // would strand loadMessages here before its finally (loading never
        // clears, dedup deferred never resolves) even though the store and the
        // visible message list are already updated above.
        try {
          await searchStore.actions.indexMessages(merged);
        } catch (err) {
          warn('[mailboxStore] Search index update failed, retrying...', err);
          // Retry once after delay
          setTimeout(async () => {
            try {
              await searchStore.actions.indexMessages(merged);
            } catch (retryErr) {
              console.error('[mailboxStore] Search index retry failed:', retryErr);
            }
          }, 1000);
        }
      }
      if (!isStaleRequest) {
        loading.set(false);
        error.set('');
        // Update folder unread counts after loading messages
        updateFolderUnreadCounts();
      }
      resolveInflight(undefined);
      tracer.end({ status: isStaleRequest ? 'stale_request_cached' : 'ok', source });
    } catch (err) {
      const activeNow = Local.get('email') || 'default';
      const activeFolder = get(selectedFolder);
      if (
        activeNow !== account ||
        activeFolder?.toUpperCase() !== folder?.toUpperCase() ||
        inFlightMessageListRequest?.key !== requestKey
      ) {
        resolveInflight(undefined);
        tracer.end({ status: 'stale_request_error' });
        return;
      }
      error.set(err?.message || 'Unable to load messages.');
      loading.set(false);
      // Resolve (not reject) the dedup promise to avoid unhandled rejections
      // from concurrent callers — the error is already set in the store.
      resolveInflight(undefined);
      tracer.end({ status: 'error' });
    } finally {
      // Unblock any concurrent caller that deduped onto this request's promise
      // (line ~959). The no-content and transient-empty branches above can
      // return without resolving it; a still-pending deferred hangs those
      // callers — and their loading skeleton — forever. resolveInflight is
      // idempotent, so this is safe even when a success/error path already
      // resolved it.
      resolveInflight(undefined);
      // Clear in-flight tracking
      if (inFlightMessageListRequest?.key === requestKey) {
        inFlightMessageListRequest = null;
        // We were the final in-flight request and nothing superseded us, so no
        // later load will clear `loading`. The stale-request guards above gate
        // loading.set(false) behind !isStaleRequest, which can strand the
        // skeleton (loading=true) when concurrent demo-entry loaders flip the
        // selected folder mid-flight. Clear it here as a backstop.
        if (get(loading)) loading.set(false);
      }
    }
  };

  const resetForAccount = () => {
    inFlightMessageListRequest = null;
    pendingDeleteTracker.clear();
    pendingFlagTracker.clear();
    // Clear folder TTL cache so the next loadFolders() does a fresh fetch
    // instead of returning stale/empty data from a previous session.
    folderLoadState.clear();
  };

  const scheduleSyncRefresh = (folder, account) => {
    const now = Date.now();
    const recentlyRefreshed =
      lastSyncRefresh.account === account &&
      lastSyncRefresh.folder?.toUpperCase() === folder?.toUpperCase() &&
      now - lastSyncRefresh.at < 1000;
    if (recentlyRefreshed) return;
    if (syncRefreshTimer) clearTimeout(syncRefreshTimer);
    syncRefreshTimer = setTimeout(() => {
      syncRefreshTimer = null;
      if ((Local.get('email') || 'default') !== account) return;
      if (get(selectedFolder)?.toUpperCase() !== folder?.toUpperCase()) return;
      if (get(loading)) return;
      if (inFlightMessageListRequest) return; // Don't compete with user pagination
      // Skip refresh when search is active — the search view uses searchResults,
      // not messages. Calling loadMessages() during search can clear selectedMessage
      // if the API response differs from the search results.
      if (get(searchActive)) return;
      lastSyncRefresh = { account, folder, at: Date.now() };
      loadMessages();
    }, 150);
  };

  onSyncTaskComplete((data) => {
    if (data?.taskType !== 'metadata' || !data?.folder) return;
    const account = data.account || Local.get('email') || 'default';
    if ((Local.get('email') || 'default') !== account) return;

    // Always update sidebar unread counts after metadata sync, even if the
    // user is viewing a different folder.  This keeps badge and folder counts
    // accurate for shared-inbox scenarios where another client changes flags.
    updateFolderUnreadCounts();

    if (get(selectedFolder)?.toUpperCase() !== data.folder?.toUpperCase()) return;
    // Refresh the message list to catch deletions/moves
    // that may have happened on server or in another session
    scheduleSyncRefresh(data.folder, account);
  });

  const getArchiveFolderPath = () => {
    // Check if user has set an account-specific custom archive folder
    const currentAcct = Local.get('email') || 'default';
    const customFolder = getEffectiveSettingValue('archive_folder', { account: currentAcct });

    if (customFolder) {
      return customFolder;
    }

    // Auto-detect from folder list
    const list = get(folders) || [];

    // Strongest signal: IMAP specialUse flag
    const specialUseMatch = list.find((f) => f.specialUse === '\\Archive');
    if (specialUseMatch) return specialUseMatch.path;

    // Fall back to name-based detection
    const match = list.find(
      (f) =>
        (f.path || '').toUpperCase() === 'ARCHIVE' || (f.name || '').toUpperCase() === 'ARCHIVE',
    );
    return match?.path || 'Archive';
  };

  const getTrashFolderPath = () => {
    // Check if user has set an account-specific custom trash folder
    const currentAcct = Local.get('email') || 'default';
    const customFolder = getEffectiveSettingValue('trash_folder', { account: currentAcct });
    if (customFolder) {
      return customFolder;
    }

    // Auto-detect from folder list
    const list = get(folders) || [];

    // Strongest signal: IMAP specialUse flag
    const specialUseMatch = list.find((f) => f.specialUse === '\\Trash');
    if (specialUseMatch) return specialUseMatch.path;

    // Fall back to name-based detection
    const match = list.find(
      (f) =>
        (f.path || '').toUpperCase() === 'TRASH' ||
        (f.name || '').toUpperCase() === 'TRASH' ||
        (f.path || '').toUpperCase() === 'DELETED' ||
        (f.name || '').toUpperCase() === 'DELETED',
    );
    return match?.path || 'Trash';
  };

  const getSentFolderPath = () => {
    // Check if user has set an account-specific custom sent folder
    const currentAcct = Local.get('email') || 'default';
    const customFolder = getEffectiveSettingValue('sent_folder', { account: currentAcct });

    if (customFolder) {
      return customFolder;
    }

    // Auto-detect from folder list
    const list = get(folders) || [];

    // Strongest signal: IMAP specialUse flag
    const specialUseMatch = list.find((f) => f.specialUse === '\\Sent');
    if (specialUseMatch) return specialUseMatch.path;

    // Fall back to name-based detection
    const match = list.find(
      (f) =>
        (f.path || '').toUpperCase() === 'SENT' ||
        (f.name || '').toUpperCase() === 'SENT' ||
        (f.path || '').toUpperCase() === 'SENT MAIL' ||
        (f.name || '').toUpperCase() === 'SENT MAIL' ||
        (f.path || '').toUpperCase() === 'SENT ITEMS' ||
        (f.name || '').toUpperCase() === 'SENT ITEMS',
    );
    return match?.path || 'Sent';
  };

  const getDraftsFolderPath = () => {
    // Check if user has set an account-specific custom drafts folder
    const currentAcct = Local.get('email') || 'default';
    const customFolder = getEffectiveSettingValue('drafts_folder', { account: currentAcct });

    if (customFolder) {
      return customFolder;
    }

    // Auto-detect from folder list
    const list = get(folders) || [];

    // Strongest signal: IMAP specialUse flag
    const specialUseMatch = list.find((f) => f.specialUse === '\\Drafts');
    if (specialUseMatch) return specialUseMatch.path;

    // Fall back to name-based detection
    const match = list.find(
      (f) =>
        (f.path || '').toUpperCase() === 'DRAFTS' ||
        (f.name || '').toUpperCase() === 'DRAFTS' ||
        (f.path || '').toUpperCase() === 'DRAFT' ||
        (f.name || '').toUpperCase() === 'DRAFT',
    );
    return match?.path || 'Drafts';
  };

  const updateSelectedMessage = (msg) => {
    selectedMessage.set(msg || null);
  };

  const archiveMessage = async (msg) => {
    if (!msg?.id) return;
    const target = getArchiveFolderPath();
    if (!target) return;
    return moveMessage(msg, target, { stayInFolder: true });
  };

  const deleteMessage = async (msg, { permanent = false } = {}) => {
    if (!msg?.id) return;

    const trashPath = getTrashFolderPath();
    const msgFolder = (msg.folder || '').toUpperCase();
    const trashUpper = (trashPath || '').toUpperCase();
    const isInTrash =
      msgFolder === trashUpper ||
      msgFolder === 'TRASH' ||
      msgFolder === 'DELETED' ||
      msgFolder === 'DELETED ITEMS';

    // If not permanent delete and not already in Trash, move to Trash instead
    if (!permanent && !isInTrash) {
      if (trashPath) {
        return moveMessage(msg, trashPath, { stayInFolder: true });
      }
    }

    // Permanent delete, already in trash, or trash folder not found - use DELETE API
    const apiId = getMessageApiId(msg);
    if (!apiId) return;
    const account = Local.get('email') || 'default';
    const recordId = msg.id;

    // Save original state for rollback
    const originalList = get(messages);
    const originalSelected = get(selectedMessage);

    // Optimistic remove from store
    const list = originalList.filter((m) => m.id !== msg.id);
    messages.set(list);
    addPendingDeletes([msg.id]);
    if (originalSelected?.id === msg.id) {
      selectedMessage.set(null);
    }

    // Invalidate in-memory folder cache so stale entries don't reappear on refresh
    invalidateFolderInMemCache(account, msg.folder);

    // Update IDB cache immediately (optimistic)
    if (recordId != null) {
      await db.messages
        .where('[account+id]')
        .equals([account, recordId])
        .delete()
        .catch(() => {});
      await db.messageBodies
        .where('[account+id]')
        .equals([account, recordId])
        .delete()
        .catch(() => {});
    }
    await searchStore.actions.removeFromIndex([msg.id]).catch(() => {});

    // Sync to server or queue for later
    const mutationPayload = {
      messageId: apiId,
      permanent,
    };

    if (!isOnline()) {
      await queueMutation('delete', mutationPayload);
      return;
    }

    try {
      let path = `/v1/messages/${encodeURIComponent(apiId)}`;
      if (permanent) path += '?permanent=1';
      await Remote.request('MessageDelete', {}, { method: 'DELETE', pathOverride: path });
    } catch (err) {
      // 404 means the message is already gone server-side — treat as success
      const is404 = err?.status === 404 || /not (found|exist)/i.test(err?.message || '');
      if (!is404) {
        warn('deleteMessage failed, queuing for retry', err);
        await queueMutation('delete', mutationPayload);
      }
    }
  };

  /**
   * Bulk delete messages - optimized for performance
   * Non-permanent deletes use bulkMoveMessages to Trash
   * Messages already in Trash are permanently deleted
   */
  const bulkDeleteMessages = async (messagesToDelete, { permanent = false } = {}) => {
    if (!messagesToDelete?.length) return { success: 0, failed: 0 };

    const trashPath = getTrashFolderPath();
    const trashUpper = (trashPath || '').toUpperCase();
    const isTrashFolder = (folder) => {
      const folderUpper = (folder || '').toUpperCase();
      return (
        folderUpper === trashUpper ||
        folderUpper === 'TRASH' ||
        folderUpper === 'DELETED' ||
        folderUpper === 'DELETED ITEMS'
      );
    };

    // For non-permanent deletes, separate messages already in trash from others
    if (!permanent && trashPath) {
      const inTrash = messagesToDelete.filter((msg) => isTrashFolder(msg.folder));
      const notInTrash = messagesToDelete.filter((msg) => !isTrashFolder(msg.folder));

      // Move messages not in trash to trash
      let moveResults = { success: 0, failed: 0 };
      if (notInTrash.length) {
        moveResults = await bulkMoveMessages(notInTrash, trashPath);
      }

      // Permanently delete messages already in trash
      if (inTrash.length) {
        const deleteResults = await bulkDeleteMessages(inTrash, { permanent: true });
        return {
          success: moveResults.success + deleteResults.success,
          failed: moveResults.failed + deleteResults.failed,
        };
      }

      return moveResults;
    }

    // Permanent delete - process with parallel API calls
    const account = Local.get('email') || 'default';
    const validMessages = messagesToDelete.filter((msg) => msg?.id && getMessageApiId(msg));

    if (!validMessages.length) return { success: 0, failed: 0 };

    // Optimistic UI update - remove all messages at once
    const originalList = get(messages);
    const idsToRemove = new Set(validMessages.map((m) => m.id));
    messages.set(originalList.filter((m) => !idsToRemove.has(m.id)));
    addPendingDeletes([...idsToRemove]);

    // Invalidate in-memory folder cache so stale entries don't reappear on refresh
    const affectedFolders = new Set(validMessages.map((m) => m.folder).filter(Boolean));
    for (const folder of affectedFolders) {
      invalidateFolderInMemCache(account, folder);
    }

    // Clear selection for deleted messages
    const currentSelection = get(selectedConversationIds);
    if (currentSelection.length) {
      const newSelection = currentSelection.filter((id) => !idsToRemove.has(id));
      if (newSelection.length !== currentSelection.length) {
        selectedConversationIds.set(newSelection);
      }
    }

    // Process API calls in parallel
    const CONCURRENCY = 8;
    const results = [];
    const successfulDeletes = [];

    for (let i = 0; i < validMessages.length; i += CONCURRENCY) {
      const chunk = validMessages.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.allSettled(
        chunk.map(async (msg) => {
          const apiId = getMessageApiId(msg);
          let path = `/v1/messages/${encodeURIComponent(apiId)}`;
          if (permanent) path += '?permanent=1';
          await Remote.request('MessageDelete', {}, { method: 'DELETE', pathOverride: path });
          return msg;
        }),
      );
      chunkResults.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          successfulDeletes.push(chunk[idx]);
          results.push(true);
        } else {
          // Treat 404 / "not found" as success — the message is already
          // gone server-side (e.g. expunged by another client or cleanup job).
          const reason = result.reason;
          const is404 = reason?.status === 404 || /not (found|exist)/i.test(reason?.message || '');
          if (is404) {
            successfulDeletes.push(chunk[idx]);
            results.push(true);
          } else {
            results.push(false);
          }
        }
      });
    }

    // Batch DB cleanup for successful deletes
    if (successfulDeletes.length > 0) {
      try {
        const deleteIds = successfulDeletes.map((m) => m.id);
        await db.messages
          .where('[account+id]')
          .anyOf(deleteIds.map((id) => [account, id]))
          .delete();
        await db.messageBodies
          .where('[account+id]')
          .anyOf(deleteIds.map((id) => [account, id]))
          .delete();
        await searchStore.actions.removeFromIndex(deleteIds);
      } catch (err) {
        console.error('bulkDeleteMessages DB cleanup failed', err);
      }
    }

    return {
      success: results.filter(Boolean).length,
      failed: results.length - results.filter(Boolean).length,
    };
  };

  const moveMessage = async (
    msg,
    targetOverride,
    { stayInFolder = true, allowFromSent = false } = {},
  ) => {
    const apiId = getMessageApiId(msg);
    if (!apiId) return { success: false };
    const target = targetOverride;
    if (!target || target === msg.folder) return { success: false };

    // Prevent moving messages out of the active Sent folder (except to Trash)
    if (!allowFromSent) {
      const sentPath = getSentFolderPath();
      const msgFolder = (msg.folder || '').toUpperCase();
      const sentUpper = (sentPath || '').toUpperCase();
      if (sentUpper && msgFolder === sentUpper) {
        const trashPath = getTrashFolderPath();
        const trashUpper = (trashPath || '').toUpperCase();
        if (target.toUpperCase() !== trashUpper) {
          const toasts = get(toastsRef);
          toasts?.show?.('Cannot move messages from Sent folder', 'info');
          return { success: false };
        }
      }
    }

    const account = Local.get('email') || 'default';
    const recordId = msg.id;
    const result = { success: false };

    // Save original state for rollback (only if staying in folder)
    const originalList = stayInFolder ? get(messages) : null;
    const originalSelected = stayInFolder ? get(selectedMessage) : null;

    // Optimistic update
    if (stayInFolder) {
      const nextList = originalList.filter((m) => m.id !== msg.id);
      messages.set(nextList);
      addPendingDeletes([msg.id]);
      if (originalSelected?.id === msg.id) {
        // Apple Mail-style smart direction: if the message below is read
        // and the one above is unread, advance UP instead of down. Without
        // this we always advance down even when the user is reading from
        // the bottom of their unread stack. Also updates BOTH selection
        // stores in lock-step so the row highlight (selectedConversation)
        // and the header subject (selectedMessage) stay consistent —
        // previously only selectedMessage was updated, which is why the
        // subject moved but the highlight stayed on the moved row.
        const nextSelected = nextCandidate({
          list: nextList,
          threadingEnabled: false,
          selectedMessage: originalSelected,
          selectedConversation: get(selectedConversation),
        });
        selectedConversationIds.set([]);
        selectedMessage.set(nextSelected);
        selectedConversation.set(nextSelected);
      }
    } else {
      selectedFolder.set(target);
      page.set(1);
      await loadMessages();
    }

    // Invalidate in-memory folder cache so stale entries don't reappear on refresh
    invalidateFolderInMemCache(account, msg.folder);

    // Update IDB cache immediately (optimistic)
    if (recordId != null) {
      try {
        const existing = await db.messages.get([account, recordId]);
        const updated = {
          ...(existing || msg),
          id: recordId,
          account,
          folder: target,
          labels: existing?.labels ?? msg.labels ?? [],
          updatedAt: Date.now(),
        };
        await db.messages.put(updated);
        const bodyRecord = await db.messageBodies.get([account, recordId]);
        if (bodyRecord) {
          await db.messageBodies.put({
            ...bodyRecord,
            folder: target,
            updatedAt: Date.now(),
          });
        }
        await searchStore.actions.indexMessages([updated]);
      } catch {
        // IDB update is best-effort
      }
    } else {
      await searchStore.actions.indexMessages([{ ...msg, folder: target }]).catch(() => {});
    }

    // Sync to server or queue for later
    const mutationPayload = {
      messageId: apiId,
      targetFolder: target,
    };

    if (!isOnline()) {
      await queueMutation('move', mutationPayload);
      result.success = true;
      return result;
    }

    try {
      await Remote.request(
        'MessageUpdate',
        { folder: target },
        { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(apiId)}` },
      );
      result.success = true;
    } catch (err) {
      warn('moveMessage failed, queuing for retry', err);
      await queueMutation('move', mutationPayload);
      result.success = true; // Queued successfully, treat as success from UI perspective
    }

    // Reconcile with the server after the optimistic update so any new
    // messages that arrived between the move and now appear immediately,
    // rather than waiting for the next websocket NEW_MESSAGE tick. Without
    // this users report "new emails don't show up until I click away and
    // back" after a drag-drop. Fire-and-forget: don't block the caller.
    if (stayInFolder) {
      void loadMessages().catch(() => {});
    }

    return result;
  };

  /**
   * Bulk move messages - optimized for performance
   * Batches UI updates, API calls, DB writes, and search indexing
   */
  const bulkMoveMessages = async (messagesToMove, target) => {
    if (!target || !messagesToMove?.length) return { success: 0, failed: 0 };

    const account = Local.get('email') || 'default';
    const sentPath = getSentFolderPath();
    const sentUpper = (sentPath || '').toUpperCase();
    const trashPath = getTrashFolderPath();
    const trashUpper = (trashPath || '').toUpperCase();
    const targetUpper = target.toUpperCase();

    // Filter out messages that can't be moved (active sent folder unless moving to trash, same folder, no API id)
    const validMessages = messagesToMove.filter((msg) => {
      const msgFolder = (msg.folder || '').toUpperCase();
      if (sentUpper && msgFolder === sentUpper && targetUpper !== trashUpper) {
        return false;
      }
      if (msg.folder === target) return false;
      if (!getMessageApiId(msg)) return false;
      return true;
    });

    if (!validMessages.length) return { success: 0, failed: 0 };

    // Optimistic UI update - remove all messages at once
    const originalList = get(messages);
    const idsToRemove = new Set(validMessages.map((m) => m.id));
    messages.set(originalList.filter((m) => !idsToRemove.has(m.id)));
    addPendingDeletes([...idsToRemove]);

    // Invalidate in-memory folder cache so stale entries don't reappear on refresh
    const affectedFolders = new Set(validMessages.map((m) => m.folder).filter(Boolean));
    for (const folder of affectedFolders) {
      invalidateFolderInMemCache(account, folder);
    }

    // Clear selection for moved messages
    const currentSelection = get(selectedConversationIds);
    if (currentSelection.length) {
      const newSelection = currentSelection.filter((id) => !idsToRemove.has(id));
      if (newSelection.length !== currentSelection.length) {
        selectedConversationIds.set(newSelection);
      }
    }

    // Process API calls in parallel with concurrency limit
    const CONCURRENCY = 8;
    const results = [];
    const successfulMoves = [];

    for (let i = 0; i < validMessages.length; i += CONCURRENCY) {
      const chunk = validMessages.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.allSettled(
        chunk.map(async (msg) => {
          const apiId = getMessageApiId(msg);
          await Remote.request(
            'MessageUpdate',
            { folder: target },
            { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(apiId)}` },
          );
          return msg;
        }),
      );
      chunkResults.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          successfulMoves.push(chunk[idx]);
          results.push(true);
        } else {
          results.push(false);
        }
      });
    }

    // Batch DB updates for successful moves
    if (successfulMoves.length > 0) {
      try {
        // Get existing records in batch
        const recordIds = successfulMoves.map((m) => [account, m.id]);
        const existingMessages = await db.messages.bulkGet(recordIds);
        const existingBodies = await db.messageBodies.bulkGet(recordIds);

        // Prepare batch updates — use normalizeMessageForCache as fallback
        // when the IDB record is missing, to ensure only cloneable data is sent
        // to the db worker via postMessage
        const messageUpdates = successfulMoves.map((msg, idx) => ({
          ...(existingMessages[idx] || normalizeMessageForCache(msg, msg.folder, account)),
          id: msg.id,
          account,
          folder: target,
          labels: existingMessages[idx]?.labels ?? msg.labels ?? [],
          updatedAt: Date.now(),
        }));

        const bodyUpdates = existingBodies
          .map((body) => (body ? { ...body, folder: target, updatedAt: Date.now() } : null))
          .filter(Boolean);

        // Batch write to DB
        await db.messages.bulkPut(messageUpdates);
        if (bodyUpdates.length) {
          await db.messageBodies.bulkPut(bodyUpdates);
        }

        // Batch index for search
        await searchStore.actions.indexMessages(messageUpdates);
      } catch (err) {
        console.error('bulkMoveMessages DB update failed', err);
      }
    }

    const success = results.filter(Boolean).length;
    const failed = results.length - success;

    return { success, failed };
  };

  /**
   * Find the first message according to sort order without sorting the entire array
   * More efficient than sorting when you only need the first element
   */
  function findFirstMessage(list = [], order = 'newest') {
    if (!Array.isArray(list) || list.length === 0) return null;
    if (list.length === 1) return list[0];

    const dateValue = (msg) => normalizeSortDate(msg?.dateMs ?? msg?.date ?? msg?.Date);
    const compareByDate = (a, b, direction) => {
      const aDate = dateValue(a);
      const bDate = dateValue(b);
      if (aDate !== bDate) return direction * (aDate - bDate);
      const aUid = getMessageUidValue(a);
      const bUid = getMessageUidValue(b);
      if (aUid != null && bUid != null) return direction * (aUid - bUid);
      if (aUid != null) return -1;
      if (bUid != null) return 1;
      return 0;
    };

    let first = list[0];
    for (let i = 1; i < list.length; i++) {
      const current = list[i];
      let shouldReplace = false;

      switch (order) {
        case 'oldest':
          shouldReplace = compareByDate(current, first, 1) < 0;
          break;
        case 'subject': {
          const sub = (current.normalizedSubject || current.subject || '').localeCompare(
            first.normalizedSubject || first.subject || '',
            undefined,
            { sensitivity: 'base' },
          );
          shouldReplace = sub < 0 || (sub === 0 && compareByDate(current, first, -1) < 0);
          break;
        }
        case 'sender': {
          const fromCmp = (current.normalizedFrom || current.from || '').localeCompare(
            first.normalizedFrom || first.from || '',
            undefined,
            { sensitivity: 'base' },
          );
          shouldReplace = fromCmp < 0 || (fromCmp === 0 && compareByDate(current, first, -1) < 0);
          break;
        }
        case 'newest':
        default:
          shouldReplace = compareByDate(current, first, -1) < 0;
          break;
      }

      if (shouldReplace) {
        first = current;
      }
    }
    return first;
  }

  const changeSortOrder = (order) => {
    const allowed = ['newest', 'oldest', 'subject', 'sender'];
    const next = allowed.includes(order) ? order : 'newest';
    sortOrder.set(next);
    page.set(1);
    loadMessages();
  };

  // Folder management actions

  const loadExpandedState = () => {
    const account = Local.get('email') || 'default';
    const key = `${EXPANDED_FOLDERS_KEY}_${account}`;
    const stored = Local.get(key);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        expandedFolders.set(new Set(parsed));
      } catch (e) {
        console.error('Failed to parse expanded folders', e);
      }
    }
  };

  const saveExpandedState = (expanded) => {
    const account = Local.get('email') || 'default';
    const key = `${EXPANDED_FOLDERS_KEY}_${account}`;
    Local.set(key, JSON.stringify([...expanded]));
  };

  const toggleFolderExpansion = (folderPath) => {
    const current = get(expandedFolders);
    const next = new Set(current);
    if (next.has(folderPath)) {
      next.delete(folderPath);
    } else {
      next.add(folderPath);
    }
    expandedFolders.set(next);
    saveExpandedState(next);
  };

  const isSystemFolder = (folderPath) => {
    const normalized = (folderPath || '').toUpperCase().trim();
    if (ALWAYS_PROTECTED.has(normalized)) return true;

    // Dynamically protect only the currently resolved special folders
    const activePaths = new Set(
      [
        getSentFolderPath(),
        getDraftsFolderPath(),
        getTrashFolderPath(),
        getArchiveFolderPath(),
        getSpamFolderPath(),
      ]
        .filter(Boolean)
        .map((p) => p.toUpperCase().trim()),
    );
    return activePaths.has(normalized);
  };

  const hasChildren = (folder, allFolders) => {
    const folderPath = folder?.path || '';
    return allFolders.some((f) => {
      const path = f?.path || '';
      return path.startsWith(folderPath + '/');
    });
  };

  const getFolderChildren = (folder, allFolders) => {
    const folderPath = folder?.path || '';
    const level = folder?.level ?? 0;
    return allFolders.filter((f) => {
      const path = f?.path || '';
      return path.startsWith(folderPath + '/') && (f?.level ?? 0) === level + 1;
    });
  };

  const createFolder = async (parentPath, folderName) => {
    const validation = validateFolderName(folderName);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const path = parentPath ? `${parentPath}/${validation.value}` : validation.value;

    folderOperationInProgress.set(true);
    try {
      await Remote.request(
        'FolderCreate',
        { path },
        { method: 'POST', pathOverride: '/v1/folders' },
      );

      // Reload folders to get updated list
      await loadFolders({ force: true });

      // Auto-expand parent if creating subfolder
      if (parentPath) {
        const current = get(expandedFolders);
        const next = new Set(current);
        next.add(parentPath);
        expandedFolders.set(next);
        saveExpandedState(next);
      }

      return { success: true, path };
    } catch (err) {
      console.error('createFolder failed', err);
      throw err;
    } finally {
      folderOperationInProgress.set(false);
    }
  };

  const renameFolder = async (oldPath, newName) => {
    const validation = validateFolderName(newName);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    // Check if system folder
    if (isSystemFolder(oldPath)) {
      throw new Error('Cannot rename system folders');
    }

    const account = Local.get('email') || 'default';
    const pathParts = oldPath.split('/');
    pathParts[pathParts.length - 1] = validation.value;
    const newPath = pathParts.join('/');

    folderOperationInProgress.set(true);
    try {
      // Find folder ID
      const folderList = get(folders);
      const folder = folderList.find((f) => f.path === oldPath);
      if (!folder?.id) {
        throw new Error('Folder not found');
      }

      await Remote.request(
        'FolderUpdate',
        { path: newPath },
        { method: 'PUT', pathOverride: `/v1/folders/${encodeURIComponent(folder.id)}` },
      );

      // Update IndexedDB cache
      await db.folders
        .where('[account+path]')
        .equals([account, oldPath])
        .modify({ path: newPath, name: newName });

      // Update messages in this folder
      await db.messages
        .where('[account+folder]')
        .equals([account, oldPath])
        .modify({ folder: newPath });

      // Reload folders
      await loadFolders({ force: true });

      return { success: true, newPath };
    } catch (err) {
      console.error('renameFolder failed', err);
      throw err;
    } finally {
      folderOperationInProgress.set(false);
    }
  };

  const deleteFolder = async (folderPath) => {
    // Check if system folder
    if (isSystemFolder(folderPath)) {
      throw new Error('Cannot delete system folders');
    }

    const account = Local.get('email') || 'default';

    folderOperationInProgress.set(true);
    try {
      // Find folder ID
      const folderList = get(folders);
      const folder = folderList.find((f) => f.path === folderPath);
      if (!folder?.id) {
        throw new Error('Folder not found');
      }

      await Remote.request(
        'FolderDelete',
        {},
        { method: 'DELETE', pathOverride: `/v1/folders/${encodeURIComponent(folder.id)}` },
      );

      // Clean up IndexedDB
      await db.folders.where('[account+path]').equals([account, folderPath]).delete();
      await db.messages.where('[account+folder]').equals([account, folderPath]).delete();
      await db.messageBodies.where('[account+folder]').equals([account, folderPath]).delete();

      // Remove from expanded state
      const current = get(expandedFolders);
      const next = new Set(current);
      next.delete(folderPath);
      expandedFolders.set(next);
      saveExpandedState(next);

      // Reload folders
      await loadFolders({ force: true });

      return { success: true };
    } catch (err) {
      console.error('deleteFolder failed', err);
      throw err;
    } finally {
      folderOperationInProgress.set(false);
    }
  };

  const markFolderAsRead = async (folderPath) => {
    const account = Local.get('email') || 'default';

    // Demo mode is IndexedDB-free (WebKitGTK stalls IndexedDB under tauri://,
    // even on the main thread). Mark off the in-memory store instead of reading
    // db.messages — the folder being marked is the selected, rendered one, so
    // messagesStore holds its messages. Demo MessageUpdate is served by the
    // synchronous interceptor (tracks read state for re-fetches); the optimistic
    // pending-flag mutation flips the rows. Folder badge counts come from the
    // demo Folders interceptor on the next folder load.
    if (isDemoMode()) {
      const storeMessages = get(messages) || [];
      const unread = storeMessages.filter((m) => m.is_unread === true);
      if (!unread.length) return { success: true, count: 0 };
      for (const m of unread) {
        const flags = Array.isArray(m.flags) ? m.flags : [];
        const nextFlags = flags.includes('\\Seen') ? flags : [...flags, '\\Seen'];
        const apiId = getMessageApiId(m);
        if (apiId) {
          Remote.request(
            'MessageUpdate',
            { flags: nextFlags, folder: m.folder },
            { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(apiId)}` },
          ).catch(() => {});
        }
        if (m.id) {
          addPendingFlagMutation(m.id, { is_unread: false, is_unread_index: 0, flags: nextFlags });
        }
      }
      messages.set(applyPendingFlagMutations(get(messages)));
      return { success: true, count: unread.length };
    }

    try {
      // Get all unread messages in folder
      const allFolderMessages = await db.messages
        .where('[account+folder]')
        .equals([account, folderPath])
        .toArray();
      const unreadMessages = allFolderMessages.filter((m) => m.is_unread === true);
      if (!unreadMessages.length) {
        return { success: true, count: 0 };
      }

      // Mark as read via API. The server's PUT /v1/messages controller
      // accepts `body.flags` (the IMAP flag array) — it does NOT accept
      // `body.is_unread`. Previously we sent { is_unread: false } and the
      // server silently no-op'd, so "Mark all as read" appeared local-only
      // and reverted on the next sync. Send a proper flags payload that
      // preserves existing flags (e.g. \Flagged) and adds \Seen.
      for (const msg of unreadMessages) {
        const apiId = getMessageApiId(msg);
        if (!apiId) continue;

        const existingFlags = Array.isArray(msg.flags) ? msg.flags : [];
        if (existingFlags.includes('\\Seen')) continue;
        const newFlags = [...existingFlags, '\\Seen'];

        try {
          await Remote.request(
            'MessageUpdate',
            { flags: newFlags, folder: msg.folder },
            { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(apiId)}` },
          );
        } catch (err) {
          warn('Failed to mark message as read', msg.id, err);
        }
      }

      // Update IndexedDB optimistically (and stamp \Seen into the flags
      // array so subsequent sync passes don't flip the bit back).
      //
      // Using bulkPut instead of .modify((m) => …): the db worker rejects
      // function callbacks ("db worker modify does not support function
      // callbacks; pass an object") because callbacks can't be serialised
      // across the worker boundary. Read-then-bulkPut preserves existing
      // per-message flags (e.g. \Flagged) which a flat object-style modify
      // would erase.
      const updated = allFolderMessages.map((m) => {
        const flags = Array.isArray(m.flags) ? m.flags : [];
        const nextFlags = flags.includes('\\Seen') ? flags : [...flags, '\\Seen'];
        return {
          ...m,
          is_unread: false,
          is_unread_index: 0,
          flags: nextFlags,
        };
      });
      await db.messages.bulkPut(updated);

      // Stage each flip as a pending flag mutation. Without this, the
      // loadMessages() call below re-merges server data (which still
      // reports is_unread=true in demo mode, and may briefly report it
      // in production while the server processes the bulk update) and
      // clobbers the optimistic state. applyPendingFlagMutations
      // re-applies the override on every messages.set() until either
      // confirmFlagMutations sees server agreement or the 30s TTL
      // expires.
      for (const m of unreadMessages) {
        if (!m?.id) continue;
        const flags = Array.isArray(m.flags) ? m.flags : [];
        const nextFlags = flags.includes('\\Seen') ? flags : [...flags, '\\Seen'];
        addPendingFlagMutation(m.id, {
          is_unread: false,
          is_unread_index: 0,
          flags: nextFlags,
        });
      }

      // Reload current folder if it matches
      if (get(selectedFolder) === folderPath) {
        await loadMessages();
      }

      // Update folder unread counts
      await updateFolderUnreadCounts();

      return { success: true, count: unreadMessages.length };
    } catch (err) {
      console.error('markFolderAsRead failed', err);
      throw err;
    }
  };

  /**
   * Get the spam/junk folder path
   */
  const getSpamFolderPath = () => {
    // Check if user has set an account-specific custom junk folder
    const currentAcct = Local.get('email') || 'default';
    const customFolder = getEffectiveSettingValue('junk_folder', { account: currentAcct });
    if (customFolder) {
      return customFolder;
    }

    const list = get(folders) || [];

    // Strongest signal: IMAP specialUse flag
    const specialUseMatch = list.find((f) => f.specialUse === '\\Junk');
    if (specialUseMatch) return specialUseMatch.path;

    // Fall back to name-based detection
    const match = list.find(
      (f) =>
        (f.path || '').toUpperCase() === 'SPAM' ||
        (f.name || '').toUpperCase() === 'SPAM' ||
        (f.path || '').toUpperCase() === 'JUNK' ||
        (f.name || '').toUpperCase() === 'JUNK',
    );
    return match?.path || null;
  };

  /**
   * Empty a folder by permanently deleting all messages
   * Used for Trash and Spam folders
   */
  const emptyFolder = async (folderPath: string) => {
    if (!folderPath) return { success: false, count: 0, error: 'No folder specified' };

    const account = Local.get('email') || 'default';

    try {
      // Get all messages in the folder from cache
      const folderMessages = await db.messages
        .where('[account+folder]')
        .equals([account, folderPath])
        .toArray();

      if (!folderMessages.length) {
        return { success: true, count: 0 };
      }

      // Optimistic UI update - clear all messages if viewing this folder
      const currentFolder = get(selectedFolder);
      if (currentFolder === folderPath) {
        messages.set([]);
        selectedMessage.set(null);
        selectedConversationIds.set([]);
      }

      // Delete from server in parallel batches
      const CONCURRENCY = 8;
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < folderMessages.length; i += CONCURRENCY) {
        const chunk = folderMessages.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map(async (msg) => {
            const apiId = getMessageApiId(msg);
            if (!apiId) throw new Error('No API ID');
            await Remote.request(
              'MessageDelete',
              {},
              {
                method: 'DELETE',
                pathOverride: `/v1/messages/${encodeURIComponent(apiId)}?permanent=1`,
              },
            );
            return msg.id;
          }),
        );

        results.forEach((result) => {
          if (result.status === 'fulfilled') {
            successCount++;
          } else {
            // Treat 404 / "not found" as success — message already gone server-side
            const reason = result.reason;
            const is404 =
              reason?.status === 404 || /not (found|exist)/i.test(reason?.message || '');
            if (is404) {
              successCount++;
            } else {
              failCount++;
            }
          }
        });
      }

      // Clear from IndexedDB
      await db.messages.where('[account+folder]').equals([account, folderPath]).delete();
      await db.messageBodies.where('[account+folder]').equals([account, folderPath]).delete();

      // Clear from search index
      const messageIds = folderMessages.map((m) => m.id).filter(Boolean);
      if (messageIds.length) {
        await searchStore.actions.removeFromIndex(messageIds);
      }

      // Update folder counts
      await updateFolderUnreadCounts();

      // Reload if viewing this folder
      if (currentFolder === folderPath) {
        await loadMessages();
      }

      return { success: true, count: successCount, failed: failCount };
    } catch (err) {
      console.error('emptyFolder failed', err);
      return { success: false, count: 0, error: err?.message || 'Failed to empty folder' };
    }
  };

  /**
   * Empty the Trash folder - permanently delete all messages
   */
  const emptyTrash = async () => {
    const trashPath = getTrashFolderPath();
    if (!trashPath) {
      return { success: false, count: 0, error: 'Trash folder not found' };
    }
    return emptyFolder(trashPath);
  };

  /**
   * Empty the Spam/Junk folder - permanently delete all messages
   */
  const emptySpam = async () => {
    const spamPath = getSpamFolderPath();
    if (!spamPath) {
      return { success: false, count: 0, error: 'Spam folder not found' };
    }
    return emptyFolder(spamPath);
  };

  return {
    state: {
      folders,
      selectedFolder,
      messages,
      selectedMessage,
      searchResults,
      searchActive,
      threadingEnabled,
      loading,
      searching,
      error,
      page,
      hasNextPage,
      query,
      unreadOnly,
      hasAttachmentsOnly,
      filterByLabel,
      starredOnly,
      messageBody,
      attachments,
      messageLoading,
      selectedConversationIds,
      selectedConversationCount,
      sidebarOpen,
      showFilters,
      sortOrder,
      filteredMessages,
      filteredConversations,
      // Folder management state
      expandedFolders,
      folderContextMenu,
      folderOperationInProgress,
    },
    actions: {
      loadFolders,
      loadMessages,
      refreshReplyTargets,
      searchMessages,
      selectFolder,
      selectMessage,
      toggleConversationSelection,
      selectAllVisible,
      formatDate,
      setSelectedIds,
      archiveMessage,
      deleteMessage,
      bulkDeleteMessages,
      moveMessage,
      bulkMoveMessages,
      getArchiveFolderPath,
      getTrashFolderPath,
      getSentFolderPath,
      getDraftsFolderPath,
      updateSelectedMessage,
      messageBody,
      attachments,
      messageLoading,
      setSortOrder: changeSortOrder,
      resetForAccount,
      setToasts: (toasts) => toastsRef.set(toasts),
      // Folder management actions
      loadExpandedState,
      saveExpandedState,
      toggleFolderExpansion,
      isSystemFolder,
      hasChildren,
      getFolderChildren,
      createFolder,
      renameFolder,
      deleteFolder,
      markFolderAsRead,
      updateFolderUnreadCounts,
      buildFolderList,
      // Bulk folder actions
      getSpamFolderPath,
      emptyTrash,
      emptySpam,
      clearFolderMessageCache: () => folderMessageCache.clear(),
      invalidateFolderInMemCache,
      addPendingFlagMutation,
      addPendingDeletes,
    },
  };
};

export const mailboxStore = createMailboxStore();
