/**
 * Search DSL
 *
 * The model never writes FlexSearch or SQLite directly. It emits this
 * structured DSL, which compiles to both backends. Every field is optional.
 * Unknown fields are rejected by `validateSearchQuery`.
 *
 * Phase 1 intentionally omits `size_min_bytes` / `size_max_bytes` — no Dexie
 * compound index backs those filters today. Add with a follow-up schema bump.
 */

export type SearchSort = 'date_desc' | 'date_asc' | 'relevance';

export interface SearchFilters {
  from?: string[];
  to?: string[];
  cc?: string[];
  subject_contains?: string[];
  /** Match any of the given labels. */
  labels_any?: string[];
  /** Match all of the given labels. */
  labels_all?: string[];
  folder?: string;
  has_attachment?: boolean;
  is_unread?: boolean;
  is_flagged?: boolean;
  /** ISO 8601 date. */
  after?: string;
  /** ISO 8601 date. */
  before?: string;
  thread_id?: string;
}

export interface SearchQuery {
  filters?: SearchFilters;
  /** Free text across subject + body. */
  text_query?: string;
  /** Semantic query. Ignored in Phase 1 (no embeddings shipped yet). */
  semantic_query?: string;
  sort?: SearchSort;
  limit?: number;
  offset?: number;
  /** Human-readable summary surfaced to the user (e.g. "from Alice since Jan"). */
  _intent?: string;
  /** Model-reported confidence 0..1. Used by the hybrid router in Phase 3. */
  _confidence?: number;
}

const FILTER_KEYS = new Set<keyof SearchFilters>([
  'from',
  'to',
  'cc',
  'subject_contains',
  'labels_any',
  'labels_all',
  'folder',
  'has_attachment',
  'is_unread',
  'is_flagged',
  'after',
  'before',
  'thread_id',
]);

const TOP_KEYS = new Set<keyof SearchQuery>([
  'filters',
  'text_query',
  'semantic_query',
  'sort',
  'limit',
  'offset',
  '_intent',
  '_confidence',
]);

const SORTS = new Set<SearchSort>(['date_desc', 'date_asc', 'relevance']);

export class SearchQueryValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'SearchQueryValidationError';
    this.path = path;
  }
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'string');

const isIsoDate = (v: string): boolean => {
  const t = Date.parse(v);
  return Number.isFinite(t);
};

const validateFilters = (filters: unknown): SearchFilters => {
  if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new SearchQueryValidationError('filters', 'must be an object');
  }
  const out: SearchFilters = {};
  for (const [k, v] of Object.entries(filters)) {
    if (!FILTER_KEYS.has(k as keyof SearchFilters)) {
      throw new SearchQueryValidationError(`filters.${k}`, 'unknown field');
    }
    const key = k as keyof SearchFilters;
    switch (key) {
      case 'from':
      case 'to':
      case 'cc':
      case 'subject_contains':
      case 'labels_any':
      case 'labels_all':
        if (!isStringArray(v)) {
          throw new SearchQueryValidationError(`filters.${k}`, 'must be string[]');
        }
        out[key] = v;
        break;
      case 'folder':
      case 'thread_id':
        if (typeof v !== 'string') {
          throw new SearchQueryValidationError(`filters.${k}`, 'must be string');
        }
        out[key] = v;
        break;
      case 'has_attachment':
      case 'is_unread':
      case 'is_flagged':
        if (typeof v !== 'boolean') {
          throw new SearchQueryValidationError(`filters.${k}`, 'must be boolean');
        }
        out[key] = v;
        break;
      case 'after':
      case 'before':
        if (typeof v !== 'string' || !isIsoDate(v)) {
          throw new SearchQueryValidationError(`filters.${k}`, 'must be ISO 8601 date string');
        }
        out[key] = v;
        break;
      default: {
        const _exhaustive: never = key;
        void _exhaustive;
      }
    }
  }
  return out;
};

