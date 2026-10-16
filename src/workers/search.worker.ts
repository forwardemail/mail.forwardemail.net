/**
 * Dedicated Search Worker
 *
 * Handles FlexSearch indexing and search operations off the main thread.
 * Database operations are routed through db.worker.js via MessageChannel.
 */

import { parseSearchQuery, applySearchFilters } from '../utils/search-query.js';
import { SearchService, setSearchDbClient, SEARCH_INDEX_KEY } from '../utils/search-service.js';
import { mapMessageToDoc } from '../utils/search-mapping.js';
import { dbClient, connectToDbWorker } from '../utils/db-worker-client.js';

// ============================================================================
// Types
// ============================================================================

interface Message {
  id: string;
  folder?: string;
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  snippet?: string;
  date?: number | string;
  dateMs?: number;
  labels?: string[];
  labelIds?: string[];
  label_ids?: string[];
  body?: string;
  textContent?: string;
}

interface SearchHit {
  id: string;
  folder?: string;
  from?: string;
  to?: string | string[];
  subject?: string;
  date?: number | string;
  dateMs?: number;
}

interface IndexPayload {
  account?: string;
  includeBody?: boolean;
  messages?: Message[];
}

interface RemovePayload {
  account?: string;
  ids?: string[];
}

interface RebuildPayload {
  account?: string;
  includeBody?: boolean;
}

interface StatsPayload {
  account?: string;
  includeBody?: boolean;
}

interface HealthPayload {
  account?: string;
  includeBody?: boolean;
}

interface SearchPayload {
  account?: string;
  query?: string;
  folder?: string | null;
  crossFolder?: boolean;
  limit?: number;
  candidateIds?: string[];
  includeBody?: boolean;
}

