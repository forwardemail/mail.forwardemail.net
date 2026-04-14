import { writable, get } from 'svelte/store';
import type { Writable } from 'svelte/store';
import { SearchService, SavedSearchService, setSearchDbClient } from '../utils/search-service';
import { mapMessageToDoc } from '../utils/search-mapping';
import { Local } from '../utils/storage';
import { db } from '../utils/db';
import { parseSearchQuery, applySearchFilters } from '../utils/search-query';
import { SearchWorkerClient } from '../utils/search-worker-client';
import { connectSearchWorker } from '../utils/sync-controller';
import { indexProgress } from './mailboxActions';
import { resolveSearchBodyIndexing } from '../utils/search-body-indexing.js';
import { Remote } from '../utils/remote';
import { isDemoMode } from '../utils/demo-mode';
import type { Message, SearchStats, SearchResult } from '../types';
import { warn } from '../utils/logger.ts';

export interface SearchHealth {
  healthy: boolean;
  messagesCount: number;
  indexCount: number;
  divergence: number;
  needsRebuild: boolean;
  needsIncrementalSync?: boolean;
}

export interface SavedSearch {
  name: string;
  query: string;
  createdAt?: number;
  options?: Record<string, unknown>;
}

export interface SearchOptions {
  folder?: string | null;
  crossFolder?: boolean;
  limit?: number;
  candidates?: Message[];
}

export interface RebuildOptions {
  silent?: boolean;
}

interface ToastsRef {
  show?: (message: string, type: string) => void;
}

// Set up db client for SearchService on main thread
setSearchDbClient(db);

let indexToastsRef: ToastsRef | null = null;

export const setIndexToasts = (toasts: ToastsRef): void => {
  indexToastsRef = toasts;
};

const ready: Writable<boolean> = writable(false);
const loading: Writable<boolean> = writable(false);
const stats: Writable<SearchStats> = writable({
  count: 0,
  sizeBytes: 0,
  includeBody: false,
  account: 'default',
});
const error: Writable<string> = writable('');
const query: Writable<string> = writable('');
const results: Writable<SearchResult[]> = writable([]);
const savedSearches: Writable<SavedSearch[]> = writable([]);
const health: Writable<SearchHealth> = writable({
  healthy: true,
  messagesCount: 0,
  indexCount: 0,
  divergence: 0,
  needsRebuild: false,
});
const includeBody: Writable<boolean> = writable(resolveSearchBodyIndexing());

let searchService: SearchService | null = null;
let savedSearchService: SavedSearchService | null = null;
let accountId: string = Local.get('email') || 'default';
let workerClient: SearchWorkerClient | null = null;
let syncWorkerConnected = false;
let startupCheckDone = false;

// Incremented on every search() call — results from stale generations are
// discarded so rapid typing doesn't let an earlier query overwrite a later one.
let searchGeneration = 0;

const refreshStats = (): void => {
  if (!searchService) return;
  stats.set(searchService.getStats());
};

const refreshSavedSearches = async (): Promise<void> => {
  if (!savedSearchService) return;
  const list = await savedSearchService.getAll();
  savedSearches.set(list || []);
};

// Lazy init for main-thread SearchService - only create when worker fails
const ensureMainThreadService = async (): Promise<void> => {
  if (searchService) return;
  searchService = new SearchService({
    includeBody: get(includeBody),
    account: accountId,
  });
  await searchService.loadFromCache();
  refreshStats();
};