/**
 * Strict validator. Rejects unknown fields, wrong types, and malformed dates.
 * Returns a freshly-constructed `SearchQuery` (no fields copied from input
 * that weren't validated) so downstream code can trust the shape.
 */
export const validateSearchQuery = (input: unknown): SearchQuery => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new SearchQueryValidationError('$', 'must be an object');
  }
  const out: SearchQuery = {};
  for (const [k, v] of Object.entries(input)) {
    if (!TOP_KEYS.has(k as keyof SearchQuery)) {
      throw new SearchQueryValidationError(k, 'unknown field');
    }
    const key = k as keyof SearchQuery;
    switch (key) {
      case 'filters':
        out.filters = validateFilters(v);
        break;
      case 'text_query':
      case 'semantic_query':
      case '_intent':
        if (typeof v !== 'string') {
          throw new SearchQueryValidationError(k, 'must be string');
        }
        out[key] = v;
        break;
      case 'sort':
        if (typeof v !== 'string' || !SORTS.has(v as SearchSort)) {
          throw new SearchQueryValidationError(k, `must be one of ${[...SORTS].join(', ')}`);
        }
        out.sort = v as SearchSort;
        break;
      case 'limit':
      case 'offset':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
          throw new SearchQueryValidationError(k, 'must be non-negative integer');
        }
        out[key] = v;
        break;
      case '_confidence':
        if (typeof v !== 'number' || v < 0 || v > 1) {
          throw new SearchQueryValidationError(k, 'must be number in [0, 1]');
        }
        out._confidence = v;
        break;
      default: {
        const _exhaustive: never = key;
        void _exhaustive;
      }
    }
  }
  return out;
};

/**
 * Parse JSON from a model response and validate. Throws
 * `SearchQueryValidationError` on bad shape, `SyntaxError` on bad JSON.
 */
export const parseSearchQueryJSON = (raw: string): SearchQuery => {
  const parsed = JSON.parse(raw);
  return validateSearchQuery(parsed);
};

/**
 * Convert a validated `SearchQuery` into the existing webmail operator
 * syntax (`from:alice after:2026-01-01 is:unread "subject phrase"`). This
 * is what the mailbox search bar already parses, so the smart-search flow
 * becomes: NL → DSL → operator-string → existing search pipeline. Users
 * see the translation in the search box — it's a teaching moment for the
 * operator syntax and a trust signal that the AI did what they asked.
 */
export const dslToQueryString = (query: SearchQuery): string => {
  const parts: string[] = [];
  const f = query.filters ?? {};

  for (const addr of f.from ?? []) parts.push(`from:${quoteIfNeeded(addr)}`);
  for (const addr of f.to ?? []) parts.push(`to:${quoteIfNeeded(addr)}`);
  for (const addr of f.cc ?? []) parts.push(`cc:${quoteIfNeeded(addr)}`);
  for (const s of f.subject_contains ?? []) parts.push(`subject:${quoteIfNeeded(s)}`);
  for (const l of f.labels_any ?? []) parts.push(`label:${quoteIfNeeded(l)}`);
  if (f.folder) parts.push(`in:${quoteIfNeeded(f.folder)}`);
  if (f.is_unread === true) parts.push('is:unread');
  if (f.is_unread === false) parts.push('is:read');
  if (f.is_flagged === true) parts.push('is:starred');
  if (f.has_attachment === true) parts.push('has:attachment');
  if (f.after) parts.push(`after:${toYmd(f.after)}`);
  if (f.before) parts.push(`before:${toYmd(f.before)}`);
  if (query.text_query) parts.push(quoteIfNeeded(query.text_query));

  return parts.join(' ').trim();
};

const quoteIfNeeded = (v: string): string => {
  const trimmed = v.trim();
  if (!trimmed) return '';
  return /[\s"']/.test(trimmed) ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed;
};

const toYmd = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
