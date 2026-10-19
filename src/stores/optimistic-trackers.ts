// Optimistic-update reconciliation trackers extracted from mailboxStore.ts so
// their logic can be unit-tested in isolation. They guard the store against a
// stale server/sync response clobbering a just-applied optimistic mutation:
//
//   - pending DELETES: ids we optimistically removed, so a slow list response
//     that still includes them doesn't re-add them ("deleted message reappears").
//   - pending FLAG mutations: read/star changes we applied locally, re-applied
//     on top of list responses until the server confirms them.
//   - pending INSERTS: a just-sent message we optimistically added to Sent,
//     re-injected into list responses until the backend indexer makes it
//     queryable ("send, open Sent, it's already there" instead of waiting for
//     the sync). The mirror image of a pending delete: a delete is dropped when
//     the server STOPS reporting the id; an insert is dropped when the server
//     STARTS reporting it.
//
// All auto-expire entries after PENDING_DELETE_TTL. The factories take an
// injectable `now`/`ttl` purely so tests can drive expiry deterministically;
// production callers use the defaults and get identical behavior to the
// inlined originals.
//
// Must comfortably exceed the offline mutation queue's worst-case total
// backoff window (MAX_RETRIES=5 against BASE_BACKOFF_MS/MAX_BACKOFF_MS in
// mutation-queue.js, a few minutes worst case) — otherwise a mutation that's
// still retrying can have its suppressed row flash back into view (a stale
// list load reintroducing it) before the queue has either succeeded or given
// up and triggered a proper revert via cancel().
export const PENDING_DELETE_TTL = 5 * 60_000;

interface TrackerOptions {
  now?: () => number;
  ttl?: number;
}

export interface PendingFlagMutation {
  ts: number;
  is_unread?: boolean;
  is_unread_index?: number;
  flags?: string[];
  is_starred?: boolean;
  is_answered?: boolean;
  labels?: string[];
}

/**
 * How long a settled move or delete keeps its row hidden after the server
 * accepted it. The backend's list queries lag its writes by 10-30 seconds
 * (the indexer), so a list fetched in that window still reports the row in
 * its old folder.
 */
export const PENDING_DELETE_SETTLE_GRACE = 90_000;

interface DeleteTrackerOptions extends TrackerOptions {
  settleGrace?: number;
}

interface PendingDelete {
  ts: number;
  /** Folder the message left. Unset for a permanent delete: hidden everywhere. */
  sourceFolder?: string;
  /** Folder a move took it to, and the row as it now is there. */
  targetFolder?: string;
  row?: Record<string, unknown>;
  /** When the server accepted the change; the grace window counts from here. */
  settledAt?: number;
}

const rowTime = (row: Record<string, unknown>) =>
  Number(row.dateMs ?? (typeof row.date === 'number' ? row.date : Date.parse(String(row.date))));

const sameFolder = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Ids optimistically moved out of a folder or deleted.
 *
 * An entry is not dropped when some list stops reporting the id. Absence from
 * one response proves nothing: a page 2 load, a stale response, a filtered
 * query or another folder's list all lack the id while the server still lists
 * it in the source folder, and dropping protection on those let the row come
 * back on the next refresh. Instead an entry lives until a grace window after
 * the server accepted the change (settle), or for the full TTL while the change
 * is still queued.
 */
