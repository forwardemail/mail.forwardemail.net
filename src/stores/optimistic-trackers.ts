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
}

export function createPendingDeleteTracker({
  now = () => Date.now(),
  ttl = PENDING_DELETE_TTL,
}: TrackerOptions = {}) {
  const pending: Map<string, number> = new Map(); // id -> timestamp

  const prune = () => {
    const t = now();
    for (const [id, ts] of pending) {
      if (t - ts > ttl) pending.delete(id);
    }
  };

  return {
    add(ids: string[]) {
      const t = now();
      for (const id of ids) {
        if (id) pending.set(id, t);
      }
    },
    filter(msgs: Record<string, unknown>[]) {
      if (!pending.size) return msgs;
      prune();
      if (!pending.size) return msgs;
      return msgs.filter((m) => !pending.has(m.id as string));
    },
    getIds(): string[] {
      prune();
      return [...pending.keys()];
    },
    confirm(serverIds: Set<string>) {
      // If a pending-delete ID is absent from the server response, the server
      // has processed it — safe to stop filtering.
      for (const id of pending.keys()) {
        if (!serverIds.has(id)) pending.delete(id);
      }
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
      pending.set(id, { ...mutation, ts: now() });
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
      // If the server response matches the optimistic state, the mutation
      // has been processed — safe to stop overriding.
      for (const msg of serverMsgs) {
        const id = msg.id as string;
        const p = pending.get(id);
        if (!p) continue;
        if (p.is_unread !== undefined && msg.is_unread === p.is_unread) {
          pending.delete(id);
        } else if (p.is_starred !== undefined && msg.is_starred === p.is_starred) {
          pending.delete(id);
        }
      }
    },
    // Stop suppressing a single id without waiting out its TTL — used when a
    // queued mutation for it has been confirmed permanently failed and the
    // caller is about to restore the pre-mutation flag values instead.
    cancel(id: string) {
      pending.delete(id);
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
