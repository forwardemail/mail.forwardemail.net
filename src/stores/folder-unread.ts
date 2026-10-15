// Folder unread badges and keeping cached read state in step with the server.
//
// The server's unseen_count is the real number. The local cache only holds the
// messages this device has synced, and their read state goes stale when mail is
// read elsewhere while this device is closed, so counting cached rows gave a
// different badge on every device (14,127 on one, 37 on another for the same
// inbox).
//
// The badge is the server count plus how far the cached count has moved since
// that server count arrived. Reading or unreading a message here moves the
// cached count, so the badge follows at once without waiting for the server.
// Sync filling in older history also moves the cached count without the server
// count changing; sync tells us when it wrote (rebase), and that movement is
// not added to the badge.

interface Anchor {
  // Server count and the buildFolderList call it came from.
  server: number;
  at: number;
  // Cached unread count when the server count arrived, adjusted by rebases.
  local: number;
  // Cached unread count at the last recount.
  last: number;
}

const key = (account: string, path: string) => `${account}\u0000${path}`;

export function createUnreadAnchors() {
  const anchors = new Map<string, Anchor>();

  return {
    // The badge for a folder whose server count is known. A server count from
    // a newer folder list starts over from the cached count as it is now.
    display(
      account: string,
      path: string,
      {
        server,
        at,
        local,
        total,
      }: { server: number; at: number; local: number; total?: number | null },
    ): number {
      const k = key(account, path);
      let anchor = anchors.get(k);
      if (!anchor || anchor.at !== at) {
        anchor = { server, at, local, last: local };
        anchors.set(k, anchor);
      }
      anchor.last = local;
      const count = Math.max(0, server + local - anchor.local);
      return Number.isFinite(total) ? Math.min(count, total as number) : count;
    },

    // Sync wrote messages the server already counted (older history, or flags
    // changed elsewhere that the next server count will include). Keep the
    // badge where it is.
    rebase(account: string, path: string, local: number) {
      const anchor = anchors.get(key(account, path));
      if (!anchor) return;
      anchor.local += local - anchor.last;
      anchor.last = local;
    },

    has(account: string, path: string) {
      return anchors.has(key(account, path));
    },

    clear() {
      anchors.clear();
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