export function createPendingDeleteTracker({
  now = () => Date.now(),
  ttl = PENDING_DELETE_TTL,
  settleGrace = PENDING_DELETE_SETTLE_GRACE,
}: DeleteTrackerOptions = {}) {
  const pending: Map<string, PendingDelete> = new Map();

  const prune = () => {
    const t = now();
    for (const [id, entry] of pending) {
      const expired =
        entry.settledAt !== undefined ? t - entry.settledAt > settleGrace : t - entry.ts > ttl;
      if (expired) pending.delete(id);
    }
  };

  // A row is hidden when it is the stale copy in the folder the message left.
  // The moved copy in the target folder (the same id, as moves keep it) shows.
  const hides = (entry: PendingDelete, row: Record<string, unknown>, listFolder?: string) => {
    if (!entry.sourceFolder) return true;
    const rowFolder = (row.folder as string) || listFolder;
    if (!rowFolder) return true;
    return sameFolder(rowFolder, entry.sourceFolder);
  };

  return {
    add(
      ids: string[],
      {
        sourceFolder,
        targetFolder,
        row,
      }: { sourceFolder?: string; targetFolder?: string; row?: Record<string, unknown> } = {},
    ) {
      const t = now();
      for (const id of ids) {
        if (!id) continue;
        pending.set(id, {
          ts: t,
          ...(sourceFolder ? { sourceFolder } : {}),
          ...(targetFolder && row ? { targetFolder, row } : {}),
        });
      }
    },
    /**
     * Adds rows moved into `folder` that the list does not report yet. The
     * server's list for the target folder lags the move like the source's does,
     * so without this a moved message showed in the target folder from the
     * cache and then vanished when the network list arrived. A row older than
     * everything in the list belongs on a later page and is left out.
     */
    withMovedIn<M extends Record<string, unknown>>(msgs: M[], folder?: string): M[] {
      if (!folder || !pending.size) return msgs;
      prune();
      const present = new Set(msgs.map((m) => m.id));
      const incoming: Record<string, unknown>[] = [];
      for (const [id, entry] of pending) {
        if (!entry.row || !sameFolder(entry.targetFolder, folder) || present.has(id)) continue;
        incoming.push(entry.row);
      }
      if (!incoming.length) return msgs;
      const times = msgs.map(rowTime).filter((n) => Number.isFinite(n));
      const descending = times.length < 2 || times[0] >= times[times.length - 1];
      const oldest = times.length ? Math.min(...times) : -Infinity;
      const next = [...msgs] as Record<string, unknown>[];
      for (const row of incoming) {
        const t = rowTime(row);
        if (msgs.length && Number.isFinite(t) && t < oldest) continue;
        const at = next.findIndex((m) => {
          const mt = rowTime(m);
          return descending ? mt < t : mt > t;
        });
        if (at === -1) next.push(row);
        else next.splice(at, 0, row);
      }
      return next as M[];
    },
    /** The server accepted the change for these ids; start their grace window. */
    settle(ids: string[]) {
      const t = now();
      for (const id of ids) {
        const entry = pending.get(id);
        if (entry) entry.settledAt = t;
      }
    },
    /**
     * Drops pending rows from a list. `listFolder` is the folder the list was
     * loaded for, used for rows that do not carry their own folder.
     */
    filter<M extends Record<string, unknown>>(msgs: M[], listFolder?: string): M[] {
      if (!pending.size) return msgs;
      prune();
      if (!pending.size) return msgs;
      const next = msgs.filter((m) => {
        const entry = pending.get(m.id as string);
        return !entry || !hides(entry, m, listFolder);
      });
      return next.length === msgs.length ? msgs : next;
    },
    has(id: string) {
      prune();
      return pending.has(id);
    },
    getIds(): string[] {
      prune();
      return [...pending.keys()];
    },
    // Stop suppressing a single id without waiting out its TTL — used when a
    // queued mutation for it has been confirmed permanently failed and the
    // caller is about to restore the pre-mutation state instead.
    cancel(id: string) {
      pending.delete(id);
    },
    clear() {
      pending.clear();
    },
  };
}

const sameLabels = (a: unknown, b: string[]) => {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const want = new Set(b.map((l) => String(l).toLowerCase()));
  return a.every((l) => want.has(String(l).toLowerCase()));
};

