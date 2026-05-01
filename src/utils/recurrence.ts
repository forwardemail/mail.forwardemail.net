/**
 * Forward Email — Recurrence
 *
 * Expands recurring VEVENTs (and VTODOs) on the client so the calendar
 * grid shows every occurrence, not just the master. The backend stores
 * the master + overrides as a single ICS blob with multiple VEVENT
 * subcomponents (one master with RRULE, N overrides identified by
 * RECURRENCE-ID), and returns the raw ICS to the client. This module
 * parses that ICS, fans out instances via rrule.js, applies EXDATEs and
 * RECURRENCE-ID overrides, and returns concrete event records ready to
 * render. It also exposes write-side helpers that build RRULE lines and
 * mutate a master's ICS to add EXDATEs or RECURRENCE-ID overrides.
 *
 * Caveats:
 *   - Window-bounded: callers must supply a [windowStart, windowEnd]
 *     range. We never expand an unbounded RRULE for all eternity.
 *   - rrule.js handles DST transitions for floating-time RRULEs but
 *     events with TZID parameters need their VTIMEZONE to be in the ICS
 *     (which iCloud and Google Calendar both include). The backend's
 *     prepare-ics.js ensures VTIMEZONE is present.
 *   - "This and following" series splits aren't implemented here.
 *   - Set `localStorage['debug:recurrence'] = '1'` to log expansion
 *     timing and override merging.
 */

import { rrulestr } from 'rrule';

const debug = (...args: unknown[]) => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('debug:recurrence') === '1') {
      console.info('[recurrence]', ...args);
    }
  } catch {
    /* ignore */
  }
};

export interface RecurrenceMaster {
  uid: string;
  dtstart: Date;
  dtend: Date | null;
  durationMs: number;
  rruleText: string; // full set: DTSTART:... \n RRULE:... \n EXDATE:... lines
  hasRrule: boolean;
}

export interface RecurrenceOverride {
  uid: string;
  recurrenceId: Date; // the original occurrence this override replaces
  dtstart: Date;
  dtend: Date | null;
  rawProps: Record<string, string>;
}

export interface ExpandedInstance {
  id: string; // `${masterUid}::${occurrenceISO}` — unique per occurrence
  masterUid: string;
  occurrence: Date; // original occurrence anchor (used to match overrides)
  start: Date;
  end: Date;
  isOverride: boolean;
}

// ── ICS parsing ────────────────────────────────────────────────────────────
//
// Lightweight regex-based parser. We only need a handful of properties
// (UID, SUMMARY, DTSTART, DTEND, DUE, RRULE, EXDATE, RECURRENCE-ID) and
// don't want to add ical.js (~150KB) to the client just for this. The
// ICS format unfolds with leading whitespace continuation lines per
// RFC 5545 §3.1; we handle that explicitly before splitting.

function unfoldIcs(ical: string): string[] {
  // Per RFC 5545: lines that begin with whitespace are continuations.
  return ical
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
    .filter(Boolean);
}

interface VComponent {
  kind: 'VEVENT' | 'VTODO';
  lines: string[];
}

function extractVComponents(ical: string): VComponent[] {
  const lines = unfoldIcs(ical);
  const comps: VComponent[] = [];
  let active: VComponent | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      active = { kind: 'VEVENT', lines: [] };
      continue;
    }
    if (line === 'BEGIN:VTODO') {
      active = { kind: 'VTODO', lines: [] };
      continue;
    }
    if (line === 'END:VEVENT' || line === 'END:VTODO') {
      if (active) comps.push(active);
      active = null;
      continue;
    }
    if (active) active.lines.push(line);
  }
  return comps;
}

function findProp(lines: string[], propName: string): string | undefined {
  const upper = propName.toUpperCase();
  return lines.find((l) => {
    const colon = l.indexOf(':');
    const semi = l.indexOf(';');
    const nameEnd = semi !== -1 && semi < colon ? semi : colon;
    if (nameEnd === -1) return false;
    return l.slice(0, nameEnd).toUpperCase() === upper;
  });
}

