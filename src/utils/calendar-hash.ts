/**
 * Calendar deep-link hash helpers.
 *
 * Notifications open the calendar with `#event=<id>` or `#task=<id>` so the
 * matching item opens in the edit dialog. That target must be consumed once
 * it has been acted on: Calendar re-applies the hash after every event
 * reload, and the websocket echo of the user's own save triggers such a
 * reload, so a hash left in place reopened the dialog the user had just
 * closed by saving.
 */

export type CalendarHashTarget = { kind: 'event' | 'task'; id: string };

export function parseCalendarHashTarget(hash: string): CalendarHashTarget | null {
  const match = (hash || '').match(/^#(event|task)=([^&]+)/i);
  if (!match) return null;
  const kind = match[1].toLowerCase() as 'event' | 'task';
  try {
    return { kind, id: decodeURIComponent(match[2]) };
  } catch {
    return { kind, id: match[2] };
  }
}

/**
 * The hash to leave in the URL once an `#event=` / `#task=` target has been
 * opened. Keeps the user on the section they are looking at so the next
 * hash read does not flip them between the calendar and tasks views.
 */
export function consumedCalendarHash(section: 'calendar' | 'tasks'): string {
  return section === 'tasks' ? '#tasks' : '#calendar';
}