interface QueueEntry {
  messages: Message[];
  ids: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

interface SearchWorkerMessage {
  id?: number;
  action?: string;
  payload?: Record<string, unknown>;
}

interface SearchStats {
  count: number;
}

interface HealthResult {
  healthy: boolean;
  messagesCount: number;
  indexCount: number;
  divergence: number;
  stats: SearchStats;
  needsRebuild: boolean;
  needsIncrementalSync: boolean;
}

// ============================================================================
// Database Client via MessageChannel
// ============================================================================

let dbConnected = false;

// ============================================================================
// Search Service Management
// ============================================================================

// One service per account for the life of the worker. Whether bodies are
// indexed is a setting of that service (see applyIncludeBody), never a reason
// to build another one. Swapping services used to reload the last persisted
// index, which brought back messages removed since that write and dropped the
// body text whenever a caller asked for the other mode.
const services = new Map<string, SearchService>();
const loadingServices = new Map<string, Promise<SearchService>>();

// Removal sequence per account. An index call that awaits the database can
// finish after a removal of one of its messages; it compares sequences and
// leaves those out instead of adding them back.
let removalSeq = 0;
const lastRemovedAt = new Map<string, Map<string, number>>();
const REMOVAL_LOG_LIMIT = 5000;

function noteRemoved(key: string, ids: string[]): void {
  let log = lastRemovedAt.get(key);
  if (!log) {
    log = new Map();
    lastRemovedAt.set(key, log);
  }
  removalSeq += 1;
  for (const id of ids) {
    log.delete(id);
    log.set(id, removalSeq);
  }
  // Oldest first (Map keeps insertion order), so trimming drops the oldest.
  while (log.size > REMOVAL_LOG_LIMIT) {
    log.delete(log.keys().next().value as string);
  }
}

function removedSince(key: string, id: string, seq: number): boolean {
  const at = lastRemovedAt.get(key)?.get(id);
  return at !== undefined && at > seq;
}

// Batch queue for incremental indexing from sync worker
const indexQueue = new Map<string, QueueEntry>(); // key: account -> { messages: [], ids, timer }
const INDEX_BATCH_DELAY = 100; // ms to wait before processing batch
const INDEX_BATCH_SIZE = 100;

function accountKey(account: string | undefined | null): string {
  return account || 'default';
}

// The mode the index was last saved with, so a service created by the sync
// worker's port (which has no say in the setting) keeps the user's choice.
async function persistedIncludeBody(key: string): Promise<boolean> {
  if (!dbConnected) return false;
  try {
    const meta = await dbClient.indexMeta.get([key, SEARCH_INDEX_KEY]);
    return Boolean(meta?.value?.includeBody);
  } catch {
    return false;
  }
}

/**
 * The account's search service, created and loaded once. `includeBody` only
 * picks the mode when the service does not exist yet; changing the mode of a
 * live service is applyIncludeBody's job. Concurrent callers share one load,
 * so a removal that arrives while the cache is loading lands on the same
 * service instead of one that is about to be replaced.
 */
async function ensureService(
  account: string = 'default',
  includeBody?: boolean,
): Promise<SearchService> {
  const key = accountKey(account);
  const existing = services.get(key);
  if (existing) return existing;
  const loading = loadingServices.get(key);
  if (loading) return loading;

  const load = (async () => {
    const mode = typeof includeBody === 'boolean' ? includeBody : await persistedIncludeBody(key);
    const service = new SearchService({ includeBody: mode, account: key });
    await service.loadFromCache();
    services.set(key, service);
    return service;
  })().finally(() => {
    loadingServices.delete(key);
  });
  loadingServices.set(key, load);
  return load;
}

// Explicit mode change from the user's setting (init) or a rebuild.
async function applyIncludeBody(account: string, includeBody: boolean): Promise<SearchService> {
  const service = await ensureService(account, includeBody);
  service.setIncludeBody(includeBody);
  return service;
}

async function indexMessages(
  payload: IndexPayload = {},
): Promise<{ count: number; stats?: SearchStats }> {
  const { account = 'default', messages = [] } = payload;
  if (!messages.length) return { count: 0 };
  const key = accountKey(account);
  const startSeq = removalSeq;
  // payload.includeBody only says whether these messages carry body text.
  // Whether the index stores bodies is the service's own setting.
  const service = await ensureService(key);

  let bodyMap: Map<string, string> | null = null;
  if (service.includeBody && dbConnected) {
    const keys = messages.map((msg) => [accountKey(account), msg.id]);
    try {
      const bodies = await dbClient.messageBodies.bulkGet(keys);
      bodyMap = new Map();
      bodies?.forEach((rec: { id?: string; textContent?: string; body?: string }) => {
        if (rec?.id) bodyMap!.set(rec.id, rec.textContent || rec.body || '');
      });
    } catch (err) {
      console.warn('[search.worker] body lookup failed', err);
    }
  }

  const live = messages.filter((msg) => !removedSince(key, msg.id, startSeq));
  service.upsertEntries(live.map((msg) => mapMessageToDoc(msg, bodyMap?.get(msg.id) || '')));
  // Debounced: a sync burst of many batches collapses into a few writes.
  // processIndexQueue flushes when the queue drains; stats come from the
  // in-memory index, so the returned count is correct without awaiting a write.
  service.schedulePersist();
  return { count: service.getStats().count, stats: service.getStats() };
}

async function removeFromIndex(
  payload: RemovePayload = {},
): Promise<{ count: number; stats?: SearchStats }> {
  const { account = 'default', ids = [] } = payload;
  if (!ids.length) return { count: 0 };
  const key = accountKey(account);
  noteRemoved(key, ids);
  // A queued sync batch that still holds one of these would add it back.
  const queue = indexQueue.get(key);
  if (queue?.messages.length) {
    const gone = new Set(ids);
    queue.messages = queue.messages.filter((msg) => !gone.has(msg.id));
    gone.forEach((id) => queue.ids.delete(id));
  }
  const service = await ensureService(key);
  service.removeEntriesByIds(ids);
  service.schedulePersist();
  return { count: service.getStats().count, stats: service.getStats() };
}

// Rebuild the entire search index from messages in database
async function rebuildFromCache(
  payload: RebuildPayload = {},
): Promise<{ count: number; stats: SearchStats }> {
  const { account = 'default', includeBody = false } = payload;
  const key = accountKey(account);
  // The database snapshot read below can predate a removal that lands while
  // it is being read, so anything removed after this point is left out.
  const startSeq = removalSeq;
  // Rebuild the live service in place rather than replacing it, so nothing
  // else holds on to a service that is no longer the account's.
  const service = await applyIncludeBody(key, includeBody);

  if (!dbConnected) {
    console.warn('[search.worker] No db connection for rebuildFromCache');
    await service.reset([]);
    return { count: 0, stats: service.getStats() };
  }

  // Load all messages from database
  const messages: Message[] = await dbClient.messages.where('account').equals(key).toArray();

  if (!messages?.length) {
    await service.reset([]);
    return { count: 0, stats: service.getStats() };
  }

  // Optionally load body text
  let bodyMap: Map<string, string> | null = null;
  if (includeBody) {
    const keys = messages.map((msg: Message) => [key, msg.id]);
    try {
      const bodies = await dbClient.messageBodies.bulkGet(keys);
      bodyMap = new Map();
      bodies?.forEach((rec: { id?: string; textContent?: string; body?: string }) => {
        if (rec?.id) bodyMap!.set(rec.id, rec.textContent || rec.body || '');
      });
    } catch (err) {
      console.warn('[search.worker] rebuildFromCache body lookup failed', err);
    }
  }

  // Index all messages, leaving out any removed while the snapshot was read
  const docs = messages
    .filter((msg: Message) => !removedSince(key, msg.id, startSeq))
    .map((msg: Message) => mapMessageToDoc(msg, bodyMap?.get(msg.id) || ''));
  await service.reset(docs);

  return { count: service.getStats().count, stats: service.getStats() };
}

// Get stats and health check info
async function getStats(payload: StatsPayload = {}): Promise<{ stats: SearchStats }> {
  const { account = 'default', includeBody = false } = payload;
  const service = await ensureService(account, includeBody);
  return { stats: service.getStats() };
}

// Health check: compare index count vs messages count
async function getHealth(payload: HealthPayload = {}): Promise<HealthResult> {
  const { account = 'default', includeBody = false } = payload;
  const key = accountKey(account);
  const service = await ensureService(key, includeBody);
  const indexStats = service.getStats();

  let messagesCount = 0;
  if (dbConnected) {
    try {
      messagesCount = await dbClient.messages.where('account').equals(key).count();
    } catch (err) {
      console.warn('[search.worker] getHealth count failed', err);
    }
  }

  const indexCount = indexStats.count || 0;
  const divergence = messagesCount - indexCount;
  const healthy = Math.abs(divergence) <= Math.max(10, messagesCount * 0.01);

  return {
    healthy,
    messagesCount,
    indexCount,
    divergence,
    stats: indexStats,
    needsRebuild: messagesCount > 0 && indexCount === 0,
    needsIncrementalSync: messagesCount > 0 && indexCount > 0 && divergence > 0,
  };
}

// Incrementally index messages that are in database but not in the index
async function syncMissingMessages(
  payload: HealthPayload = {},
): Promise<{ synced: number; stats: SearchStats }> {
  const { account = 'default', includeBody = false } = payload;
  const key = accountKey(account);
  const service = await ensureService(key, includeBody);

  if (!dbConnected) {
    return { synced: 0, stats: service.getStats() };
  }

  // Get all message IDs from database
  const allMessages: Message[] = await dbClient.messages.where('account').equals(key).toArray();
  if (!allMessages?.length) {
    return { synced: 0, stats: service.getStats() };
  }

  // Get indexed IDs from the service
  const indexedIds = new Set(service.entries.map((e: { id: string }) => e.id));

  // Find messages not in index
  const missing = allMessages.filter((msg) => !indexedIds.has(msg.id));
  if (!missing.length) {
    return { synced: 0, stats: service.getStats() };
  }

  // Optionally load body text for missing messages
  let bodyMap: Map<string, string> | null = null;
  if (includeBody) {
    const keys = missing.map((msg) => [key, msg.id]);
    try {
      const bodies = await dbClient.messageBodies.bulkGet(keys);
      bodyMap = new Map();
      bodies?.forEach((rec: { id?: string; textContent?: string; body?: string }) => {
        if (rec?.id) bodyMap!.set(rec.id, rec.textContent || rec.body || '');
      });
    } catch (err) {
      console.warn('[search.worker] syncMissing body lookup failed', err);
    }
  }

  // Index missing messages
  const docs = missing.map((msg) => mapMessageToDoc(msg, bodyMap?.get(msg.id) || ''));
  service.upsertEntries(docs);
  await service.persist();

  return { synced: missing.length, stats: service.getStats() };
}

// Queue messages for batched indexing (used by sync worker channel)
function queueForIndexing(payload: IndexPayload = {}): void {
  const { account = 'default', messages = [] } = payload;
  if (!messages.length) return;

  const key = accountKey(account);
  let queue = indexQueue.get(key);
  if (!queue) {
    queue = { messages: [], ids: new Set(), timer: null };
    indexQueue.set(key, queue);
  }

  // Deduplicate by ID using persistent Set
  for (const msg of messages) {
    if (msg?.id && !queue.ids.has(msg.id)) {
      queue.messages.push(msg);
      queue.ids.add(msg.id);
    }
  }

  if (queue.timer) clearTimeout(queue.timer);
  queue.timer = setTimeout(() => processIndexQueue(key), INDEX_BATCH_DELAY);

  if (queue.messages.length >= INDEX_BATCH_SIZE) {
    clearTimeout(queue.timer);
    processIndexQueue(key);
  }
}

async function processIndexQueue(account: string): Promise<void> {
  const queue = indexQueue.get(account);
  if (!queue || !queue.messages.length) return;

  const messages = queue.messages.splice(0, INDEX_BATCH_SIZE);
  queue.timer = null;

  for (const msg of messages) {
    if (msg?.id) queue.ids.delete(msg.id);
  }

  try {
    await indexMessages({ account, messages });
  } catch (err) {
    console.warn('[search.worker] batch index failed', err);
  }

  if (queue.messages.length > 0) {
    queue.timer = setTimeout(() => processIndexQueue(account), INDEX_BATCH_DELAY);
  } else {
    // Queue drained: force the coalesced write so the burst ends with the
    // index durably persisted rather than waiting on the debounce timer
    // (which a worker teardown could skip). Fire-and-forget; the in-memory
    // index is already up to date for queries.
    const service = services.get(account);
    service?.flush?.()?.catch((err: unknown) => {
      console.warn('[search.worker] index write failed', err);
    });
  }
}

async function hydrateMessages(account: string, hits: SearchHit[] = []): Promise<SearchHit[]> {
  if (!hits.length || !dbConnected) return hits;
  const filtered = hits.filter((h) => h && (h.id || h.id === ''));
  if (!filtered.length) return hits;

  const keys = filtered.map((h) => [accountKey(account), h.id]);
  try {
    const records = await dbClient.messages.bulkGet(keys);
    const byId = new Map<string, SearchHit>();
    records?.forEach((rec: SearchHit | undefined) => {
      if (rec?.id) byId.set(rec.id, rec);
    });
    return filtered.map((h) => {
      const hydrated = byId.get(h.id);
      if (hydrated) return hydrated;
      const parsedDate =
        typeof h.date === 'number'
          ? h.date
          : Number.isFinite(Date.parse(h.date || ''))
            ? Date.parse(h.date || '')
            : null;
      return { ...h, dateMs: parsedDate ?? undefined, date: parsedDate || h.date || undefined };
    });
  } catch (err) {
    console.warn('[search.worker] hydrate failed', err);
    return filtered;
  }
}

async function runSearch(
  payload: SearchPayload = {},
): Promise<{ results: SearchHit[]; stats: SearchStats }> {
  const {
    account = 'default',
    query = '',
    folder = null,
    crossFolder = false,
    limit = 200,
    candidateIds = [],
    includeBody = false,
  } = payload;

  const service = await ensureService(account, includeBody);
  const stats = service.getStats();
  const parsed = parseSearchQuery(query || '');
  const { text, filters, ast } = parsed;

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
    return { results: [], stats };
  }

