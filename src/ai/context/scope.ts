/**
 * Context Scope — the boundary that defines what messages, files, or other
 * sources an AI request can reference.
 *
 * Motivation: in a shared support inbox, "the current mailbox" is not a safe
 * default. A request drafting a reply to Customer A must not pull Customer B's
 * history into the prompt or into tool results. Every AI request declares a
 * scope up front; tools enforce it at the boundary; the UI surfaces it so the
 * user sees what's in play before sending.
 *
 * Three scopes in Phase 1:
 *   - `thread`       — messages sharing the current thread_id / root_id. Safest
 *                      default. Used by Summarize and Draft reply.
 *   - `participants` — messages with the same from/to participant set as the
 *                      current thread. Broader, still bounded. Requires an
 *                      explicit UI toggle.
 *   - `mailbox`      — full mailbox. Only with an explicit, session-only opt-in
 *                      and a confirmation modal. Never sticky across sessions.
 */

import type { SearchFilters } from '../dsl/search-query';

export type ScopeKind = 'thread' | 'participants' | 'mailbox';

/**
 * A repository the user has attached to the current AI session. Repos are
 * orthogonal to the email scope — any email scope can be paired with any
 * number of repos. The AI gets `list_repo_files` / `read_repo_file` /
 * `grep_repo` tools for each attached repo; repos not attached this session
 * are invisible to the model.
 */
export interface RepoRef {
  /** Stable id used as the `meta` key suffix and the tool's `repo_id` arg. */
  id: string;
  /** Display label shown in the panel chip. */
  label: string;
}

export interface ThreadScope {
  kind: 'thread';
  account: string;
  /** `thread_id` or `root_id` of the current thread. At least one must be present. */
  threadId: string | null;
  rootId?: string | null;
  /** Repositories attached this session. Empty / absent = no repo tools. */
  repos?: RepoRef[];
}

export interface ParticipantScope {
  kind: 'participants';
  account: string;
  /** Normalized, lowercased email addresses (from, to, cc) across the seed thread. */
  participants: string[];
  repos?: RepoRef[];
}

export interface MailboxScope {
  kind: 'mailbox';
  account: string;
  /** True when the user has explicitly opted in this session. */
  confirmed: boolean;
  repos?: RepoRef[];
}

export type ContextScope = ThreadScope | ParticipantScope | MailboxScope;

/** Returns true when the scope has at least one attached repository. */
export const hasRepos = (scope: ContextScope): boolean =>
  Array.isArray(scope.repos) && scope.repos.length > 0;

/** Return the attached repo with matching id, or null. Used by repo tools. */
export const findRepo = (scope: ContextScope, repoId: string): RepoRef | null => {
  if (!scope.repos) return null;
  return scope.repos.find((r) => r.id === repoId) ?? null;
};

export interface ScopeViolation {
  code: 'out_of_scope' | 'scope_not_confirmed';
  message: string;
}

/**
 * Build a SearchFilters fragment that restricts results to the scope. Callers
 * combine this with any filters the model provided (AND semantics). Tools must
 * never accept filters that weaken this restriction — use `mergeScopedFilters`
 * for that.
 */
export const scopeToSearchFilters = (scope: ContextScope): SearchFilters => {
  switch (scope.kind) {
    case 'thread':
      return scope.threadId ? { thread_id: scope.threadId } : {};
    case 'participants':
      return scope.participants.length > 0
        ? {
            // OR across from/to/cc is handled in post-filter — the index-backed
            // candidate fetch uses `from` for speed, then post-filter widens.
            from: scope.participants,
          }
        : {};
    case 'mailbox':
      return {};
  }
};

/**
 * Merge a model-supplied SearchFilters with the scope's restriction. The
 * merged filters are AT LEAST as restrictive as the scope. Conflicts (e.g.
 * model asked for `from: ['carol@evil.com']` but scope only allows
 * `['bob@acme.com']`) resolve to the scope's restriction — the model cannot
 * widen what the user authorized.
 */
export const mergeScopedFilters = (
  scope: ContextScope,
  modelFilters: SearchFilters = {},
): SearchFilters => {
  const scoped = scopeToSearchFilters(scope);
  const merged: SearchFilters = { ...modelFilters };

  if (scope.kind === 'thread' && scoped.thread_id) {
    // Thread scope is absolute — overrides any thread_id the model supplied.
    merged.thread_id = scoped.thread_id;
  }

  if (scope.kind === 'participants' && scoped.from) {
    // Intersect the model's `from` with the scope's participant list. Empty
    // intersection yields an empty filter, which returns no results — correct.
    const modelFrom = modelFilters.from ?? [];
    const allowed = scoped.from.map((s) => s.toLowerCase());
    const intersected = modelFrom.length
      ? modelFrom.filter((f) => allowed.includes(f.toLowerCase()))
      : allowed;
    merged.from = intersected;
  }

  return merged;
};

/**
 * After a tool returns results, filter out anything outside the scope. This is
 * belt-and-suspenders to `mergeScopedFilters`: even if a tool somehow returns
 * out-of-scope results (buggy compiler, cache pollution), they don't reach the
 * model.
 */
export const enforceScope = <T extends ScopeCheckable>(scope: ContextScope, items: T[]): T[] => {
  switch (scope.kind) {
    case 'thread':
      if (!scope.threadId) return items;
      return items.filter(
        (item) =>
          item.thread_id === scope.threadId ||
          item.root_id === scope.threadId ||
          (scope.rootId ? item.thread_id === scope.rootId : false),
      );
    case 'participants': {
      const allowed = new Set(scope.participants.map((p) => p.toLowerCase()));
      return items.filter((item) => {
        const addresses = [
          item.from,
          ...(Array.isArray(item.to) ? item.to : [item.to]),
          ...(Array.isArray(item.cc) ? item.cc : [item.cc]),
        ]
          .filter((v): v is string => Boolean(v))
          .map((s) => s.toLowerCase());
        return addresses.some((addr) => allowed.has(addr));
      });
    }
    case 'mailbox':
      return items;
  }
};

export interface ScopeCheckable {
  thread_id?: string | null;
  root_id?: string | null;
  from?: string | null;
  to?: string | string[] | null;
  cc?: string | string[] | null;
}

/** Short human-readable label for the scope chip in the UI. */
export const scopeLabel = (scope: ContextScope): string => {
  switch (scope.kind) {
    case 'thread':
      return 'Thread only';
    case 'participants':
      return `Participants (${scope.participants.length})`;
    case 'mailbox':
      return scope.confirmed ? 'Full mailbox' : 'Full mailbox (not confirmed)';
  }
};

/** True when the scope is ready to use. `mailbox` scope requires confirmation. */
export const isScopeReady = (scope: ContextScope): boolean =>
  scope.kind !== 'mailbox' || scope.confirmed;

/**
 * Extract unique, lowercased participant addresses from a list of messages.
 * Used to build the `participants` scope from the seed thread's messages.
 */
export const extractParticipants = (
  messages: Array<{
    from?: string | null;
    to?: string | string[] | null;
    cc?: string | string[] | null;
  }>,
): string[] => {
  const set = new Set<string>();
  const push = (v: string | string[] | null | undefined) => {
    if (!v) return;
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      for (const piece of item.split(/[,;]/)) {
        const trimmed = piece.trim().toLowerCase();
        if (trimmed) set.add(trimmed);
      }
    }
  };
  for (const m of messages) {
    push(m.from);
    push(m.to);
    push(m.cc);
  }
  return [...set];
};
