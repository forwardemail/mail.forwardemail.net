import FlexSearch from 'flexsearch';
import { warn } from './logger.ts';

export const SEARCH_INDEX_KEY = 'messages_v1';

// Optional db client - can be injected for workers that don't have direct db access
let dbClient = null;

/**
 * Set the database client for search service persistence
 * Call this before creating SearchService instances in workers
 */
export function setSearchDbClient(client) {
  dbClient = client;
}
export const SEARCH_PRESETS = {
  MINIMAL: {
    fields: ['subject', 'from', 'snippet', 'labelsText'],
    estimatedSizeMultiplier: 0.15,
  },
  STANDARD: {
    fields: ['subject', 'from', 'snippet', 'to', 'cc', 'labelsText'],
    estimatedSizeMultiplier: 0.2,
  },
  FULL: {
    fields: ['subject', 'from', 'to', 'cc', 'snippet', 'labelsText', 'body'],
    estimatedSizeMultiplier: 0.35,
  },
};

function accountKey(account) {
  return account || 'default';
}

function createDocument(includeBody = false, fields = null) {
  const indexFields =
    fields || (includeBody ? SEARCH_PRESETS.FULL.fields : SEARCH_PRESETS.MINIMAL.fields);

  return new FlexSearch.Document({
    document: {
      id: 'id',
      index: indexFields,
      // IMPORTANT: Include 'id' in store so it's available in enriched results
      store: ['id', 'folder', 'subject', 'from', 'to', 'cc', 'snippet', 'labels', 'date'],
    },
    tokenize: 'forward',
    context: {
      resolution: 9,
      depth: 3,
      bidirectional: true,
    },
    encoder: FlexSearch.Charset.LatinBalance,
    resolution: 9,
  });
}

/** Rough byte weight of one entry, used for the size the stats report. */
const entrySize = (e) =>
  (e.subject?.length || 0) +
  (e.from?.length || 0) +
  (e.to?.length || 0) +
  (e.cc?.length || 0) +
  (e.snippet?.length || 0) +
  (e.labelsText?.length || 0) +
  (e.body?.length || 0);

export class SearchService {
  constructor({ includeBody = false, account, preset = null } = {}) {
    this.includeBody = includeBody;
    this.account = accountKey(account);
    this.preset = preset || (includeBody ? 'FULL' : 'MINIMAL');
    this.index = createDocument(includeBody, preset ? SEARCH_PRESETS[preset]?.fields : null);
    // Keyed by id so an update replaces in place. This used to be an array
    // that removeEntry() filtered in full for every upsert, which made a
    // sync batch against a big index O(batch x index) and showed up as the
    // renderer pegging a core for minutes.
    this._entries = new Map();
    this.sizeBytes = 0;
    this.folderIndexes = new Map();
    // Coalesced persistence. persist() writes the whole entries array, so
    // calling it once per sync batch made initial indexing O(n^2) in bytes
    // written (each of N batches rewrites the growing blob). Mutations now
    // schedulePersist() instead, which debounces the write so a sync burst
    // produces a few writes at the final size rather than one per batch.
    this._persistTimer = null;
    this._persistPending = false;
    this._persistInFlight = null;
  }

  async loadFromCache() {
    if (!dbClient) {
      warn('[SearchService] No db client available for loadFromCache');
      return 0;
    }

    // Use array form for compound primary key lookup
    const cached = await dbClient.searchIndex.get([this.account, SEARCH_INDEX_KEY]);

    if (cached?.data?.length) {
      this._entries = new Map();
      this.index = createDocument(this.includeBody);
      for (const raw of cached.data) {
        if (!raw?.id) continue;
        // Normalize entries - ensure labelsText exists for proper FlexSearch indexing
        const entry =
          raw.labelsText !== undefined
            ? raw
            : { ...raw, labelsText: (Array.isArray(raw.labels) ? raw.labels : []).join(' ') };
        this._entries.set(entry.id, entry);
        this.index.add(entry);
      }
      this.sizeBytes = cached.sizeBytes || 0;
      return this._entries.size;
    }
    return 0;
  }