  const effectiveFolder = filters.folder || folder;
  const useCrossFolder = crossFolder || filters.scope === 'all' || effectiveFolder === 'all';

  // Filter-only search (no text) - load from database
  if (!text && dbConnected) {
    const accountKeyed = accountKey(account);
    let base: Message[] = [];
    if (useCrossFolder || !effectiveFolder) {
      base = await dbClient.messages.where('account').equals(accountKeyed).toArray();
    } else {
      base = await dbClient.messages
        .where('[account+folder]')
        .equals([accountKeyed, effectiveFolder])
        .toArray();
    }
    const filtered = applySearchFilters(base || [], {
      ...filters,
      folder: effectiveFolder,
      ast,
    });
    return { results: (filtered || []).slice(0, limit) as SearchHit[], stats };
  }

  // Text search - use FlexSearch index
  let hits: SearchHit[] = await service.searchAllFolders(text, limit);

  if (!useCrossFolder && effectiveFolder) {
    hits = hits.filter(
      (h) => (h.folder || '').toLowerCase() === String(effectiveFolder).toLowerCase(),
    );
  }

  if (candidateIds?.length) {
    const idSet = new Set(candidateIds);
    hits = hits.filter((h) => idSet.has(h.id));
  }

  // Deduplicate
  const seen = new Set<string>();
  hits = (hits || []).filter((h) => {
    if (!h?.id && h?.id !== '') return false;
    const key = String(h.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Hydrate from database
  hits = await hydrateMessages(account, hits);

  const filtered = applySearchFilters(hits || [], {
    ...filters,
    folder: effectiveFolder,
    ast,
  });

  return { results: filtered || [], stats: service.getStats() };
}

// ============================================================================
// Message Handlers
// ============================================================================

function respond(id: number | undefined, ok: boolean, result: unknown, error?: string): void {
  self.postMessage({ id, ok, result, error });
}

// Handle messages from sync worker via MessagePort
function handleSyncWorkerMessage(event: MessageEvent): void {
  const { action, payload } = event.data || {};
  if (action === 'index') {
    queueForIndexing(payload);
  } else if (action === 'remove') {
    removeFromIndex(payload).catch((err) => {
      console.warn('[search.worker] remove from sync worker failed', err);
    });
  }
}

self.onmessage = async (event: MessageEvent<SearchWorkerMessage>) => {
  const { id, action, payload } = event.data || {};

  // Handle database port connection
  if (
    action === 'connectDbPort' &&
    (event as MessageEvent & { ports?: MessagePort[] }).ports?.[0]
  ) {
    connectToDbWorker((event as MessageEvent & { ports: MessagePort[] }).ports[0]);
    dbConnected = true;
    // Set up db client for SearchService persistence
    setSearchDbClient(dbClient);
    respond(id, true, { ok: true, connected: true });
    return;
  }

  // Handle sync worker port connection
  if (
    action === 'connectSyncPort' &&
    (event as MessageEvent & { ports?: MessagePort[] }).ports?.[0]
  ) {
    const port = (event as MessageEvent & { ports: MessagePort[] }).ports[0];
    port.onmessage = handleSyncWorkerMessage;
    port.start();
    respond(id, true, { ok: true, connected: true });
    return;
  }

  try {
    if (action === 'init') {
      await applyIncludeBody(
        (payload?.account as string) || 'default',
        Boolean(payload?.includeBody),
      );
      respond(id, true, { ok: true });
      return;
    }
    if (action === 'index') {
      const res = await indexMessages(payload as IndexPayload);
      respond(id, true, res);
      return;
    }
    if (action === 'remove') {
      const res = await removeFromIndex(payload as RemovePayload);
      respond(id, true, res);
      return;
    }
    if (action === 'search') {
      const res = await runSearch(payload as SearchPayload);
      respond(id, true, res);
      return;
    }
    if (action === 'rebuildFromCache') {
      const res = await rebuildFromCache(payload as RebuildPayload);
      respond(id, true, res);
      return;
    }
    if (action === 'getStats') {
      const res = await getStats(payload as StatsPayload);
      respond(id, true, res);
      return;
    }
    if (action === 'getHealth') {
      const res = await getHealth(payload as HealthPayload);
      respond(id, true, res);
      return;
    }
    if (action === 'syncMissingMessages') {
      const res = await syncMissingMessages(payload as HealthPayload);
      respond(id, true, res);
      return;
    }
    respond(id, false, null, 'Unknown action');
  } catch (err) {
    respond(id, false, null, (err as Error)?.message || String(err));
  }
};