function findAllProps(lines: string[], propName: string): string[] {
  const upper = propName.toUpperCase();
  return lines.filter((l) => {
    const colon = l.indexOf(':');
    const semi = l.indexOf(';');
    const nameEnd = semi !== -1 && semi < colon ? semi : colon;
    if (nameEnd === -1) return false;
    return l.slice(0, nameEnd).toUpperCase() === upper;
  });
}

function getPropValue(line: string | undefined): string {
  if (!line) return '';
  const colon = line.indexOf(':');
  return colon === -1 ? '' : line.slice(colon + 1);
}

// Parse a CalDAV date or datetime value (local floating, UTC, or
// TZID-anchored) into a JS Date. We treat TZID-anchored times as if
// they were in the local timezone for display purposes — full TZID
// resolution would require ical.js's VTIMEZONE parser. The underlying
// ICS preserves the original, so most events round-trip correctly even
// without full TZID resolution.
function parseIcalDate(line: string | undefined): Date | null {
  if (!line) return null;
  const value = getPropValue(line);
  if (!value) return null;
  // YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ or YYYYMMDD
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m) {
    // Fallback to standard parsing
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const [, yy, mm, dd, hh, mi, ss, z] = m;
  const year = Number(yy);
  const month = Number(mm) - 1;
  const day = Number(dd);
  if (hh === undefined) return new Date(year, month, day);
  const hour = Number(hh);
  const min = Number(mi);
  const sec = Number(ss);
  if (z === 'Z') return new Date(Date.UTC(year, month, day, hour, min, sec));
  return new Date(year, month, day, hour, min, sec);
}

