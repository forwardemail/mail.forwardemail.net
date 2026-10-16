/**
 * Optimistic calendar changes waiting on the server, and how they are laid
 * over a fetched event list. Used by Calendar.svelte.
 *
 * A pending entry is keyed by event id. A null patch means the item is
 * pending delete. A pending create carries `insert` and the iCal UID it was
 * sent with, so a fetch that already returns the new event (under its server
 * id) is recognised and the provisional copy is not shown next to it.
 */

export interface PendingEventMutation {
  token: number;
  patch: Record<string, unknown> | null;
  insert?: boolean;
  // iCal UID of a pending create, as written into the VEVENT/VTODO.
  icalUid?: string | null;
}

type CalendarItem = Record<string, unknown>;

/** The UID line of the first component in an iCal string. */
export function icalUid(ical: unknown): string | null {
  if (typeof ical !== 'string') return null;
  const match = ical.match(/^UID:(.+)$/m);
  const uid = match?.[1]?.trim();
  return uid || null;
}

// The iCal UID of a fetched event. The API returns it as `uid` next to the
// event id; older payloads only have it inside the iCal text.
function fetchedUid(item: CalendarItem): string | null {
  const raw = (item.raw as CalendarItem | undefined) || {};
  const direct = raw.uid ?? item.uid;
  if (typeof direct === 'string' && direct) return direct;
  return icalUid(raw.ical ?? item.ical);
}

export function applyPendingEventMutations(
  list: unknown[],
  pending: Map<string, PendingEventMutation>,
): unknown[] {
  if (!pending.size) return list;
  const seen = new Set<string>();
  const fetchedUids = new Set<string>();
  const result: unknown[] = [];
  for (const ev of list) {
    const item = ev as CalendarItem;
    const uid = fetchedUid(item);
    if (uid) fetchedUids.add(uid);
    const id = item.id as string;
    const entry = pending.get(id);
    if (!entry) {
      result.push(ev);
      continue;
    }
    seen.add(id);
    if (entry.patch === null) continue;
    result.push({ ...item, ...entry.patch });
  }
  // Pending creates are not on the server yet, so a fetched list would
  // silently drop them. Append any the fetch did not return, either by id or,
  // when the POST has landed but its response has not, by iCal UID.
  for (const [id, entry] of pending) {
    if (!entry.insert || !entry.patch || seen.has(id)) continue;
    if (entry.icalUid && fetchedUids.has(entry.icalUid)) continue;
    result.push(entry.patch);
  }
  return result;
}

/**
 * Give a provisional event its server id once the POST confirms it. If a
 * fetch already brought the server copy in, the provisional one is dropped
 * instead of renamed, which would leave two events with the same id.
 */
export function swapCreatedEvent(
  list: unknown[],
  tempId: string,
  realId: string,
  raw: Record<string, unknown> | null,
): unknown[] {
  const hasServerCopy = realId !== tempId && list.some((ev) => (ev as CalendarItem).id === realId);
  if (hasServerCopy) return list.filter((ev) => (ev as CalendarItem).id !== tempId);
  return list.map((ev) =>
    (ev as CalendarItem).id === tempId ? { ...(ev as CalendarItem), id: realId, raw } : ev,
  );
}
