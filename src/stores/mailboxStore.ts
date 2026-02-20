import { writable, get } from 'svelte/store';
import Dexie from 'dexie';
import { Remote } from '../utils/remote';
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
import { queueMutation } from '../utils/mutation-queue';
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

// Folders that are always protected from rename/delete
const ALWAYS_PROTECTED = new Set(['INBOX', 'OUTBOX']);

const EXPANDED_FOLDERS_KEY = 'folder_expansion_state';
const FOLDERS_CACHE_TTL = 15000;
const folderLoadState = new Map();

// In-memory cache for instant folder switching (avoids async IDB read latency)
// Keyed by "account:folder:page", stores processed messages ready for display
const folderMessageCache = new Map();

// Track optimistically deleted message IDs to prevent stale server responses
// from re-adding them to the store. Entries auto-expire after 30 seconds.
const pendingDeletes: Map<string, number> = new Map(); // id -> timestamp
const PENDING_DELETE_TTL = 30_000;

const addPendingDeletes = (ids: string[]) => {
  const now = Date.now();
  for (const id of ids) {
    if (id) pendingDeletes.set(id, now);
  }
};

const filterPendingDeletes = (msgs: Record<string, unknown>[]) => {
  if (!pendingDeletes.size) return msgs;
  // Prune expired entries
  const now = Date.now();
  for (const [id, ts] of pendingDeletes) {
    if (now - ts > PENDING_DELETE_TTL) pendingDeletes.delete(id);
  }
  if (!pendingDeletes.size) return msgs;
  return msgs.filter((m) => !pendingDeletes.has(m.id));
};

export const getPendingDeleteIds = (): string[] => {
  const now = Date.now();
  for (const [id, ts] of pendingDeletes) {
    if (now - ts > PENDING_DELETE_TTL) pendingDeletes.delete(id);
  }
  return [...pendingDeletes.keys()];
};

const confirmDeletes = (serverIds: Set<string>) => {
  // If a pending-delete ID is absent from the server response, the server
  // has processed it — safe to stop filtering.
  for (const id of pendingDeletes.keys()) {
    if (!serverIds.has(id)) pendingDeletes.delete(id);
  }
};

// Track optimistic flag mutations (read/star) so stale server responses
// don't overwrite them. Entries auto-expire after 30 seconds.
interface PendingFlagMutation {
  ts: number;
  is_unread?: boolean;
  is_unread_index?: number;
  flags?: string[];
  is_starred?: boolean;
}
const pendingFlagMutations: Map<string, PendingFlagMutation> = new Map(); // id -> mutation

const addPendingFlagMutation = (id: string, mutation: Omit<PendingFlagMutation, 'ts'>) => {
  if (!id) return;
  pendingFlagMutations.set(id, { ...mutation, ts: Date.now() });
};

const applyPendingFlagMutations = (msgs: Record<string, unknown>[]) => {
  if (!pendingFlagMutations.size) return msgs;
  // Prune expired entries
  const now = Date.now();
  for (const [id, m] of pendingFlagMutations) {
    if (now - m.ts > PENDING_DELETE_TTL) pendingFlagMutations.delete(id);
  }
  if (!pendingFlagMutations.size) return msgs;
  return msgs.map((msg) => {
    const pending = pendingFlagMutations.get(msg.id);
    if (!pending) return msg;
    const { ts: _ts, ...overrides } = pending;
    return { ...msg, ...overrides };
  });
};

const confirmFlagMutations = (serverMsgs: Record<string, unknown>[]) => {
  // If the server response matches the optimistic state, the mutation
  // has been processed — safe to stop overriding.
  for (const msg of serverMsgs) {
    const pending = pendingFlagMutations.get(msg.id);
    if (!pending) continue;
    if (pending.is_unread !== undefined && msg.is_unread === pending.is_unread) {
      pendingFlagMutations.delete(msg.id);
    } else if (pending.is_starred !== undefined && msg.is_starred === pending.is_starred) {
      pendingFlagMutations.delete(msg.id);
    }
  }
};

const invalidateFolderInMemCache = (account, folder) => {
  const prefix = `${account}:${folder}:`;
  for (const key of folderMessageCache.keys()) {
    if (key.startsWith(prefix)) {
      folderMessageCache.delete(key);
    }
  }
};

const isMobileViewport = () => typeof window !== 'undefined' && window.innerWidth <= 900;
const isValidDexieKeyFallback = (key) => {
  if (key == null) return false;
  if (Array.isArray(key)) return key.every(isValidDexieKeyFallback);
  if (key instanceof Date) return true;
  const type = typeof key;
  if (type === 'string') return true;
  if (type === 'number') return Number.isFinite(key);
  return false;
};