function parseExdates(lines: string[]): Date[] {
  const out: Date[] = [];
  for (const line of findAllProps(lines, 'EXDATE')) {
    // EXDATE may have multiple comma-separated values.
    const value = getPropValue(line);
    for (const v of value.split(',')) {
      const d = parseIcalDate(`X:${v.trim()}`);
      if (d) out.push(d);
    }
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect whether a calendar event is the master of a recurring series.
 * Trusts the backend's `is_recurring` flag when present, falls back to
 * scanning the raw ICS for an RRULE: line.
 */
export function isRecurringEvent(event: Record<string, unknown> | undefined): boolean {
  if (!event) return false;
  if (event.is_recurring === true) return true;
  const raw = event.raw as Record<string, unknown> | undefined;
  if (raw?.is_recurring === true) return true;
  const ical =
    (typeof raw?.ical === 'string' && (raw.ical as string)) ||
    (typeof event.ical === 'string' && (event.ical as string)) ||
    '';
  return /\nRRULE[:;]/i.test('\n' + ical);
}

function getEventIcal(event: Record<string, unknown>): string {
  const raw = event.raw as Record<string, unknown> | undefined;
  const candidate =
    (typeof raw?.ical === 'string' && (raw.ical as string)) ||
    (typeof event.ical === 'string' && (event.ical as string)) ||
    '';
  return candidate;
}

/**
 * Expand a recurring master into concrete instances within the window.
 * Applies EXDATEs and merges RECURRENCE-ID overrides found in the same
 * VCALENDAR blob.
 */
export function expandRecurringMaster(
  ical: string,
  windowStart: Date,
  windowEnd: Date,
): ExpandedInstance[] {
  const components = extractVComponents(ical);
  if (!components.length) return [];

  // Separate master (no RECURRENCE-ID) from overrides.
  let master: VComponent | undefined;
  const overrides: VComponent[] = [];
  for (const c of components) {
    const rid = findProp(c.lines, 'RECURRENCE-ID');
    if (rid) overrides.push(c);
    else if (!master) master = c;
  }
  if (!master) return [];

  const dtstartLine = findProp(master.lines, 'DTSTART');
  const dtendLine = findProp(master.lines, 'DTEND') || findProp(master.lines, 'DUE'); /* VTODO */
  const dtstart = parseIcalDate(dtstartLine);
  if (!dtstart) return [];
  const dtend = parseIcalDate(dtendLine);
  const durationMs = dtend ? Math.max(0, dtend.getTime() - dtstart.getTime()) : 0;

  const rruleLine = findProp(master.lines, 'RRULE');
  if (!rruleLine) return [];

  // Build the rule set text for rrule.js. It accepts a multi-line string
  // with DTSTART, RRULE, RDATE, EXDATE — same format the backend uses at
  // calendar-events.js:282-306.
  const ruleLines = [
    dtstartLine!,
    rruleLine,
    ...findAllProps(master.lines, 'EXDATE'),
    ...findAllProps(master.lines, 'RDATE'),
  ].filter(Boolean) as string[];

  let rruleSet;
  try {
    rruleSet = rrulestr(ruleLines.join('\n'), { forceset: true });
  } catch (err) {
    debug('rrulestr failed', err);
    return [];
  }

  // Window expansion — never run the rule unbounded.
  let occurrences: Date[] = [];
  try {
    occurrences = rruleSet.between(windowStart, windowEnd, true);
  } catch (err) {
    debug('rrulestr.between failed', err);
    return [];
  }

  // Filter out EXDATEs (rrulestr handles these already, but iCloud
  // sometimes emits EXDATE values without TZID that don't bind, so we
  // double-check with a manual exclude set).
  const exdateSet = new Set(parseExdates(master.lines).map((d) => d.getTime()));
  occurrences = occurrences.filter((d) => !exdateSet.has(d.getTime()));

  const masterUid = getPropValue(findProp(master.lines, 'UID')) || `master-${dtstart.getTime()}`;

  // Index overrides by their RECURRENCE-ID for O(1) match.
  const overrideMap = new Map<number, VComponent>();
  for (const ov of overrides) {
    const ridDate = parseIcalDate(findProp(ov.lines, 'RECURRENCE-ID'));
    if (ridDate) overrideMap.set(ridDate.getTime(), ov);
  }

  const out: ExpandedInstance[] = [];
  for (const occurrence of occurrences) {
    const ovKey = occurrence.getTime();
    const override = overrideMap.get(ovKey);
    if (override) {
      const ovStart = parseIcalDate(findProp(override.lines, 'DTSTART')) || occurrence;
      const ovEnd =
        parseIcalDate(findProp(override.lines, 'DTEND')) ||
        parseIcalDate(findProp(override.lines, 'DUE')) ||
        new Date(ovStart.getTime() + durationMs);
      out.push({
        id: `${masterUid}::${occurrence.toISOString()}`,
        masterUid,
        occurrence,
        start: ovStart,
        end: ovEnd,
        isOverride: true,
      });
      continue;
    }
    const start = occurrence;
    const end = new Date(start.getTime() + durationMs);
    out.push({
      id: `${masterUid}::${occurrence.toISOString()}`,
      masterUid,
      occurrence,
      start,
      end,
      isOverride: false,
    });
  }
  debug(
    `expanded ${masterUid}: ${out.length} occurrences (${overrideMap.size} overrides) in window`,
    { windowStart, windowEnd },
  );
  return out;
}

/**
 * Replace recurring masters in the input list with their expanded
 * instances. Non-recurring events pass through unchanged.
 *
 * Each generated instance carries the original master event's metadata
 * (title, description, calendarId, etc.) merged with the expanded
 * start/end. The id uses `masterUid::occurrenceISO` so subsequent edits
 * can identify both which series and which occurrence.
 */
export function expandRecurringEvents<T extends Record<string, unknown>>(
  events: T[],
  windowStart: Date,
  windowEnd: Date,
): T[] {
  const startTime = typeof performance !== 'undefined' ? performance.now() : 0;
  const out: T[] = [];
  let expandedCount = 0;
  for (const ev of events) {
    if (!isRecurringEvent(ev)) {
      out.push(ev);
      continue;
    }
    const ical = getEventIcal(ev);
    if (!ical) {
      // No raw ICS available — pass the master through as a single event.
      out.push(ev);
      continue;
    }
    const instances = expandRecurringMaster(ical, windowStart, windowEnd);
    if (!instances.length) {
      out.push(ev);
      continue;
    }
    // The API identifies events by `ev.id` (a mongo ObjectId); the iCal
    // UID is a separate field. The expander returns ids built from the
    // iCal UID, but instance ids must round-trip back to the API for
    // edit/delete — so we use ev.id as the prefix here. Fall back to
    // the iCal UID only when the API didn't return an id (should not
    // happen for events that came from the list endpoint).
    const apiId = String(ev.id || ev.uid || '');
    for (const inst of instances) {
      const occISO = inst.occurrence.toISOString();
      const instId = apiId ? `${apiId}::${occISO}` : inst.id;
      out.push({
        ...ev,
        id: instId,
        start: inst.start.toISOString(),
        end: inst.end.toISOString(),
        // Tag for downstream consumers (modal will know it's a recurring
        // instance and can show the "↻ repeats..." badge).
        recurrenceMasterId: inst.masterUid,
        recurrenceOccurrence: inst.occurrence.toISOString(),
        recurrenceIsOverride: inst.isOverride,
      } as unknown as T);
      expandedCount++;
    }
  }
  if (expandedCount > 0) {
    const ms = typeof performance !== 'undefined' ? Math.round(performance.now() - startTime) : 0;
    debug(`expanded ${events.length} → ${out.length} (+${expandedCount} instances) in ${ms}ms`);
  }
  return out;
}

/**
 * Human-readable summary of an event's RRULE, e.g. "Weekly on Monday".
 * Used by the event modal to show why an event is part of a series.
 * Returns '' if the event has no RRULE or rrule.js can't render it.
 */
export function getRecurrenceText(event: Record<string, unknown> | undefined): string {
  if (!event) return '';
  const ical = getEventIcal(event);
  if (!ical) return '';
  const components = extractVComponents(ical);
  const master = components.find((c) => !findProp(c.lines, 'RECURRENCE-ID'));
  if (!master) return '';
  const dtstartLine = findProp(master.lines, 'DTSTART');
  const rruleLine = findProp(master.lines, 'RRULE');
  if (!dtstartLine || !rruleLine) return '';
  try {
    const rule = rrulestr([dtstartLine, rruleLine].join('\n'));
    return typeof rule.toText === 'function' ? rule.toText() : '';
  } catch {
    return '';
  }
}

// ── Write-side composer ────────────────────────────────────────────────────
//
// The webmail-facing recurrence model. Maps to the simple subset of
// RFC 5545 that covers the vast majority of real-world recurring events.
// "Custom" rules from other clients (BYSETPOS, BYYEARDAY, etc.) are
// preserved byte-for-byte on round-trip but can't be edited via the
// chip composer — the modal shows them as "Custom recurrence (read-only)".

export type RecurrenceMode = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';

export type RecurrenceEnds = 'never' | 'on' | 'after';

export interface RecurrenceSpec {
  mode: RecurrenceMode;
  interval: number; // every N days/weeks/months/years (default 1)
  byday: string[]; // weekly only — RFC tokens: SU MO TU WE TH FR SA
  ends: RecurrenceEnds;
  until: string; // ISO date when ends === 'on' (date-only "YYYY-MM-DD")
  count: number; // when ends === 'after'
  rawRrule: string; // present when mode === 'custom' — preserve verbatim
}

export const DEFAULT_RECURRENCE: RecurrenceSpec = {
  mode: 'none',
  interval: 1,
  byday: [],
  ends: 'never',
  until: '',
  count: 0,
  rawRrule: '',
};

const WEEKDAY_TOKENS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/**
 * Map a JS Date's day-of-week to the RFC 5545 weekday token used in
 * BYDAY (e.g. "MO", "TU", ..., "SU"). Same convention rrule.js uses.
 */
export function jsDayToRfcWeekday(date: Date): string {
  return WEEKDAY_TOKENS[date.getDay()];
}

/**
 * Build a single RRULE line (no DTSTART) from a RecurrenceSpec.
 * Returns '' for mode === 'none'. For mode === 'custom', returns the
 * stored rawRrule verbatim so unrecognized rules round-trip unchanged.
 *
 * @param spec — recurrence configuration
 * @param dtstart — used to derive a default BYDAY for weekly when the
 *   user hasn't manually selected weekdays (RFC requires DTSTART's
 *   weekday to be in BYDAY for FREQ=WEEKLY).
 */
export function buildRrule(spec: RecurrenceSpec, dtstart: Date | null): string {
  if (spec.mode === 'none') return '';
  if (spec.mode === 'custom') return spec.rawRrule || '';

  const parts: string[] = [];
  switch (spec.mode) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekly':
      parts.push('FREQ=WEEKLY');
      break;
    case 'monthly':
      parts.push('FREQ=MONTHLY');
      break;
    case 'yearly':
      parts.push('FREQ=YEARLY');
      break;
  }

  const interval = Math.max(1, Math.floor(Number(spec.interval) || 1));
  if (interval > 1) parts.push(`INTERVAL=${interval}`);

  if (spec.mode === 'weekly') {
    const byday = (spec.byday || []).filter((d) =>
      WEEKDAY_TOKENS.includes(d as (typeof WEEKDAY_TOKENS)[number]),
    );
    // RFC 5545 §3.3.10: WEEKLY without explicit BYDAY defaults to the
    // weekday of DTSTART. Including it explicitly keeps every CalDAV
    // client (Apple, Google, Thunderbird) on the same page.
    if (byday.length > 0) {
      parts.push(`BYDAY=${byday.join(',')}`);
    } else if (dtstart) {
      parts.push(`BYDAY=${jsDayToRfcWeekday(dtstart)}`);
    }
  }

  if (spec.ends === 'after' && spec.count > 0) {
    parts.push(`COUNT=${Math.floor(spec.count)}`);
  } else if (spec.ends === 'on' && spec.until) {
    // UNTIL must be in UTC for timed events ("Z" suffix). For floating
    // times we emit at end-of-day UTC to make the rule inclusive of the
    // user-picked date in any local timezone — small over-shoot but
    // never under-shoots.
    const ymd = spec.until.replace(/-/g, '');
    parts.push(`UNTIL=${ymd}T235959Z`);
  }

  return `RRULE:${parts.join(';')}`;
}

/**
 * Reverse of buildRrule: read an RRULE line out of an event's ICS and
 * produce a RecurrenceSpec the composer can preselect. Rules outside
 * the chip set's vocabulary collapse to mode === 'custom' with the
 * original RRULE preserved in `rawRrule` for round-trip.
 */
export function parseRrule(event: Record<string, unknown> | undefined): RecurrenceSpec {
  if (!event) return { ...DEFAULT_RECURRENCE };
  const ical = getEventIcal(event);
  if (!ical) return { ...DEFAULT_RECURRENCE };
  const components = extractVComponents(ical);
  const master = components.find((c) => !findProp(c.lines, 'RECURRENCE-ID'));
  if (!master) return { ...DEFAULT_RECURRENCE };
  const rruleLine = findProp(master.lines, 'RRULE');
  if (!rruleLine) return { ...DEFAULT_RECURRENCE };

  const spec: RecurrenceSpec = { ...DEFAULT_RECURRENCE, rawRrule: rruleLine };
  const value = getPropValue(rruleLine);
  const params = new Map<string, string>();
  for (const segment of value.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    params.set(segment.slice(0, eq).toUpperCase(), segment.slice(eq + 1));
  }

  const freq = params.get('FREQ');
  const supportedShape =
    !params.has('BYSETPOS') &&
    !params.has('BYYEARDAY') &&
    !params.has('BYWEEKNO') &&
    !params.has('BYMONTH') &&
    !params.has('BYHOUR') &&
    !params.has('BYMINUTE') &&
    !params.has('BYSECOND') &&
    !params.has('BYMONTHDAY');

  if (!supportedShape) {
    spec.mode = 'custom';
    return spec;
  }

  switch (freq) {
    case 'DAILY':
      spec.mode = 'daily';
      break;
    case 'WEEKLY':
      spec.mode = 'weekly';
      break;
    case 'MONTHLY':
      spec.mode = 'monthly';
      break;
    case 'YEARLY':
      spec.mode = 'yearly';
      break;
    default:
      spec.mode = 'custom';
      return spec;
  }

  const interval = Number(params.get('INTERVAL') || '1');
  spec.interval = Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : 1;

  if (spec.mode === 'weekly' && params.has('BYDAY')) {
    const byday = (params.get('BYDAY') || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => WEEKDAY_TOKENS.includes(s as (typeof WEEKDAY_TOKENS)[number]));
    spec.byday = byday;
    // Reject ordinal weekdays like "-1TH" (last Thursday) — the chip
    // composer can't represent them; treat as custom so they round-trip
    // unchanged.
    if ((params.get('BYDAY') || '').split(',').some((s) => /^[+-]?\d/.test(s.trim()))) {
      spec.mode = 'custom';
      return spec;
    }
  }

  if (params.has('COUNT')) {
    spec.ends = 'after';
    spec.count = Math.max(1, Number(params.get('COUNT')) || 1);
  } else if (params.has('UNTIL')) {
    spec.ends = 'on';
    // UNTIL is YYYYMMDD or YYYYMMDDTHHMMSSZ — peel the date.
    const raw = params.get('UNTIL') || '';
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
    spec.until = m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }

  return spec;
}

/**
 * Human-readable summary of a RecurrenceSpec, e.g. "Weekly on Monday"
 * or "Every 2 days, 10 times". Used by the modal to show the user
 * what they've configured. Built from the spec rather than rrule.toText
 * so we don't need to round-trip through rrule.js for live preview.
 */
export function describeRecurrenceSpec(spec: RecurrenceSpec, dtstart: Date | null): string {
  if (spec.mode === 'none') return '';
  if (spec.mode === 'custom') return 'Custom recurrence';

  const interval = Math.max(1, Math.floor(Number(spec.interval) || 1));
  const unit =
    spec.mode === 'daily'
      ? interval === 1
        ? 'day'
        : 'days'
      : spec.mode === 'weekly'
        ? interval === 1
          ? 'week'
          : 'weeks'
        : spec.mode === 'monthly'
          ? interval === 1
            ? 'month'
            : 'months'
          : interval === 1
            ? 'year'
            : 'years';

  const head = interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}`;

  let suffix = '';
  if (spec.mode === 'weekly') {
    const tokenToFull: Record<string, string> = {
      SU: 'Sunday',
      MO: 'Monday',
      TU: 'Tuesday',
      WE: 'Wednesday',
      TH: 'Thursday',
      FR: 'Friday',
      SA: 'Saturday',
    };
    const days = spec.byday.length > 0 ? spec.byday : dtstart ? [jsDayToRfcWeekday(dtstart)] : [];
    if (days.length > 0) {
      suffix = ` on ${days.map((d) => tokenToFull[d]).join(', ')}`;
    }
  }

  let tail = '';
  if (spec.ends === 'after' && spec.count > 0) {
    tail = `, ${spec.count} time${spec.count === 1 ? '' : 's'}`;
  } else if (spec.ends === 'on' && spec.until) {
    tail = `, until ${spec.until}`;
  }

  return `${head}${suffix}${tail}`;
}

// ── Per-instance edits ─────────────────────────────────────────────────────
//
// These helpers mutate a master event's ICS string to add an EXDATE
// (delete one occurrence) or append a RECURRENCE-ID override VEVENT
// (edit one occurrence). They preserve everything else byte-for-byte so
// non-touched lines, VTIMEZONE blocks, and existing overrides round-trip.
//
// "This and following" (truncate master + spawn a new series) is not
// implemented here.

interface IcsDateFormat {
  zone: 'utc' | 'floating' | 'tzid' | 'date-only';
  tzid?: string;
}

function detectIcsDateFormat(line: string | undefined): IcsDateFormat {
  if (!line) return { zone: 'utc' };
  const value = getPropValue(line);
  if (!value) return { zone: 'utc' };
  if (/^\d{8}$/.test(value)) return { zone: 'date-only' };
  if (/Z$/.test(value)) return { zone: 'utc' };
  const colon = line.indexOf(':');
  const semi = line.indexOf(';');
  if (semi !== -1 && semi < colon) {
    const params = line.slice(semi + 1, colon);
    const tzMatch = params.match(/TZID=([^;]+)/i);
    if (tzMatch) return { zone: 'tzid', tzid: tzMatch[1] };
  }
  return { zone: 'floating' };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatIcsDateUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
  );
}

function formatIcsDateFloating(date: Date): string {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

function formatIcsDateOnly(date: Date): string {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
}

/**
 * Format an occurrence Date back into an ICS date/datetime string that
 * matches the format/zone of the reference DTSTART line. Necessary
 * because RECURRENCE-ID and EXDATE values *must* match the master's
 * DTSTART format exactly — off by a Z or a TZID and the binding fails.
 */
function formatOccurrenceForReference(occurrence: Date, referenceLine: string | undefined): string {
  const fmt = detectIcsDateFormat(referenceLine);
  switch (fmt.zone) {
    case 'utc':
      return formatIcsDateUtc(occurrence);
    case 'date-only':
      return formatIcsDateOnly(occurrence);
    case 'floating':
    case 'tzid':
      // For TZID, full conversion would need the tz database. Best-effort
      // floating format works when JS local TZ matches the master's TZID
      // (true for all events created in webmail). Cross-zone TZID overrides
      // are a known limitation.
      return formatIcsDateFloating(occurrence);
  }
}

interface MasterLocations {
  lines: string[];
  masterStart: number;
  masterEnd: number;
  vcalendarEnd: number;
  dtstartLine: string | undefined;
}

function locateMaster(masterIcal: string): MasterLocations | null {
  const lines = unfoldIcs(masterIcal);
  let masterStart = -1;
  let masterEnd = -1;
  let vcalendarEnd = -1;
  let inVevent = false;
  let foundRecurrenceId = false;
  let candidateStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      inVevent = true;
      foundRecurrenceId = false;
      candidateStart = i;
      continue;
    }
    if (inVevent && /^RECURRENCE-ID[;:]/i.test(line)) {
      foundRecurrenceId = true;
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (inVevent && !foundRecurrenceId && masterStart === -1) {
        masterStart = candidateStart;
        masterEnd = i;
      }
      inVevent = false;
      continue;
    }
    if (upper === 'END:VCALENDAR') {
      vcalendarEnd = i;
    }
  }
  if (masterStart === -1 || masterEnd === -1 || vcalendarEnd === -1) return null;
  const dtstartLine = findProp(lines.slice(masterStart, masterEnd), 'DTSTART');
  return { lines, masterStart, masterEnd, vcalendarEnd, dtstartLine };
}

/**
 * Add an EXDATE entry to the master event so the given occurrence is
 * skipped. Idempotent — calling twice with the same occurrence is a
 * no-op. Returns the modified ICS string. Does not touch overrides.
 *
 * Used by "Delete this event" on a recurring instance.
 */
export function addExdateToMaster(masterIcal: string, occurrence: Date): string {
  const loc = locateMaster(masterIcal);
  if (!loc) return masterIcal;

  // No-op if already excluded.
  const masterLines = loc.lines.slice(loc.masterStart + 1, loc.masterEnd);
  const existing = parseExdates(masterLines);
  if (existing.some((d) => d.getTime() === occurrence.getTime())) {
    debug('addExdateToMaster: already excluded', occurrence);
    return masterIcal;
  }

  const fmt = detectIcsDateFormat(loc.dtstartLine);
  const value = formatOccurrenceForReference(occurrence, loc.dtstartLine);
  const exdateLine =
    fmt.zone === 'tzid' && fmt.tzid ? `EXDATE;TZID=${fmt.tzid}:${value}` : `EXDATE:${value}`;

  const out = [...loc.lines];
  out.splice(loc.masterEnd, 0, exdateLine);
  return out.join('\r\n') + '\r\n';
}

export interface OverridePayload {
  summary?: string;
  description?: string;
  location?: string;
  url?: string;
  start: Date;
  end: Date;
  reminderMinutes?: number;
}

function escapeIcsText(val: string): string {
  return (val || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Append a RECURRENCE-ID override VEVENT to the master's VCALENDAR.
 * The override shares the master's UID (RFC 5545 §3.8.4.4) and uses
 * RECURRENCE-ID to point at the original occurrence date. Subsequent
 * fields (DTSTART, DTEND, SUMMARY, etc.) carry the user's edits.
 *
 * If an override for the same occurrence already exists, it's replaced.
 *
 * Used by "Edit this event" on a recurring instance.
 */
export function addOverrideToMaster(
  masterIcal: string,
  occurrence: Date,
  payload: OverridePayload,
): string {
  const loc = locateMaster(masterIcal);
  if (!loc) return masterIcal;

  // Master UID — overrides share this exact UID with the master.
  const masterUid = getPropValue(
    findProp(loc.lines.slice(loc.masterStart + 1, loc.masterEnd), 'UID'),
  );
  if (!masterUid) {
    debug('addOverrideToMaster: master has no UID, refusing to write override');
    return masterIcal;
  }

  const ridValue = formatOccurrenceForReference(occurrence, loc.dtstartLine);
  const fmt = detectIcsDateFormat(loc.dtstartLine);
  const ridLine =
    fmt.zone === 'tzid' && fmt.tzid
      ? `RECURRENCE-ID;TZID=${fmt.tzid}:${ridValue}`
      : `RECURRENCE-ID:${ridValue}`;

  // Format DTSTART/DTEND in the same zone as the master so the override
  // round-trips correctly through every CalDAV client.
  const dtstartValue = formatOccurrenceForReference(payload.start, loc.dtstartLine);
  const dtendValue = formatOccurrenceForReference(payload.end, loc.dtstartLine);
  const dtstartOut =
    fmt.zone === 'tzid' && fmt.tzid
      ? `DTSTART;TZID=${fmt.tzid}:${dtstartValue}`
      : `DTSTART:${dtstartValue}`;
  const dtendOut =
    fmt.zone === 'tzid' && fmt.tzid
      ? `DTEND;TZID=${fmt.tzid}:${dtendValue}`
      : `DTEND:${dtendValue}`;

  const dtstamp = formatIcsDateUtc(new Date());
  const overrideLines: string[] = [
    'BEGIN:VEVENT',
    `UID:${masterUid}`,
    `DTSTAMP:${dtstamp}`,
    ridLine,
    dtstartOut,
    dtendOut,
  ];
  if (payload.summary) overrideLines.push(`SUMMARY:${escapeIcsText(payload.summary)}`);
  if (payload.description) overrideLines.push(`DESCRIPTION:${escapeIcsText(payload.description)}`);
  if (payload.location) overrideLines.push(`LOCATION:${escapeIcsText(payload.location)}`);
  if (payload.url) overrideLines.push(`URL:${escapeIcsText(payload.url)}`);
  if (payload.reminderMinutes && payload.reminderMinutes > 0) {
    overrideLines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(payload.summary || 'Event reminder')}`,
      `TRIGGER:-PT${Math.max(1, Math.round(payload.reminderMinutes))}M`,
      'END:VALARM',
    );
  }
  overrideLines.push('END:VEVENT');

  // Drop any prior override for the same RECURRENCE-ID so we replace,
  // not duplicate. We re-walk the unfolded lines to find existing
  // override blocks targeting this occurrence.
  const out: string[] = [];
  let skip = false;
  let buf: string[] = [];
  let bufIsTargetOverride = false;
  for (const line of loc.lines) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      skip = true;
      buf = [line];
      bufIsTargetOverride = false;
      continue;
    }
    if (skip) {
      buf.push(line);
      if (/^RECURRENCE-ID[;:]/i.test(line)) {
        // Compare normalized values
        const v = getPropValue(line);
        if (v === ridValue) bufIsTargetOverride = true;
      }
      if (upper === 'END:VEVENT') {
        skip = false;
        if (!bufIsTargetOverride) {
          out.push(...buf);
        } else {
          debug('addOverrideToMaster: replacing existing override for', occurrence);
        }
        buf = [];
        bufIsTargetOverride = false;
      }
      continue;
    }
    out.push(line);
  }

  // Insert override before END:VCALENDAR
  const vcalIdx = out.findIndex((l) => l.toUpperCase() === 'END:VCALENDAR');
  if (vcalIdx === -1) return masterIcal;
  out.splice(vcalIdx, 0, ...overrideLines);
  return out.join('\r\n') + '\r\n';
}