  async reset(entries = []) {
    this.index = createDocument(this.includeBody);
    this._entries = new Map();
    this.sizeBytes = 0;
    entries.forEach((entry) => this.addEntry(entry));
    await this.persist();
  }

  addEntry(entry) {
    if (!entry?.id) {
      return;
    }
    const labelsArray = Array.isArray(entry.labels)
      ? entry.labels.map((l) => (typeof l === 'string' ? l : String(l || ''))).filter(Boolean)
      : [];
    const safeEntry = {
      id: entry.id,
      folder: entry.folder || '',
      subject: entry.subject || '',
      from: entry.from || '',
      to: entry.to || '',
      cc: entry.cc || '',
      snippet: entry.snippet || '',
      date: entry.date || '',
      // Store as array for retrieval, but FlexSearch will index the joined string
      labels: labelsArray,
      // FlexSearch needs a string for proper tokenization - join labels with spaces
      labelsText: labelsArray.join(' '),
      body: this.includeBody ? entry.body || entry.textContent || '' : undefined,
    };
    this._entries.set(safeEntry.id, safeEntry);
    this.sizeBytes += entrySize(safeEntry);
    try {
      this.index.add(safeEntry);
    } catch {
      // ignore add failures
    }
  }

  removeEntry(entryId) {
    if (!entryId) return;
    const existing = this._entries.get(entryId);
    if (existing) {
      this._entries.delete(entryId);
      this.sizeBytes = Math.max(0, this.sizeBytes - entrySize(existing));
    }
    try {
      this.index.remove(entryId);
    } catch {
      // ignore
    }
  }

  /** Entries in insertion order. A fresh array each call; prefer size() for counts. */
  get entries() {
    return Array.from(this._entries.values());
  }

  size() {
    return this._entries.size;
  }

  updateEntry(entry) {
    if (!entry?.id) return;
    this.removeEntry(entry.id);
    this.addEntry(entry);
  }

  upsertEntries(entries = []) {
    entries.forEach((entry) => this.updateEntry(entry));
  }

  removeEntriesByIds(ids = []) {
    ids.forEach((id) => this.removeEntry(id));
  }

  async persist() {
    // Any direct persist() satisfies a pending scheduled write: it captures
    // the full current in-memory state, so a queued flush would be redundant.
    this._persistPending = false;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }

    if (!dbClient) {
      warn('[SearchService] No db client available for persist');
      return;
    }

    let sizeBytes = this.sizeBytes;
    if (!sizeBytes) {
      for (const e of this._entries.values()) sizeBytes += entrySize(e);
    }
    this.sizeBytes = sizeBytes;