const ensureInitialized = async (
  account: string = Local.get('email') || 'default',
): Promise<void> => {
  const normalizedAccount = account || 'default';
  if (workerClient && accountId === normalizedAccount) return;

  // Terminate old worker before creating new one to prevent parallel execution
  if (workerClient) {
    try {
      workerClient.terminate();
    } catch {
      // Ignore termination errors
    }
    workerClient = null;
    syncWorkerConnected = false; // Reset port flag so new connection is established
  }

  accountId = normalizedAccount;
  loading.set(true);
  error.set('');

  try {
    // Prefer worker - only init main-thread service on fallback
    try {
      workerClient = new SearchWorkerClient();
    } catch {
      workerClient = null;
      await ensureMainThreadService();
    }
    savedSearchService = new SavedSearchService(accountId);
    if (workerClient) {
      await workerClient.init(accountId, get(includeBody));

      // Connect sync worker to search worker for incremental indexing
      if (!syncWorkerConnected) {
        try {
          await connectSearchWorker(workerClient);
          syncWorkerConnected = true;
        } catch {
          // ignore
        }
      }

      // On first init, check if we need to rebuild index from cache
      if (!startupCheckDone) {
        startupCheckDone = true;
        await runStartupCheck();
      }
    }
    await refreshSavedSearches();
    ready.set(true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Search initialization failed';
    error.set(message);
  } finally {
    loading.set(false);
  }
};

// Check index health on startup and trigger rebuild or incremental sync if needed
const runStartupCheck = async (): Promise<void> => {
  if (!workerClient) return;

  try {
    const healthResult = await workerClient.getHealth({
      account: accountId,
      includeBody: get(includeBody),
    });
    health.set(healthResult);

    // If index is empty but messages exist, trigger full rebuild
    if (healthResult.needsRebuild) {
      await rebuildFromCache({ silent: false });
    } else if (healthResult.needsIncrementalSync) {
      // If some messages are missing, do incremental sync (faster than full rebuild)
      const syncResult = await workerClient.syncMissingMessages({
        account: accountId,
        includeBody: get(includeBody),
      });
      if (syncResult?.stats) stats.set(syncResult.stats);
      // Re-check health after sync
      const newHealth = await workerClient.getHealth({
        account: accountId,
        includeBody: get(includeBody),
      });
      health.set(newHealth);
    }
  } catch (err) {
    warn('[searchStore] Startup health check failed', err);
  }
};

// Manually check health and update store
const checkHealth = async (): Promise<SearchHealth | null> => {
  if (!workerClient) return null;

  try {
    const healthResult = await workerClient.getHealth({
      account: accountId,
      includeBody: get(includeBody),
    });
    health.set(healthResult);
    return healthResult;
  } catch (err) {
    warn('[searchStore] Health check failed', err);
    return null;
  }
};

// Get the worker client (for external use, e.g., sync-controller)
const getWorkerClient = (): SearchWorkerClient | null => workerClient;

// Sync only missing messages (faster than full rebuild)
const syncMissingMessages = async (): Promise<{ stats?: SearchStats } | null> => {
  if (!workerClient) return null;

  loading.set(true);
  try {
    const result = await workerClient.syncMissingMessages({
      account: accountId,
      includeBody: get(includeBody),
    });
    if (result?.stats) stats.set(result.stats);

    // Update health after sync
    const healthResult = await workerClient.getHealth({
      account: accountId,
      includeBody: get(includeBody),
    });
    health.set(healthResult);

    return result;
  } catch (err) {
    warn('[searchStore] syncMissingMessages failed', err);
    return null;
  } finally {
    loading.set(false);
  }
};

const indexMessages = async (messages: Message[] = []): Promise<void> => {
  if (!messages?.length) return;
  await ensureInitialized();
  if (workerClient) {
    try {
      await workerClient.index({
        account: accountId,
        includeBody: get(includeBody),
        messages,
      });
      refreshStats();
      return;
    } catch {
      // ignore and fall back
    }
  }

  // Fallback: ensure main-thread service exists
  await ensureMainThreadService();

  let bodyMap: Map<string, string> | null = null;
  if (get(includeBody)) {
    const keys = messages.map((msg) => [accountId, msg.id]);
    try {
      const bodies = await db.messageBodies.bulkGet(keys);
      bodyMap = new Map();
      bodies?.forEach((rec: { id?: string; textContent?: string; body?: string }) => {
        if (rec?.id) bodyMap!.set(rec.id, rec.textContent || rec.body || '');
      });
    } catch (err) {
      warn('search body lookup failed', err);
    }
  }

  searchService!.upsertEntries(
    messages.map((msg) => mapMessageToDoc(msg, bodyMap?.get(msg.id) || '')),
  );
  await searchService!.persist();
  refreshStats();
};

const removeFromIndex = async (ids: string[] = []): Promise<void> => {
  if (!ids?.length) return;
  await ensureInitialized();
  if (workerClient) {
    try {
      await workerClient.remove({ account: accountId, ids });
      refreshStats();
      return;
    } catch {
      // ignore and fall back
    }
  }
  // Fallback: ensure main-thread service exists
  await ensureMainThreadService();
  searchService!.removeEntriesByIds(ids);
  await searchService!.persist();
  refreshStats();
};

// ── Server-side search via Forward Email API ────────────────────────────
// The API supports GET /v1/messages with search parameters:
//   ?search=  (general text across all fields)
//   ?subject= ?from= ?to= ?body= (field-specific)
//   ?is_unread= ?is_flagged= ?has_attachments=
//   ?since= ?before= ?folder=
// Server search covers message bodies (including PGP-decrypted content
// that was decrypted server-side) which the local FlexSearch index may
// not have if the user never opened the message.

interface ServerSearchParams {
  search?: string;
  subject?: string;
  from?: string;
  to?: string;
  folder?: string;
  is_unread?: boolean;
  is_flagged?: boolean;
  has_attachments?: boolean;
  since?: string;
  before?: string;
  limit?: number;
  page?: number;
  raw?: boolean;
  attachments?: boolean;
}

/**
 * Build API query parameters from parsed search filters.
 * Returns null if there is nothing meaningful to send to the server
 * (e.g. filter-only queries that the server cannot evaluate).
 */
const buildServerSearchParams = (
  text: string,
  filters: ReturnType<typeof parseSearchQuery>['filters'],
  folder: string | null,
  limit: number,
): ServerSearchParams | null => {
  const params: ServerSearchParams = {
    limit,
    page: 1,
    raw: false,
    attachments: false,
  };

  // Free-text goes to the general `search` parameter which searches
  // across subject, body, from, to, and other fields server-side.
  if (text) {
    params.search = text;
  }

  // Map structured operators to API-specific parameters
  if (filters?.from?.length) {
    params.from = filters.from.join(' ');
  }
  if (filters?.to?.length) {
    params.to = filters.to.join(' ');
  }
  if (filters?.subject?.length) {
    params.subject = filters.subject.join(' ');
  }
  if (filters.isUnread === true) {
    params.is_unread = true;
  }
  if (filters.isStarred === true) {
    params.is_flagged = true;
  }
  if (filters.hasAttachment === true) {
    params.has_attachments = true;
  }
  if (filters.after) {
    params.since = new Date(filters.after).toISOString();
  }
  if (filters.before) {
    params.before = new Date(filters.before).toISOString();
  }

  // Folder
  if (folder && folder !== 'all') {
    params.folder = folder;
  }

  // Only send to server if there is at least one meaningful search param
  const hasServerParam = params.search || params.from || params.to || params.subject;
  if (!hasServerParam) return null;

  return params;
};

/**
 * Execute server-side search and return normalized results.
 * Returns an empty array on any error (server search is best-effort).
 */
const serverSearch = async (
  text: string,
  filters: ReturnType<typeof parseSearchQuery>['filters'],
  folder: string | null,
  limit: number,
): Promise<SearchResult[]> => {
  // Skip server search in demo mode — there is no real API
  if (isDemoMode()) return [];

  const params = buildServerSearchParams(text, filters, folder, limit);
  if (!params) return [];

  try {
    const response = await Remote.request('MessageList', params, {
      method: 'GET',
      pathOverride: '/v1/messages',
      perfLabel: 'search.server',
    });

    // The API returns an array of message objects (or an object with a
    // data/messages array depending on the endpoint version).
    const messages: SearchResult[] = Array.isArray(response)
      ? response
      : Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response?.messages)
          ? response.messages
          : [];

    // Normalize dates and ensure folder is set for consistent filtering
    return messages.map((msg: SearchResult) => {
      const dateMs =
        typeof msg.date === 'number'
          ? msg.date
          : Number.isFinite(Date.parse(String(msg.date || '')))
            ? Date.parse(String(msg.date || ''))
            : null;
      return {
        ...msg,
        folder: msg.folder || msg.folder_path || folder || 'INBOX',
        dateMs: dateMs ?? msg.date ?? null,
      } as SearchResult;
    });
  } catch (err) {
    // Server search is best-effort; local results are still returned
    warn('[searchStore] server search failed, using local results only', err);
    return [];
  }
};

