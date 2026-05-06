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

export class SearchService {
  constructor({ includeBody = false, account, preset = null } = {}) {
    this.includeBody = includeBody;
    this.account = accountKey(account);
    this.preset = preset || (includeBody ? 'FULL' : 'MINIMAL');
    this.index = createDocument(includeBody, preset ? SEARCH_PRESETS[preset]?.fields : null);
    this.entries = [];
    this.sizeBytes = 0;
    this.folderIndexes = new Map();
  }

  async loadFromCache() {
    if (!dbClient) {
      warn('[SearchService] No db client available for loadFromCache');
      return 0;
    }

    // Use array form for compound primary key lookup
    const cached = await dbClient.searchIndex.get([this.account, SEARCH_INDEX_KEY]);

    if (cached?.data?.length) {
      // Normalize entries - ensure labelsText exists for proper FlexSearch indexing
      this.entries = cached.data.map((entry) => {
        if (entry.labelsText !== undefined) return entry;
        // Generate labelsText from labels array for backwards compatibility
        const labelsArray = Array.isArray(entry.labels) ? entry.labels : [];
        return { ...entry, labelsText: labelsArray.join(' ') };
      });
      this.sizeBytes = cached.sizeBytes || 0;
      this.index = createDocument(this.includeBody);
      this.entries.forEach((entry) => this.index.add(entry));
      return this.entries.length;
    }
    return 0;
  }

  async reset(entries = []) {
    this.index = createDocument(this.includeBody);
    this.entries = [];
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
    this.entries.push(safeEntry);
    this.sizeBytes +=
      (safeEntry.subject?.length || 0) +
      (safeEntry.from?.length || 0) +
      (safeEntry.to?.length || 0) +
      (safeEntry.cc?.length || 0) +
      (safeEntry.snippet?.length || 0) +
      (safeEntry.labelsText?.length || 0) +
      (safeEntry.body?.length || 0);
    try {
      this.index.add(safeEntry);
    } catch {
      // ignore add failures
    }
  }

  removeEntry(entryId) {
    if (!entryId) return;
    try {
      this.index.remove(entryId);
      this.entries = this.entries.filter((e) => e.id !== entryId);
    } catch {
      // ignore
    }
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
    if (!dbClient) {
      warn('[SearchService] No db client available for persist');
      return;
    }

    const sizeBytes =
      this.sizeBytes ||
      this.entries.reduce((sum, e) => {
        return (
          sum +
          (e.subject?.length || 0) +
          (e.from?.length || 0) +
          (e.snippet?.length || 0) +
          (Array.isArray(e.labels) ? e.labels.reduce((s, l) => s + (l?.length || 0), 0) : 0) +
          (e.body?.length || 0)
        );
      }, 0);
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
        count: this.entries.length,
        includeBody: this.includeBody,
        sizeBytes,
      },
      updatedAt: Date.now(),
    });
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
      count: this.entries.length,
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
