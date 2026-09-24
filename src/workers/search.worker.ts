/**
 * Dedicated Search Worker
 *
 * Handles FlexSearch indexing and search operations off the main thread.
 * Database operations are routed through db.worker.js via MessageChannel.
 */

import { parseSearchQuery, applySearchFilters } from '../utils/search-query.js';
import { SearchService, setSearchDbClient } from '../utils/search-service.js';
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

interface ServiceEntry {
  service: SearchService;
  includeBody: boolean;
}

interface QueueEntry {
  messages: Message[];
  ids: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  includeBody: boolean;
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

const services = new Map<string, ServiceEntry>(); // key: account -> { service, includeBody }

// Batch queue for incremental indexing from sync worker
const indexQueue = new Map<string, QueueEntry>(); // key: account -> { messages: [], timer: null, includeBody: boolean }
const INDEX_BATCH_DELAY = 100; // ms to wait before processing batch
const INDEX_BATCH_SIZE = 100;

function accountKey(account: string | undefined | null): string {
  return account || 'default';
}

async function ensureService(
  account: string = 'default',
  includeBody: boolean = false,
): Promise<SearchService> {
  const key = accountKey(account);
  const existing = services.get(key);
  if (existing && existing.includeBody === includeBody) {
    return existing.service;
  }

  const service = new SearchService({ includeBody, account: key });
  await service.loadFromCache();
  services.set(key, { service, includeBody });
  return service;
}

async function indexMessages(
  payload: IndexPayload = {},
): Promise<{ count: number; stats?: SearchStats }> {
  const { account = 'default', includeBody = false, messages = [] } = payload;
  if (!messages.length) return { count: 0 };
  const service = await ensureService(account, includeBody);

  let bodyMap: Map<string, string> | null = null;
  if (includeBody && dbConnected) {
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

  service.upsertEntries(messages.map((msg) => mapMessageToDoc(msg, bodyMap?.get(msg.id) || '')));
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
  const service = await ensureService(account);
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

  // Create fresh service
  const service = new SearchService({ includeBody, account: key });
  services.set(key, { service, includeBody });

  if (!dbConnected) {
    console.warn('[search.worker] No db connection for rebuildFromCache');
    await service.persist();
    return { count: 0, stats: service.getStats() };
  }

  // Load all messages from database
  const messages = await dbClient.messages.where('account').equals(key).toArray();

  if (!messages?.length) {
    await service.persist();
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

  // Index all messages
  const docs = messages.map((msg: Message) => mapMessageToDoc(msg, bodyMap?.get(msg.id) || ''));
  service.upsertEntries(docs);
  await service.persist();

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
  const { account = 'default', includeBody = false, messages = [] } = payload;
  if (!messages.length) return;

  const key = accountKey(account);
  let queue = indexQueue.get(key);
  if (!queue) {
    queue = { messages: [], ids: new Set(), timer: null, includeBody };
    indexQueue.set(key, queue);
  }

  // Deduplicate by ID using persistent Set
  for (const msg of messages) {
    if (msg?.id && !queue.ids.has(msg.id)) {
      queue.messages.push(msg);
      queue.ids.add(msg.id);
    }
  }

  if (includeBody) queue.includeBody = true;

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
    await indexMessages({
      account,
      includeBody: queue.includeBody,
      messages,
    });
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
    const service = services.get(account)?.service;
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
      await ensureService(
        (payload?.account as string) || 'default',
        (payload?.includeBody as boolean) || false,
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
