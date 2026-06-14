/**
 * ical-datetime.ts — pure iCalendar date/time builders that are intentionally
 * independent of the host (device) timezone.
 *
 * Why this exists: the calendar save path used to build JS `Date` objects from
 * the wall-clock components the user typed (`new Date(y, m, d, h, min)`), which
 * JavaScript interprets in the *device* zone, then re-expressed that instant in
 * the user-selected zone for the `DTSTART;TZID=` line. When the device zone and
 * the selected zone differed, the saved wall-clock drifted by
 * (selectedOffset − deviceOffset) — e.g. a phone on America/Phoenix (no DST)
 * saving an America/Denver event in summer landed exactly 1 hour ahead. And
 * "all-day" events were emitted as midnight→23:59 DATE-TIME values instead of
 * RFC 5545 `VALUE=DATE`, so they rendered as spanning two days.
 *
 * These helpers work on the literal components / the selected zone directly, so
 * the wall-clock the user types is preserved verbatim and all-day events use the
 * correct date-only form. Pure + side-effect free so they can be unit tested.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → 'YYYYMMDD' (iCal DATE value). Returns '' on bad input. */
export function toICalDate(dateStr: string): string {
  const m = DATE_RE.exec(String(dateStr || '').trim());
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

/**
 * Add `days` to a 'YYYY-MM-DD' date and return 'YYYY-MM-DD'. Uses UTC math so it
 * never depends on the host zone (negative days supported). '' on bad input.
 */
export function addDaysISO(dateStr: string, days: number): string {
  const m = DATE_RE.exec(String(dateStr || '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Build the all-day DTSTART/DTEND pair as iCal DATE values ('YYYYMMDD').
 * RFC 5545 §3.8.2.2: DTEND is exclusive, so a single-day event ends on the
 * *next* day. `endDate` (inclusive last day) defaults to `startDate`.
 * Returns null on bad input.
 */
export function buildAllDayRange(
  startDate: string,
  endDate?: string,
): { dtstart: string; dtend: string } | null {
  const dtstart = toICalDate(startDate);
  if (!dtstart) return null;
  const lastDay = endDate && String(endDate).trim() ? endDate : startDate;
  const exclusiveEndISO = addDaysISO(lastDay, 1);
  const dtend = toICalDate(exclusiveEndISO);
  return dtend ? { dtstart, dtend } : null;
}

/**
 * Build a timed wall-clock value 'YYYYMMDDTHHMMSS' directly from the typed
 * date ('YYYY-MM-DD') + 24-hour time ('H:MM' or 'HH:MM') components.
 *
 * Crucially this does NOT route through a JS `Date` instant, so the value is the
 * literal wall-clock the user entered, independent of the device zone. Tag the
 * result with `;TZID=<selected zone>`. Returns '' on bad input.
 */
export function buildLocalDateTime(dateStr: string, time24: string): string {
  const dm = DATE_RE.exec(String(dateStr || '').trim());
  const tm = TIME_RE.exec(String(time24 || '').trim());
  if (!dm || !tm) return '';
  const hh = pad2(Math.min(23, Math.max(0, Number(tm[1]))));
  const mm = pad2(Math.min(59, Math.max(0, Number(tm[2]))));
  return `${dm[1]}${dm[2]}${dm[3]}T${hh}${mm}00`;
}

/** UTC offset in minutes (positive east of UTC) of an IANA zone at an instant. */
export function zoneOffsetMinutes(tzid: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const m: Record<string, string> = {};
    for (const part of dtf.formatToParts(at)) m[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(m.year),
      Number(m.month) - 1,
      Number(m.day),
      Number(m.hour) === 24 ? 0 : Number(m.hour),
      Number(m.minute),
      Number(m.second),
    );
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Convert a wall-clock (date 'YYYY-MM-DD' + time 'H:MM'/'HH:MM') *in the given
 * IANA zone* to the corresponding UTC instant. Two-pass so it settles correctly
 * around DST transitions. Used to produce a UTC ISO for optimistic rendering /
 * caching that matches the persisted `DTSTART;TZID=` wall-clock. Falls back to
 * treating the components as UTC when no zone (or 'UTC') is supplied. Returns
 * null on bad input.
 */
export function zonedWallClockToUTC(dateStr: string, time24: string, tzid?: string): Date | null {
  const dm = DATE_RE.exec(String(dateStr || '').trim());
  const tm = TIME_RE.exec(String(time24 || '').trim());
  if (!dm || !tm) return null;
  const guess = Date.UTC(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]),
    Number(tm[1]),
    Number(tm[2]),
  );
  if (!tzid || tzid === 'UTC') return new Date(guess);
  let offset = zoneOffsetMinutes(tzid, new Date(guess));
  let utc = guess - offset * 60000;
  // Re-evaluate at the refined instant: the offset can differ across a DST jump.
  offset = zoneOffsetMinutes(tzid, new Date(utc));
  utc = guess - offset * 60000;
  return new Date(utc);
}

// DTSTART/DTEND carrying VALUE=DATE (all-day) — but NOT VALUE=DATE-TIME. Other
// params (TZID is illegal with VALUE=DATE, but be liberal) may appear in any
// order, hence the [^:\r\n]* spans around the VALUE=DATE token.
const DTSTART_DATE_RE = /(?:^|[\r\n])DTSTART[^:\r\n]*;VALUE=DATE(?![\w-])[^:\r\n]*:(\d{8})/i;
const DTEND_DATE_RE = /(?:^|[\r\n])DTEND[^:\r\n]*;VALUE=DATE(?![\w-])[^:\r\n]*:(\d{8})/i;

const yyyymmddToISO = (s: string): string => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/**
 * Detect an all-day event from raw iCalendar text by looking for
 * `DTSTART;VALUE=DATE` (date-only, not DATE-TIME). Returns the inclusive start
 * and end calendar dates as 'YYYY-MM-DD' so the renderer can draw a single-day
 * (or multi-day) all-day bar without any timezone day-shift. `endDate` is the
 * inclusive last day (iCal DTEND is exclusive, so we subtract a day); it clamps
 * to `startDate` when DTEND is missing or not after the start.
 */
export function parseAllDayFromIcal(ical: unknown): {
  allDay: boolean;
  startDate?: string;
  endDate?: string;
} {
  if (typeof ical !== 'string' || !ical) return { allDay: false };
  const ms = DTSTART_DATE_RE.exec(ical);
  if (!ms) return { allDay: false };
  const startDate = yyyymmddToISO(ms[1]);
  let endDate = startDate;
  const me = DTEND_DATE_RE.exec(ical);
  if (me) {
    const exclusive = yyyymmddToISO(me[1]);
    const inclusive = addDaysISO(exclusive, -1);
    endDate = inclusive && inclusive >= startDate ? inclusive : startDate;
  }
  return { allDay: true, startDate, endDate };
}

/** Local calendar date ('YYYY-MM-DD') of a Date, using its local components. */
export function localDateOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
