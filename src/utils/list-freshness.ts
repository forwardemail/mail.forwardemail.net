/**
 * Whether a cached message list page can be shown without asking the server.
 *
 * A page fetched from the server stays current for as long as the account's
 * WebSocket keeps delivering every change to that folder: the realtime
 * handlers patch the cache and refresh the folder on screen. So a page is
 * fresh only while all of this holds:
 *
 * - it was fetched while the account's socket was live, and the socket has
 *   not dropped since (a dropped socket loses the events sent while it was
 *   down, and the server does not replay them);
 * - no event was dropped on our side for size or rate;
 * - no event has named its folder since (the event's own refresh fetches it
 *   again if it is on screen; otherwise opening it does);
 * - it is younger than FRESH_MAX_AGE_MS, in case an event was lost some way
 *   we cannot see;
 * - the socket has heard from the server within LIVE_SILENCE_MS. The server
 *   pings every 30 s. After a sleep the socket can still look open until its
 *   own ping timeout fires, and nothing it says can be trusted then.
 *
 * Anything else, and the caller goes to the network as it always did. This
 * matters most for shared inboxes: another person's read, reply or move must
 * show up here, and the WebSocket is how it does.
 */

export const FRESH_MAX_AGE_MS = 5 * 60_000;
export const LIVE_SILENCE_MS = 45_000;

export interface ConnectionState {
  authenticated: boolean;
  lastHeardAt: number;
}

type Probe = (account: string) => ConnectionState | null | undefined;

interface Entry {
  at: number;
  epoch: string;
  rows: number;
  // Lowercased folder path and server ids: events name a folder by either.
  names: string[];
  hasId: boolean;
}

export interface SyncToken {
  account: string;
  at: number;
  epoch: string;
  seq: number;
}

interface Changes {
  // Sequence number of the last change to each folder name
  byName: Map<string, number>;
  // Last change that named no folder, so touched all of them
  wide: number;
  // Last change of any kind
  any: number;
}

const norm = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value == null ? '' : String(value);

export function createListFreshness({ now = () => Date.now() } = {}) {
  let probe: Probe = () => null;
  // Bumped whenever an account may have missed events.
  const epochs = new Map<string, number>();
  // Bumped by reset(), for accounts that never missed anything too.
  let generation = 0;
  const entries = new Map<string, Map<string, Entry>>();
  // Changes are numbered so a response can tell whether one arrived while it
  // was on its way: its page may then predate the change.
  let seq = 0;
  const changes = new Map<string, Changes>();
  const changesOf = (account: string) => {
    let c = changes.get(account);
    if (!c) {
      c = { byName: new Map(), wide: 0, any: 0 };
      changes.set(account, c);
    }
    return c;
  };

  const epochOf = (account: string) => `${generation}:${epochs.get(norm(account)) || 0}`;

  function isLive(account: string, at = now()) {
    const state = probe(account);
    return Boolean(state?.authenticated) && at - Number(state?.lastHeardAt || 0) <= LIVE_SILENCE_MS;
  }

  function forgetAccount(account: string) {
    entries.delete(norm(account));
  }

  return {
    setProbe(next: Probe | null) {
      probe = next || (() => null);
    },

    isLive,

    /** The account may have missed events: a disconnect or a dropped event. */
    noteMissed(account: string) {
      const key = norm(account);
      epochs.set(key, (epochs.get(key) || 0) + 1);
      forgetAccount(key);
    },

    /** Called when a list request starts. Null when nothing can be trusted. */
    begin(account: string): SyncToken | null {
      const at = now();
      if (!isLive(account, at)) return null;
      return { account: norm(account), at, epoch: epochOf(account), seq };
    },

    /** The server answered the request `token` came from. */
    mark(
      token: SyncToken | null,
      view: { folder: string; key: string; rows: number; ids?: unknown[] },
    ) {
      if (!token || epochOf(token.account) !== token.epoch) return;
      const ids = (view.ids || []).map(norm).filter(Boolean);
      const names = [norm(view.folder), ...ids];
      const c = changes.get(token.account);
      if (c) {
        // Changed while the request was out: the next open asks again.
        if (c.wide > token.seq) return;
        if (names.some((n) => (c.byName.get(n) || 0) > token.seq)) return;
        // Without its id, a change naming the folder by id cannot be told apart.
        if (!ids.length && c.any > token.seq) return;
      }
      let account = entries.get(token.account);
      if (!account) {
        account = new Map();
        entries.set(token.account, account);
      }
      account.set(`${norm(view.folder)}|${view.key}`, {
        at: token.at,
        epoch: token.epoch,
        rows: view.rows,
        names,
        hasId: ids.length > 0,
      });
    },

    /**
     * Whether nothing can have been missed since `token` was taken, within
     * `maxAgeMs`. For data the socket also keeps current, like calendars.
     */
    holds(token: SyncToken | null, maxAgeMs: number) {
      if (!token) return false;
      const at = now();
      if (epochOf(token.account) !== token.epoch || at - token.at >= maxAgeMs) return false;
      return isLive(token.account, at);
    },

    /** Whether the cached page can be shown without a request. */
    isFresh(account: string, folder: string, key: string, cachedRows: number) {
      const at = now();
      const entry = entries.get(norm(account))?.get(`${norm(folder)}|${key}`);
      if (!entry) return false;
      if (entry.epoch !== epochOf(account)) return false;
      if (at - entry.at >= FRESH_MAX_AGE_MS) return false;
      // The rows the server sent should all be in the cache. Fewer means a
      // cache write did not land.
      if (cachedRows < entry.rows) return false;
      return isLive(account, at);
    },

    /**
     * A realtime event named these folders (paths or server ids). An empty
     * list means it did not say which, so the whole account is stale.
     */
    noteChanged(account: string, folders: unknown[]) {
      const key = norm(account);
      const names = folders.map(norm).filter(Boolean);
      seq += 1;
      const c = changesOf(key);
      c.any = seq;
      if (!names.length) {
        c.wide = seq;
        forgetAccount(key);
        return;
      }
      for (const n of names) c.byName.set(n, seq);
      const pages = entries.get(key);
      if (!pages) return;
      const known = new Set<string>();
      for (const entry of pages.values()) entry.names.forEach((n) => known.add(n));
      // A name no page knows may still be the id of a page saved without one.
      const unmatched = names.some((n) => !known.has(n));
      for (const [pageKey, entry] of pages) {
        if (entry.names.some((n) => names.includes(n)) || (unmatched && !entry.hasId)) {
          pages.delete(pageKey);
        }
      }
    },

    /** Drop everything, for sign-out and when realtime stops. */
    reset() {
      entries.clear();
      generation += 1;
    },
  };
}

export type ListFreshness = ReturnType<typeof createListFreshness>;

export const listFreshness = createListFreshness();