    await dbClient.searchIndex.put({
      key: SEARCH_INDEX_KEY,
      account: this.account,
      data: this.entries,
      sizeBytes,
      updatedAt: Date.now(),
    });
    await dbClient.indexMeta.put({
      key: SEARCH_INDEX_KEY,
      account: this.account,
      value: {
        count: this._entries.size,
        includeBody: this.includeBody,
        sizeBytes,
      },
      updatedAt: Date.now(),
    });
  }

  // Debounce window for coalesced writes. Long enough to swallow a burst of
  // 100-message sync batches (which arrive ~100ms apart), short enough that a
  // single interactive change (star, label, delete) lands quickly.
  static PERSIST_DEBOUNCE_MS = 800;

  /**
   * Request a persist without writing immediately. Repeated calls during a
   * burst collapse into a single trailing write. Never rejects; write errors
   * are logged inside persist(). Safe to call fire-and-forget.
   */
  schedulePersist() {
    this._persistPending = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      // Ignore the returned promise; callers that need durability use flush().
      void this.flush();
    }, SearchService.PERSIST_DEBOUNCE_MS);
  }

  /**
   * Force any pending scheduled write to happen now and resolve when the
   * on-disk index reflects the current in-memory state. Serializes against an
   * in-flight write so two flushes can't interleave partial blobs.
   */
  async flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (!this._persistPending && !this._persistInFlight) return;
    // Coalesce concurrent flushes onto one chain; mark pending consumed.
    if (this._persistInFlight) {
      await this._persistInFlight.catch(() => {});
    }
    if (!this._persistPending) return;
    this._persistPending = false;
    this._persistInFlight = this.persist().finally(() => {
      this._persistInFlight = null;
    });
    return this._persistInFlight;
  }

  async addAndPersist(entries = []) {
    entries.forEach((entry) => this.addEntry(entry));
    await this.persist();
  }

  search(query, candidates = [], options = {}) {
    const q = (query || '').trim();
    if (!q) return candidates;
    if (!this.index) return candidates;

    const { folder = null, limit = 100, enrich = true, crossFolder = false } = options;

    const results = this.index.search(q, { enrich, limit });
    const ids = new Set();
    const hits = [];
    const candidateMap = new Map((candidates || []).map((c) => [c.id, c]));

    results.forEach((res) => {
      const arr = res?.result || res || [];
      arr.forEach((result) => {
        const id = typeof result === 'object' ? result.id : result;
        if (ids.has(id)) return;

        const match = candidateMap.get(id);
        if (match) {
          // If folder specified and not cross-folder, filter by folder
          if (folder && !crossFolder && match.folder !== folder) return;

          ids.add(id);
          hits.push(match);
        }
      });
    });

    return hits;
  }

  async searchAllFolders(query, limit = 100) {
    const q = (query || '').trim();
    if (!q) return [];
    if (!this.index) return [];

    const results = this.index.search(q, { enrich: true, limit });

    const ids = new Set();
    const hits = [];
    results.forEach((res) => {
      const arr = res?.result || res || [];
      arr.forEach((result) => {
        if (typeof result === 'object' && result.doc) {
          const doc = result.doc;
          if (!ids.has(doc.id)) {
            ids.add(doc.id);
            hits.push({
              id: doc.id,
              folder: doc.folder,
              subject: doc.subject,
              from: doc.from,
              to: doc.to,
              cc: doc.cc,
              snippet: doc.snippet,
              labels: doc.labels,
              date: doc.date,
              score: result.score || 1,
            });
          }
        }
      });
    });

    return hits.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  getStats() {
    return {
      count: this._entries.size,
      sizeBytes: this.sizeBytes,
      includeBody: this.includeBody,
      preset: this.preset,
      account: this.account,
    };
  }
}

// Saved Searches functionality
export class SavedSearchService {
  constructor(account) {
    this.account = accountKey(account);
  }

  async save(name, query, options = {}) {
    if (!dbClient) {
      warn('[SavedSearchService] No db client available for save');
      return null;
    }
    const savedSearch = {
      name,
      query,
      folder: options.folder || null,
      crossFolder: options.crossFolder || false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await dbClient.meta.put({
      key: `saved_search_${this.account}_${name}`,
      value: savedSearch,
      updatedAt: Date.now(),
    });

    return savedSearch;
  }

  async getAll() {
    if (!dbClient) {
      warn('[SavedSearchService] No db client available for getAll');
      return [];
    }
    const prefix = `saved_search_${this.account}_`;
    const all = await dbClient.meta.where('key').startsWith(prefix).toArray();
    return all.map((item) => item.value).filter(Boolean);
  }

  async get(name) {
    if (!dbClient) {
      warn('[SavedSearchService] No db client available for get');
      return null;
    }
    const key = `saved_search_${this.account}_${name}`;
    const item = await dbClient.meta.get(key);
    return item?.value || null;
  }

  async delete(name) {
    if (!dbClient) {
      warn('[SavedSearchService] No db client available for delete');
      return false;
    }
    const key = `saved_search_${this.account}_${name}`;
    await dbClient.meta.delete(key);
    return true;
  }

  async update(name, updates) {
    const existing = await this.get(name);
    if (!existing) throw new Error('Saved search not found');

    const updated = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    await dbClient.meta.put({
      key: `saved_search_${this.account}_${name}`,
      value: updated,
      updatedAt: Date.now(),
    });

    return updated;
  }
}