/**
 * Merge local and server search results, deduplicating by message ID.
 * Server results take priority (they may have more complete data).
 */
const mergeResults = (localHits: SearchResult[], serverHits: SearchResult[]): SearchResult[] => {
  if (!serverHits.length) return localHits;
  if (!localHits.length) return serverHits;

  const byId = new Map<string, SearchResult>();

  // Local results first (lower priority)
  for (const hit of localHits) {
    if (hit?.id) byId.set(hit.id, hit);
  }

  // Server results overwrite (higher priority — more complete data)
  for (const hit of serverHits) {
    if (hit?.id) byId.set(hit.id, hit);
  }

  return Array.from(byId.values());
};

const search = async (
  q: string,
  { folder = null, crossFolder = false, limit = 200, candidates = [] }: SearchOptions = {},
): Promise<SearchResult[]> => {
  const generation = ++searchGeneration;
  await ensureInitialized();
  const parsed = parseSearchQuery(q || '');
  const { text, filters, ast } = parsed;
  query.set(q || '');

  const hasFilters =
    Boolean(text) ||
    filters?.from?.length > 0 ||
    filters?.to?.length > 0 ||
    filters?.subject?.length > 0 ||
    filters?.labels?.length > 0 ||
    filters.isUnread !== null ||
    filters.hasAttachment !== null ||
    filters.size ||
    filters.folder ||
    filters.before ||
    filters.after ||
    ast;

  if (!hasFilters) {
    if (generation === searchGeneration) results.set([]);
    return [];
  }

  const effectiveFolder = filters.folder || folder;
  const useCrossFolder = crossFolder || filters.scope === 'all' || effectiveFolder === 'all';

  // ── Run local and server search in parallel ───────────────────────
  // Local search provides instant results from the FlexSearch index.
  // Server search provides comprehensive results including message
  // bodies the user has never opened and PGP-decrypted content.
  // We merge both, with server results taking priority on duplicates.

  const serverFolder = useCrossFolder ? null : effectiveFolder;
  const serverPromise = serverSearch(text, filters, serverFolder, limit);

  // Local search path (worker or main-thread fallback)
  let localHits: SearchResult[] = [];
  let workerSearchFailed = false;

  if (workerClient) {
    try {
      const candidateIds = candidates?.length ? candidates.map((c) => c.id).filter(Boolean) : [];
      const res = await workerClient.search({
        account: accountId,
        query: q,
        folder: effectiveFolder,
        crossFolder: useCrossFolder,
        limit,
        candidateIds,
        includeBody: get(includeBody),
      });
      if (res?.stats) stats.set(res.stats);
      localHits = res?.results || [];
    } catch {
      workerSearchFailed = true;
    }
  }

  // Main-thread fallback if worker is unavailable or failed
  if (!localHits.length && (!workerClient || workerSearchFailed)) {
    await ensureMainThreadService();

    if (!text) {
      if (useCrossFolder || !effectiveFolder) {
        localHits = await db.messages.where('account').equals(accountId).toArray();
      } else {
        localHits = await db.messages
          .where('[account+folder]')
          .equals([accountId, effectiveFolder])
          .toArray();
      }
    } else if (useCrossFolder || !candidates?.length) {
      localHits = await searchService!.searchAllFolders(text, limit);
      if (!useCrossFolder && effectiveFolder) {
        localHits = localHits.filter(
          (h) => (h.folder || '').toLowerCase() === effectiveFolder.toLowerCase(),
        );
      }
    } else {
      localHits = searchService!.search(text, candidates, {
        folder: effectiveFolder,
        limit,
        crossFolder: useCrossFolder,
      });
    }

    // Hydrate from cache when we don't already have full message objects
    if (!candidates?.length) {
      const ids = Array.from(new Set((localHits || []).map((h) => h.id).filter(Boolean)));
      if (ids.length) {
        try {
          const records = await db.messages.bulkGet(ids.map((id) => [accountId, id]));
          const byId = new Map<string, SearchResult>();
          records?.forEach((rec: SearchResult | undefined) => {
            if (rec?.id) byId.set(rec.id, rec);
          });
          localHits = localHits.map((h) => {
            const hydrated = byId.get(h.id);
            if (hydrated) return hydrated;
            const parsedDate =
              typeof h.date === 'number'
                ? h.date
                : Number.isFinite(Date.parse(String(h.date) || ''))
                  ? Date.parse(String(h.date) || '')
                  : null;
            return { ...h, dateMs: parsedDate, date: parsedDate || h.date || null } as SearchResult;
          });
        } catch (err) {
          warn('[searchStore] hydrate results failed', err);
        }
      }
    }
  }

  // Wait for server results (best-effort — already running in parallel)
  const serverHits = await serverPromise;

  // A newer search has started — discard these results.
  if (generation !== searchGeneration) return [];

  // Merge local + server results, then apply client-side filters
  const merged = mergeResults(localHits, serverHits);

  const filtered = applySearchFilters(merged || [], {
    ...filters,
    folder: effectiveFolder,
    ast,
  });

  // Also cache any new server-returned messages into IndexedDB so they
  // appear in subsequent local searches and the message list.
  if (serverHits.length) {
    const localIds = new Set(localHits.map((h) => h.id).filter(Boolean));
    const newFromServer = serverHits.filter((h) => h.id && !localIds.has(h.id));
    if (newFromServer.length) {
      // Fire-and-forget: index new messages for future local searches
      indexMessages(newFromServer as Message[]).catch(() => {});
      // Also cache into IndexedDB messages table
      try {
        const toCache = newFromServer.map((msg) => ({
          ...msg,
          account: accountId,
          folder: msg.folder || effectiveFolder || 'INBOX',
        }));
        db.messages.bulkPut(toCache).catch(() => {});
      } catch {
        // best-effort caching
      }
    }
  }

  results.set(filtered || []);
  return filtered;
};

