/**
 * Month-agenda event markup for Schedule-X 1.x.
 *
 * The library's shared time-stamp helper returns HTML for single-day timed
 * events (a `<span aria-hidden="true">⋅</span>` between date and time). The
 * week and month-grid views inject that as HTML, but the month-agenda view
 * renders it as text, so phones showed the raw tag after every date. The
 * agenda view does honour a per-event `_customContent.monthAgenda` string,
 * which it injects as HTML inside its own styled, clickable event element.
 * This builds that string with the title escaped and a plain-text time line
 * that matches the library's own wording for every duration shape.
 */

const escapeHtml = (value: string): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

type Parts = { y: number; m: number; d: number; h: number; min: number; timed: boolean };

// Schedule-X values are 'YYYY-MM-DD' (all-day) or 'YYYY-MM-DD HH:mm' (timed).
const parseScheduleX = (value: string): Parts | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || '').trim());
  if (!m) return null;
  return {
    y: Number(m[1]),
    m: Number(m[2]) - 1,
    d: Number(m[3]),
    h: m[4] != null ? Number(m[4]) : 0,
    min: m[5] != null ? Number(m[5]) : 0,
    timed: m[4] != null,
  };
};

const dateText = (p: Parts, locale: string): string =>
  new Date(p.y, p.m, p.d).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

const timeText = (p: Parts, locale: string): string =>
  new Date(p.y, p.m, p.d, p.h, p.min).toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: 'numeric',
  });

const sameDay = (a: Parts, b: Parts): boolean => a.y === b.y && a.m === b.m && a.d === b.d;

/** Plain text describing when an event happens, in the library's own wording. */
export function monthAgendaTimeText(start: string, end: string, locale = 'en-US'): string {
  const s = parseScheduleX(start);
  const e = parseScheduleX(end) || s;
  if (!s || !e) return '';
  const delimiter = '–';
  if (!s.timed && !e.timed) {
    return sameDay(s, e)
      ? dateText(s, locale)
      : `${dateText(s, locale)} ${delimiter} ${dateText(e, locale)}`;
  }
  if (sameDay(s, e)) {
    return `${dateText(s, locale)} ⋅ ${timeText(s, locale)} ${delimiter} ${timeText(e, locale)}`;
  }
  return `${dateText(s, locale)}, ${timeText(s, locale)} ${delimiter} ${dateText(e, locale)}, ${timeText(e, locale)}`;
}

// Same clock glyph the library draws, on currentColor so it follows the
// event's text colour.
const CLOCK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="sx__event-icon" aria-hidden="true">' +
  '<path d="M12 8V12L15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>' +
  '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"></circle></svg>';

export function buildMonthAgendaContent(
  event: { title?: unknown; start: string; end: string },
  locale = 'en-US',
): string {
  const title = escapeHtml(String(event.title ?? '') || 'Event');
  const when = escapeHtml(monthAgendaTimeText(event.start, event.end, locale));
  return (
    `<div class="sx__month-agenda-event__title">${title}</div>` +
    `<div class="sx__month-agenda-event__time sx__month-agenda-event__has-icon">${CLOCK_ICON}${when}</div>`
  );
}
