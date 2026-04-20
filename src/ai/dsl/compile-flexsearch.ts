/**
 * SearchQuery DSL → search.worker payload
 *
 * Compiles the AI DSL (`src/ai/dsl/search-query.ts`) into the payload shape
 * the existing search.worker accepts (see `src/workers/search.worker.ts`
 * `search` action and `src/utils/search-query.js` filter shape).
 *
 * Phase 1 compiles a subset. Fields listed in `UNSUPPORTED_IN_PHASE_1` are
 * silently dropped and returned in the `unsupported` list so callers can warn
 * the user (e.g. "Ignored: semantic search, sort, offset"). Risk #4 in the
 * implementation plan spikes the remaining fields against Dexie compound
 * indexes before we add them.
 */

import type { SearchQuery } from './search-query';

export interface FlexSearchPayload {
  /** Account id — caller fills in from app state; DSL does not carry it. */
  account?: string;
  /** Effective folder: DSL filters.folder wins, else caller-provided. */
  folder?: string | null;
  /** Mirrors filters.folder === 'all' or missing. */
  crossFolder?: boolean;
  text: string;
  filters: {
    from: string[];
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string[];
    folder: string | null;
    labels: string[];
    isUnread: boolean | null;
    isStarred: boolean | null;
    hasAttachment: boolean | null;
    before: number | null;
    after: number | null;
    scope: string | null;
  };
  limit: number;
}

export interface CompileResult {
  payload: FlexSearchPayload;
  /** Names of DSL fields that were present but not honored in Phase 1. */
  unsupported: string[];
}

const UNSUPPORTED_IN_PHASE_1 = new Set([
  'semantic_query',
  'sort',
  'offset',
  'filters.labels_all',
  'filters.thread_id',
]);

const DEFAULT_LIMIT = 50;

const parseIsoToMs = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const toLower = (arr: string[] | undefined): string[] =>
  Array.isArray(arr) ? arr.map((v) => v.toLowerCase()) : [];

export const compileToFlexSearch = (
  query: SearchQuery,
  context: { account?: string; defaultFolder?: string | null } = {},
): CompileResult => {
  const unsupported: string[] = [];
  const f = query.filters ?? {};

  if (query.semantic_query) unsupported.push('semantic_query');
  if (query.sort) unsupported.push('sort');
  if (typeof query.offset === 'number' && query.offset > 0) unsupported.push('offset');
  if (f.labels_all && f.labels_all.length > 0) unsupported.push('filters.labels_all');
  if (f.thread_id) unsupported.push('filters.thread_id');

  const folder = f.folder ?? context.defaultFolder ?? null;
  const crossFolder = !folder || folder.toLowerCase() === 'all';

  const payload: FlexSearchPayload = {
    account: context.account,
    folder,
    crossFolder,
    text: query.text_query?.trim() ?? '',
    filters: {
      from: toLower(f.from),
      to: toLower(f.to),
      cc: toLower(f.cc),
      bcc: [],
      subject: toLower(f.subject_contains),
      folder: folder ? folder.toLowerCase() : null,
      labels: toLower(f.labels_any),
      isUnread: typeof f.is_unread === 'boolean' ? f.is_unread : null,
      isStarred: typeof f.is_flagged === 'boolean' ? f.is_flagged : null,
      hasAttachment: typeof f.has_attachment === 'boolean' ? f.has_attachment : null,
      before: parseIsoToMs(f.before),
      after: parseIsoToMs(f.after),
      scope: crossFolder ? 'all' : null,
    },
    limit: typeof query.limit === 'number' && query.limit > 0 ? query.limit : DEFAULT_LIMIT,
  };

  return { payload, unsupported };
};

/** Exposed for tests and the settings UI's "what does AI search support" surface. */
export const phase1UnsupportedFields = (): string[] => [...UNSUPPORTED_IN_PHASE_1];