const rebuildFromCache = async (options: RebuildOptions = {}): Promise<{ count: number }> => {
  const { silent = false } = options;
  loading.set(true);
  indexProgress.set({ active: true, current: 0, total: 0, message: 'Preparing index rebuild...' });

  try {
    if (workerClient) {
      const result = await workerClient.rebuildFromCache({
        account: accountId,
        includeBody: get(includeBody),
      });
      if (result?.stats) stats.set(result.stats);

      const count = result?.stats?.count || result?.count || 0;
      indexProgress.set({ active: false, current: count, total: count, message: '' });

      if (!silent) {
        indexToastsRef?.show?.(`Search index built (${count} messages)`, 'success');
      }

      return { count };
    }

    // Fallback: main-thread rebuild
    await ensureMainThreadService();
    const messages = await db.messages.where('account').equals(accountId).toArray();
    const total = messages.length;

    let bodyMap: Map<string, string> | null = null;
    if (get(includeBody)) {
      const keys = messages.map((msg) => [accountId, msg.id]);
      try {
        const bodies = await db.messageBodies.bulkGet(keys);
        bodyMap = new Map();
        bodies?.forEach((rec: { id?: string; textContent?: string; body?: string }) => {
          if (rec?.id) bodyMap!.set(rec.id, rec.textContent || rec.body || '');
        });
      } catch (err) {
        warn('search body lookup failed during rebuild', err);
      }
    }

    const startTime = performance?.now ? performance.now() : Date.now();
    const BATCH_SIZE = 500;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      searchService!.upsertEntries(
        batch.map((msg) => mapMessageToDoc(msg, bodyMap?.get(msg.id) || '')),
      );
      indexProgress.set({
        active: true,
        current: Math.min(i + BATCH_SIZE, total),
        total,
        message: `Indexing ${Math.min(i + BATCH_SIZE, total)} / ${total}`,
      });
    }
    await searchService!.persist();
    refreshStats();

    const elapsed = Math.round(
      ((performance?.now ? performance.now() : Date.now()) - startTime) / 1000,
    );
    indexProgress.set({ active: false, current: total, total, message: '' });

    if (!silent) {
      indexToastsRef?.show?.(
        `Search index built (${messages.length} messages${elapsed > 2 ? `, ${elapsed}s` : ''})`,
        'success',
      );
    }

    return { count: messages.length };
  } catch (err) {
    warn('[searchStore] rebuildFromCache failed', err);
    indexProgress.set({ active: false, current: 0, total: 0, message: '' });
    indexToastsRef?.show?.('Search index build failed', 'error');
    throw err;
  } finally {
    loading.set(false);
  }
};

