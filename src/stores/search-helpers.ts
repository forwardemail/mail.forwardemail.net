// Pure helpers extracted from searchStore.ts so they can be unit-tested without
// loading the store's I/O graph (SearchService, db, Remote, the search worker).
// These cover building the server-side search query params from parsed filters,
// and merging local (FlexSearch) hits with server hits. Side-effect-free.

import type { SearchResult } from '../types';

// The subset of parseSearchQuery()'s `filters` output that the server query
// builder consumes. parseSearchQuery lives in untyped JS, so spelling this out
// here gives real types instead of the `any` a ReturnType import would yield.
export interface SearchFilters {
  from?: string[];
  to?: string[];
  subject?: string[];
  isUnread?: boolean | null;
  isStarred?: boolean | null;
  hasAttachment?: boolean | null;
  after?: number | null;
  before?: number | null;
}

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
  lightweight?: boolean;
}

/**
 * Build API query parameters from parsed search filters.
 * Returns null if there is nothing meaningful to send to the server
 * (e.g. filter-only queries that the server cannot evaluate).
 */
export const buildServerSearchParams = (
  text: string,
  filters: SearchFilters,
  folder: string | null,
  limit: number,
): ServerSearchParams | null => {
  const params: ServerSearchParams = {
    limit,
    page: 1,
    raw: false,
    attachments: false,
    // Skip expensive MIME rebuild — search results only need metadata
    lightweight: true,
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
 * Merge local and server search results, deduplicating by message ID.
 * Server results take priority (they may have more complete data).
 */
export const mergeResults = (
  localHits: SearchResult[],
  serverHits: SearchResult[],
): SearchResult[] => {
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
