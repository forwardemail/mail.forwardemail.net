// Folder unread badges and keeping cached read state in step with the server.
//
// The server's unseen_count is the real number. The local cache only holds the
// messages this device has synced, and their read state goes stale when mail is
// read elsewhere while this device is closed, so counting cached rows gave a
// different badge on every device (14,127 on one, 37 on another for the same
// inbox).
//
// The badge is the server count plus the changes made on this device that the
// server count does not include yet: a message read, unread, moved or deleted
// here. Each change is noted when it is made and settles once the server has
// it (the request returned, or the server reported the new state). A folder
// list fetched after that already counts it, so it stops being added. Sync
// filling in cached history never moves the badge.

export const UNREAD_DELTA_TTL_MS = 30 * 60_000;

interface Change {
  account: string;
  // Where the message was and whether it was unread before the first change
  // noted for it, and where it is and whether it is unread now. A null path
  // means the message is gone.
  basePath: string | null;
  baseUnread: boolean;
  path: string | null;
  unread: boolean;
  changedAt: number;
  // When the server had the latest change, or null while it is on its way.
  settledAt: number | null;
}

const changeKey = (account: string, id: string) => `${account}\u0000${id}`;

export function createUnreadDeltas({
  now = () => Date.now(),
  ttl = UNREAD_DELTA_TTL_MS,
  samePath = (a: string, b: string) => a === b,
  onChange = () => {},
}: {
  now?: () => number;
  ttl?: number;
  samePath?: (a: string, b: string) => boolean;
  // Told when a change is noted or dropped ('noted': the badge should be
  // recounted now) and when one settles ('settled': a folder list requested
  // from now on includes it, so it is worth fetching one).
  onChange?: (event: 'noted' | 'settled', account: string) => void;
} = {}) {
  const changes = new Map<string, Change>();

  const prune = () => {
    const t = now();
    for (const [k, c] of changes) if (t - c.changedAt > ttl) changes.delete(k);
  };

  const record = (
    account: string,
    id: string,
    from: { path: string | null; unread: boolean },
    to: { path: string | null; unread: boolean },
  ) => {
    if (!account || id == null || id === '') return;
    const k = changeKey(account, String(id));
    const existing = changes.get(k);
    changes.set(k, {
      account,
      basePath: existing ? existing.basePath : from.path,
      baseUnread: existing ? existing.baseUnread : from.unread,
      path: to.path,
      unread: to.unread,
      changedAt: now(),
      settledAt: null,
    });
    onChange('noted', account);
  };

  const contribution = (c: Change, path: string) => {
    const after = c.path != null && c.unread && samePath(c.path, path) ? 1 : 0;
    const before = c.basePath != null && c.baseUnread && samePath(c.basePath, path) ? 1 : 0;
    return after - before;
  };

  return {
    // A message in `path` was marked read (unread=false) or unread here.
    read(account: string, id: string, path: string, unread: boolean) {
      const existing = changes.get(changeKey(account, String(id)));
      const at = existing ? existing.path : path;
      record(account, id, { path, unread: !unread }, { path: at, unread });
    },

    // A message was moved here (to=null for a delete).
    move(account: string, id: string, from: string, to: string | null, unread: boolean) {
      const existing = changes.get(changeKey(account, String(id)));
      const isUnread = existing ? existing.unread : unread;
      record(account, id, { path: from, unread: isUnread }, { path: to, unread: isUnread });
    },

    // The server has the latest change for this message.
    settle(account: string, id: string) {
      const c = changes.get(changeKey(account, String(id)));
      if (c && c.settledAt == null) {
        c.settledAt = now();
        onChange('settled', account);
      }
    },

    // The change failed and was rolled back on this device.
    drop(account: string, id: string) {
      if (changes.delete(changeKey(account, String(id)))) onChange('noted', account);
    },

    // Ids whose latest change has not reached the server yet.
    unsettledIds(account: string) {
      prune();
      const ids: string[] = [];
      for (const [k, c] of changes) {
        if (c.account === account && c.settledAt == null) ids.push(k.slice(account.length + 1));
      }
      return ids;
    },

    // The badge for `path`, given a server count from a folder list whose
    // request started at `fetchedAt` (0 when the time is unknown, e.g. a list
    // read back from the cache, so every change still counts).
    adjust(
      account: string,
      path: string,
      { server, fetchedAt, total }: { server: number; fetchedAt: number; total?: number | null },
    ) {
      prune();
      let count = server;
      for (const c of changes.values()) {
        if (c.account !== account) continue;
        if (c.settledAt != null && fetchedAt > c.settledAt) continue;
        count += contribution(c, path);
      }
      count = Math.max(0, count);
      return Number.isFinite(total) ? Math.min(count, total as number) : count;
    },

    // A folder list fetched from the server at `fetchedAt` counts every change
    // settled before then; forget those.
    covered(account: string, fetchedAt: number) {
      for (const [k, c] of changes) {
        if (c.account === account && c.settledAt != null && fetchedAt > c.settledAt) {
          changes.delete(k);
        }
      }
      prune();
    },

    clear() {
      changes.clear();
    },
  };
}

// Folders whose cached read state is worth checking against the server, and
// how. Listing the server's unread messages is only conclusive when they all
// fit in a few pages; above that a message missing from the list could just be
// on a later page.
export const RECONCILE_MAX_UNREAD = 500;
export const RECONCILE_PAGE_SIZE = 100;

export function needsUnreadReconcile({
  server,
  local,
  selected,
}: {
  server: number;
  local: number;
  selected: boolean;
}) {
  if (!Number.isFinite(server) || server < 0 || server > RECONCILE_MAX_UNREAD) return false;
  // More unread here than the server has is always stale. Fewer can just mean
  // the unread ones are not cached yet, so only the open folder is checked.
  return local > server || (selected && local !== server);
}

// Whether a listing of the server's unread messages can be trusted as the
// whole set. Offset pages shift when a message is read or arrives while they
// are fetched, so a message can be skipped; a listing that does not add up to
// the folder's count is retried later instead of acted on.
export function isCompleteUnreadListing(listed: number, serverCount: number) {
  return Number.isFinite(serverCount) && listed === serverCount;
}

// Which cached messages to mark read and which to mark unread, given every
// unread message on the server. Messages with a change of ours still on its
// way to the server are left alone.
export function planUnreadReconcile({
  localUnreadIds,
  serverUnreadIds,
  skip,
}: {
  localUnreadIds: Iterable<string>;
  serverUnreadIds: Set<string>;
  skip: Set<string>;
}) {
  const localUnread = new Set(localUnreadIds);
  const markRead: string[] = [];
  for (const id of localUnread) {
    if (!serverUnreadIds.has(id) && !skip.has(id)) markRead.push(id);
  }
  const markUnread: string[] = [];
  for (const id of serverUnreadIds) {
    if (!localUnread.has(id) && !skip.has(id)) markUnread.push(id);
  }
  return { markRead, markUnread };
}