const coerceLabelList = (value) => {
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

const hasFromValue = (value) => typeof value === 'string' && value.trim().length > 0;

const mergeMissingLabels = async (account, list, labelPresence = []) => {
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
    const existing = await db.messages.bulkGet(lookup);
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
    const fallbackRecords = fallbackKeys.length ? await db.messages.bulkGet(fallbackKeys) : [];
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

const mergeMissingFrom = async (account, list = []) => {
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
    const existing = await db.messages.bulkGet(lookup);
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
    const fallbackRecords = fallbackKeys.length ? await db.messages.bulkGet(fallbackKeys) : [];
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

const getMessageKey = (msg) => {
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

const mergeMessagePages = (existing = [], incoming = []) => {
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
  return merged;
};

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
    const settings = getSyncSettings();
    const effective = getEffectiveSettingValue('messages_per_page');
    const parsed = Number.parseInt(effective, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return settings.pageSize || 20;
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
      const sentMessages = await db.messages
        .where('[account+folder+date]')
        .between([account, sentFolder, since], [account, sentFolder, Dexie.maxKey], true, true)
        .toArray();
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

  const searchMessages = async (term) => {
    const rawTerm = term ?? '';
    const q = rawTerm.trim();
    const searchQuery = buildSearchQuery(q);
    query.set(rawTerm);

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
      searching.set(false);
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
    } catch (err) {
      warn('[mailboxStore] Failed to update folder unread counts', err);
    }
  };

  const loadFolders = async (options = {}) => {
    const account = Local.get('email') || 'default';
    const { force = false } = options;
    const state = folderLoadState.get(account) || { promise: null, lastFetchAt: 0 };
    if (state.promise) {
      return state.promise;
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
          const inbox = mappedCached.find((f) => f.path?.toUpperCase?.() === 'INBOX');
          const defaultFolder = inbox?.path || mappedCached[0]?.path;
          if (defaultFolder) {
            selectedFolder.set(defaultFolder);
          }
        }
      }
      return;
    }

    const promise = (async () => {
      try {
        // cache first
        const cached = await db.folders.where('account').equals(account).toArray();
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
            { method: 'GET', pathOverride: '/v1/folders' },
          );
          const raw = res?.Result || res || [];
          list = Array.isArray(raw) ? raw : raw.Items || raw.items || [];

          // Use transaction for atomic folder cache update (fallback path only)
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
      const totalCount = readNumber(f.total ?? f.message_count ?? f.count);

      return {
        id: f.id || f.folder_id || f.uid || f.uidnext || f.uidvalidity || f.uid_validity,
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
    const shouldAppend = isMobileViewport() && currentPage > 1;
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
      const nextMessages = shouldAppend ? mergeMessagePages(get(messages), cachedPage) : cachedPage;
      messages.set(applyPendingFlagMutations(filterPendingDeletes(nextMessages)));
      hasNextPage.set(memCached.hasNextPage);
      loading.set(false);
      if (allowAutoSelect && (!get(selectedMessage) || get(selectedMessage)?.folder !== folder)) {
        selectedMessage.set(findFirstMessage(nextMessages, currentSort));
      }
    }

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
            msg.normalizedSubject || normalizeSubjectMemoized(decodedSubject || msg.subject || ''),
          is_starred:
            msg.is_starred ?? (Array.isArray(msg.flags) ? msg.flags.includes('\\Flagged') : false),
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
            ? mergeMessagePages(get(messages), cachedPage)
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
            if ((Local.get('email') || 'default') === account) {
              hasNextPage.set(totalCount > startIdx + limit);
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
    let rejectInflight!: (e: unknown) => void;
    const inflightDeferred = new Promise((res, rej) => {
      resolveInflight = res;
      rejectInflight = rej;
    });
    inFlightMessageListRequest = { key: requestKey, promise: inflightDeferred };

    // Prevent scheduleSyncRefresh from immediately scheduling a redundant call
    // while this load is still in progress (covers initial load gap)
    lastSyncRefresh = { account, folder, at: Date.now() };

    const fetchWithFallback = async (params, stageLabel) => {
      if (stageLabel) tracer.stage(stageLabel);
      try {
        const res = await sendSyncRequest('messagePage', {
          account,
          ...params,
        });
        return { source: 'worker', res };
      } catch {
        const res = await Remote.request('MessageList', params, {
          method: 'GET',
          pathOverride: '/v1/messages',
        });
        return { source: 'main', res };
      }
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
          const nextPreview = shouldAppend ? mergeMessagePages(get(messages), mapped) : mapped;
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
        activeFolder !== folder ||
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
      const hasMore =
        source === 'worker' ? res?.hasNextPage : Array.isArray(list) && list.length >= limit;
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
        merged = await mergeMissingLabels(account, mapped, labelPresence);
        merged = await mergeMissingFrom(account, merged);
      }

      // Always prune stale cache entries on page 1 when we have fresh server data
      // This ensures deleted/moved messages don't reappear from cache
      const shouldPrune = !shouldAppend && currentPage === 1 && cachedPage.length && merged.length;

      if (!isStaleRequest) {
        const nextMessages = shouldAppend ? mergeMessagePages(get(messages), merged) : merged;
        messages.set(applyPendingFlagMutations(filterPendingDeletes(nextMessages)));
        if (
          allowAutoSelect &&
          merged.length &&
          (!get(selectedMessage) || get(selectedMessage)?.folder !== folder)
        ) {
          selectedMessage.set(findFirstMessage(filterPendingDeletes(nextMessages), currentSort));
        } else if (!merged.length && get(selectedMessage)?.folder === folder) {
          selectedMessage.set(null);
        }
      }

      confirmDeletes(new Set(merged.map((m) => m.id)));
      confirmFlagMutations(merged);

      if (merged.length || shouldPrune) {
        await db.transaction('rw', db.messages, async () => {
          if (merged.length) {
            await db.messages.bulkPut(
              merged.map((msg) => ({
                ...msg,
                account,
                updatedAt: Date.now(),
              })),
            );
          }
          if (shouldPrune) {
            tracer.stage('cache_prune_start');
            const serverIds = new Set(merged.map((msg) => msg.id).filter(Boolean));
            const staleKeys = cachedPage
              .filter((msg) => msg?.id && !serverIds.has(msg.id))
              .map((msg) => [account, msg.id]);
            if (staleKeys.length) {
              await db.messages.bulkDelete(staleKeys);
            }
            tracer.stage('cache_prune_end', { count: staleKeys.length });
          }
        });
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

      if (source !== 'worker') {
        // Update local search index with retry logic (fallback path)
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
        activeFolder !== folder ||
        inFlightMessageListRequest?.key !== requestKey
      ) {
        resolveInflight(undefined);
        tracer.end({ status: 'stale_request_error' });
        return;
      }
      error.set(err?.message || 'Unable to load messages.');
      loading.set(false);
      rejectInflight(err);
      tracer.end({ status: 'error' });
    } finally {
      // Clear in-flight tracking
      if (inFlightMessageListRequest?.key === requestKey) {
        inFlightMessageListRequest = null;
      }
    }
  };

  const resetForAccount = () => {
    inFlightMessageListRequest = null;
    pendingDeletes.clear();
    pendingFlagMutations.clear();
  };

  const scheduleSyncRefresh = (folder, account) => {
    const now = Date.now();
    const recentlyRefreshed =
      lastSyncRefresh.account === account &&
      lastSyncRefresh.folder === folder &&
      now - lastSyncRefresh.at < 1000;
    if (recentlyRefreshed) return;
    if (syncRefreshTimer) clearTimeout(syncRefreshTimer);
    syncRefreshTimer = setTimeout(() => {
      syncRefreshTimer = null;
      if ((Local.get('email') || 'default') !== account) return;
      if (get(selectedFolder) !== folder) return;
      if (get(loading)) return;
      if (inFlightMessageListRequest) return; // Don't compete with user pagination
      lastSyncRefresh = { account, folder, at: Date.now() };
      loadMessages();
    }, 150);
  };

  onSyncTaskComplete((data) => {
    if (data?.taskType !== 'metadata' || !data?.folder) return;
    const account = data.account || Local.get('email') || 'default';
    if ((Local.get('email') || 'default') !== account) return;
    if (get(selectedFolder) !== data.folder) return;
    // Always refresh on metadata sync completion to catch deletions/moves
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
    // Check if user has set a custom trash folder
    const customFolder = Local.get('trash_folder');
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

    if (!navigator.onLine) {
      await queueMutation('delete', mutationPayload);
      return;
    }

    try {
      let path = `/v1/messages/${encodeURIComponent(apiId)}`;
      if (permanent) path += '?permanent=1';
      await Remote.request('MessageDelete', {}, { method: 'DELETE', pathOverride: path });
    } catch (err) {
      warn('deleteMessage failed, queuing for retry', err);
      await queueMutation('delete', mutationPayload);
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
          results.push(false);
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
      messages.set(originalList.filter((m) => m.id !== msg.id));
      addPendingDeletes([msg.id]);
      if (originalSelected?.id === msg.id) {
        selectedMessage.set(null);
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

    if (!navigator.onLine) {
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

      // Mark as read via API (batch request)
      for (const msg of unreadMessages) {
        const apiId = getMessageApiId(msg);
        if (!apiId) continue;

        try {
          await Remote.request(
            'MessageUpdate',
            { is_unread: false },
            { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(apiId)}` },
          );
        } catch (err) {
          warn('Failed to mark message as read', msg.id, err);
        }
      }

      // Update IndexedDB
      await db.messages
        .where('[account+folder]')
        .equals([account, folderPath])
        .modify({ is_unread: false, is_unread_index: 0 });

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
            failCount++;
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
      addPendingFlagMutation,
    },
  };
};

export const mailboxStore = createMailboxStore();