export function createPendingFlagTracker({
  now = () => Date.now(),
  ttl = PENDING_DELETE_TTL,
}: TrackerOptions = {}) {
  const pending: Map<string, PendingFlagMutation> = new Map(); // id -> mutation

  const prune = () => {
    const t = now();
    for (const [id, m] of pending) {
      if (t - m.ts > ttl) pending.delete(id);
    }
  };

  return {
    add(id: string, mutation: Omit<PendingFlagMutation, 'ts'>) {
      if (!id) return;
      // Merged, so a label change and a read change on the same message both
      // stay applied until each is confirmed.
      pending.set(id, { ...pending.get(id), ...mutation, ts: now() });
    },
    apply(msgs: Record<string, unknown>[]) {
      if (!pending.size) return msgs;
      prune();
      if (!pending.size) return msgs;
      return msgs.map((msg) => {
        const p = pending.get(msg.id as string);
        if (!p) return msg;
        const { ts: _ts, ...overrides } = p;
        return { ...msg, ...overrides };
      });
    },
    confirm(serverMsgs: Record<string, unknown>[]) {
      // Once the server reports every field this change set, it has been
      // processed and the override can stop.
      for (const msg of serverMsgs) {
        const id = msg.id as string;
        const p = pending.get(id);
        if (!p) continue;
        const checks: boolean[] = [];
        if (p.is_unread !== undefined) checks.push(msg.is_unread === p.is_unread);
        if (p.is_starred !== undefined) checks.push(msg.is_starred === p.is_starred);
        if (p.is_answered !== undefined) checks.push(msg.is_answered === p.is_answered);
        if (p.labels !== undefined) checks.push(sameLabels(msg.labels, p.labels));
        if (checks.length && checks.every(Boolean)) pending.delete(id);
      }
    },
    getIds(): string[] {
      prune();
      return [...pending.keys()];
    },
    // Stop suppressing a single id without waiting out its TTL — used when a
    // queued mutation for it has been confirmed permanently failed and the
    // caller is about to restore the pre-mutation flag values instead.
    cancel(id: string) {
      pending.delete(id);
    },
    // The live changes by id, for the sync worker to lay over server rows.
    snapshot(): Record<string, Omit<PendingFlagMutation, 'ts'>> {
      prune();
      const out: Record<string, Omit<PendingFlagMutation, 'ts'>> = {};
      for (const [id, { ts: _ts, ...mutation }] of pending) out[id] = mutation;
      return out;
    },
    clear() {
      pending.clear();
    },
  };
}

export function createPendingInsertTracker({
  now = () => Date.now(),
  ttl = PENDING_DELETE_TTL,
}: TrackerOptions = {}) {
  const pending: Map<string, { msg: Record<string, unknown>; ts: number }> = new Map(); // id -> envelope

  const prune = () => {
    const t = now();
    for (const [id, { ts }] of pending) {
      if (t - ts > ttl) pending.delete(id);
    }
  };

  return {
    add(msg: Record<string, unknown>) {
      const id = msg?.id as string;
      if (!id) return;
      pending.set(id, { msg, ts: now() });
    },
    // Re-add any still-pending inserts missing from the list, newest first, so a
    // reload that predates the server indexing the new message keeps it on
    // screen. (The caller scopes this to the relevant folder — the tracker only
    // ever holds Sent inserts.)
    apply(msgs: Record<string, unknown>[]) {
      if (!pending.size) return msgs;
      prune();
      if (!pending.size) return msgs;
      const present = new Set(msgs.map((m) => m.id));
      const missing = [...pending.values()]
        .map((e) => e.msg)
        .filter((m) => !present.has(m.id))
        .sort((a, b) => Number(b.dateMs ?? b.date ?? 0) - Number(a.dateMs ?? a.date ?? 0));
      return missing.length ? [...missing, ...msgs] : msgs;
    },
    getIds(): string[] {
      prune();
      return [...pending.keys()];
    },
    confirm(serverIds: Set<string>) {
      // Once the server's list reports the id, its authoritative copy renders on
      // the next load — stop re-injecting the optimistic one.
      for (const id of pending.keys()) {
        if (serverIds.has(id)) pending.delete(id);
      }
    },
    clear() {
      pending.clear();
    },
  };
}