const saveSearch = async (
  name: string,
  q: string,
  options: Record<string, unknown> = {},
): Promise<SavedSearch> => {
  await ensureInitialized();
  const saved = await savedSearchService!.save(name, q, options);
  await refreshSavedSearches();
  return saved;
};

const deleteSavedSearch = async (name: string): Promise<void> => {
  await ensureInitialized();
  await savedSearchService!.delete(name);
  await refreshSavedSearches();
};

const setIncludeBody = async (value: boolean): Promise<void> => {
  const next = Boolean(value);
  includeBody.set(next);
  Local.set('search_body_indexing', next ? 'true' : 'false');
  Local.set('include_body', next ? 'true' : 'false');

  // Reinitialize search service so body flag propagates
  searchService = null;
  if (workerClient) {
    try {
      await workerClient.init(accountId, next);
    } catch {
      // ignore
    }
  }
  await ensureInitialized(accountId);
};

/**
 * Reset search connection state - call when switching accounts or during recovery
 */
const resetSearchConnection = (): void => {
  syncWorkerConnected = false;
  startupCheckDone = false;
};

/**
 * Terminate search worker and cleanup - call during shutdown or HMR
 */
const terminateWorker = (): void => {
  if (workerClient) {
    try {
      workerClient.terminate();
    } catch {
      // Ignore termination errors
    }
    workerClient = null;
  }
  syncWorkerConnected = false;
  startupCheckDone = false;
  searchService = null;
};

export const searchStore = {
  state: {
    ready,
    loading,
    stats,
    error,
    query,
    results,
    savedSearches,
    includeBody,
    health,
  },
  actions: {
    ensureInitialized,
    indexMessages,
    removeFromIndex,
    search,
    rebuildFromCache,
    syncMissingMessages,
    saveSearch,
    deleteSavedSearch,
    refreshSavedSearches,
    setIncludeBody,
    checkHealth,
    getWorkerClient,
    resetSearchConnection,
    terminateWorker,
  },
};

// HMR cleanup - terminate workers when module is replaced during development
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    terminateWorker();
  });
}
