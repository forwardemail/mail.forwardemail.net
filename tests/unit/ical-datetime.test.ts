import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import {
  toICalDate,
  addDaysISO,
  buildAllDayRange,
  buildLocalDateTime,
  zoneOffsetMinutes,
  zonedWallClockToUTC,
  parseAllDayFromIcal,
  localDateOf,
  buildVTimezone,
} from '../../src/utils/ical-datetime';

describe('toICalDate', () => {
  it('converts YYYY-MM-DD to YYYYMMDD', () => {
    expect(toICalDate('2025-07-31')).toBe('20250731');
  });
  it('returns empty string for bad input', () => {
    expect(toICalDate('')).toBe('');
    expect(toICalDate('2025/07/31')).toBe('');
    expect(toICalDate('garbage')).toBe('');
  });
});

describe('addDaysISO', () => {
  it('adds days across a month boundary', () => {
    expect(addDaysISO('2025-07-31', 1)).toBe('2025-08-01');
  });
  it('adds days across a year boundary', () => {
    expect(addDaysISO('2025-12-31', 1)).toBe('2026-01-01');
  });
  it('subtracts days (negative)', () => {
    expect(addDaysISO('2025-08-01', -1)).toBe('2025-07-31');
  });
  it('handles leap day', () => {
    expect(addDaysISO('2024-02-28', 1)).toBe('2024-02-29');
  });
});

describe('buildAllDayRange', () => {
  it('single-day all-day has an exclusive (next-day) DTEND', () => {
    expect(buildAllDayRange('2025-07-31')).toEqual({ dtstart: '20250731', dtend: '20250801' });
  });
  it('multi-day all-day ends the day after the inclusive last day', () => {
    expect(buildAllDayRange('2025-07-31', '2025-08-02')).toEqual({
      dtstart: '20250731',
      dtend: '20250803',
    });
  });
  it('returns null for bad input', () => {
    expect(buildAllDayRange('')).toBeNull();
  });
});

describe('buildLocalDateTime', () => {
  it('emits a literal wall-clock value with no instant conversion', () => {
    expect(buildLocalDateTime('2025-07-31', '15:00')).toBe('20250731T150000');
  });
  it('pads single-digit hours', () => {
    expect(buildLocalDateTime('2025-07-31', '9:05')).toBe('20250731T090500');
  });
  it('is independent of the process timezone (pure string math)', () => {
    // No Date is constructed, so the output cannot drift with TZ env.
    expect(buildLocalDateTime('2025-01-01', '00:00')).toBe('20250101T000000');
    expect(buildLocalDateTime('2025-12-31', '23:59')).toBe('20251231T235900');
  });
  it('returns empty string for bad input', () => {
    expect(buildLocalDateTime('2025-07-31', '')).toBe('');
    expect(buildLocalDateTime('', '15:00')).toBe('');
  });
});

describe('zoneOffsetMinutes', () => {
  it('America/Denver is UTC-6 (MDT) in summer', () => {
    expect(zoneOffsetMinutes('America/Denver', new Date('2025-07-31T18:00:00Z'))).toBe(-360);
  });
  it('America/Denver is UTC-7 (MST) in winter', () => {
    expect(zoneOffsetMinutes('America/Denver', new Date('2025-01-15T18:00:00Z'))).toBe(-420);
  });
  it('America/Phoenix is UTC-7 year-round (no DST)', () => {
    expect(zoneOffsetMinutes('America/Phoenix', new Date('2025-07-31T18:00:00Z'))).toBe(-420);
  });
  it('UTC is zero', () => {
    expect(zoneOffsetMinutes('UTC', new Date('2025-07-31T18:00:00Z'))).toBe(0);
  });
});

describe('zonedWallClockToUTC', () => {
  it('3pm in Denver (MDT) is 21:00 UTC', () => {
    expect(zonedWallClockToUTC('2025-07-31', '15:00', 'America/Denver')?.toISOString()).toBe(
      '2025-07-31T21:00:00.000Z',
    );
  });
  it('3pm in Denver (MST, winter) is 22:00 UTC', () => {
    expect(zonedWallClockToUTC('2025-01-15', '15:00', 'America/Denver')?.toISOString()).toBe(
      '2025-01-15T22:00:00.000Z',
    );
  });
  it('regression: a Phoenix device picking Denver must NOT drift by an hour', () => {
    // The 1-hour-ahead bug: the typed "3pm, zone=Denver" must resolve to the
    // Denver instant (21:00Z in summer), regardless of the device being on
    // Phoenix (UTC-7). The wall-clock is anchored to the *selected* zone.
    const denver = zonedWallClockToUTC('2025-07-31', '15:00', 'America/Denver')?.toISOString();
    expect(denver).toBe('2025-07-31T21:00:00.000Z');
    // Phoenix's own 3pm would be 22:00Z — one hour later — proving the zones differ.
    const phoenix = zonedWallClockToUTC('2025-07-31', '15:00', 'America/Phoenix')?.toISOString();
    expect(phoenix).toBe('2025-07-31T22:00:00.000Z');
  });
  it('treats components as UTC when no zone given', () => {
    expect(zonedWallClockToUTC('2025-07-31', '15:00')?.toISOString()).toBe(
      '2025-07-31T15:00:00.000Z',
    );
  });
  it('returns null for bad input', () => {
    expect(zonedWallClockToUTC('2025-07-31', '', 'America/Denver')).toBeNull();
  });
});

describe('parseAllDayFromIcal', () => {
  const allDayIcs = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x@forwardemail.net',
    'DTSTART;VALUE=DATE:20250731',
    'DTEND;VALUE=DATE:20250801',
    'SUMMARY:Holiday',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('detects an all-day event and returns inclusive start/end dates', () => {
    expect(parseAllDayFromIcal(allDayIcs)).toEqual({
      allDay: true,
      startDate: '2025-07-31',
      endDate: '2025-07-31', // exclusive DTEND 08-01 -> inclusive 07-31
    });
  });

  it('returns the inclusive last day for a multi-day all-day event', () => {
    const ics = allDayIcs.replace('DTEND;VALUE=DATE:20250801', 'DTEND;VALUE=DATE:20250803');
    expect(parseAllDayFromIcal(ics)).toEqual({
      allDay: true,
      startDate: '2025-07-31',
      endDate: '2025-08-02',
    });
  });

  it('does NOT classify a timed (TZID) event as all-day', () => {
    const timed = [
      'BEGIN:VEVENT',
      'DTSTART;TZID=America/Denver:20250731T150000',
      'DTEND;TZID=America/Denver:20250731T160000',
      'END:VEVENT',
    ].join('\r\n');
    expect(parseAllDayFromIcal(timed)).toEqual({ allDay: false });
  });

  it('does NOT classify an explicit VALUE=DATE-TIME event as all-day', () => {
    const dt = 'BEGIN:VEVENT\r\nDTSTART;VALUE=DATE-TIME:20250731T150000Z\r\nEND:VEVENT';
    expect(parseAllDayFromIcal(dt)).toEqual({ allDay: false });
  });

  it('returns allDay:false for non-string / empty input', () => {
    expect(parseAllDayFromIcal(undefined)).toEqual({ allDay: false });
    expect(parseAllDayFromIcal('')).toEqual({ allDay: false });
  });
});

describe('localDateOf', () => {
  it('returns the local calendar date of an instant', () => {
    // Construct via local components so the test is TZ-agnostic.
    const d = new Date(2025, 6, 31, 12, 0, 0);
    expect(localDateOf(d)).toBe('2025-07-31');
  });
});

describe('buildVTimezone (resolved via ical.js — the DST-offset regression)', () => {
  // Build an ICS using the synthesized VTIMEZONE + a TZID-anchored DTSTART, then
  // resolve the instant exactly as the backend does. This is the real proof: the
  // old no-RRULE VTIMEZONE resolved America/Denver summer to 07:00Z (MST) instead
  // of 06:00Z (MDT).
  const resolve = (tzid: string, year: number, localStamp: string): string => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//t//EN',
      'CALSCALE:GREGORIAN',
      ...buildVTimezone(tzid, year),
      'BEGIN:VEVENT',
      'UID:t@t',
      'DTSTAMP:20260101T000000Z',
      `DTSTART;TZID=${tzid}:${localStamp}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const comp = new ICAL.Component(ICAL.parse(ics));
    const vt = comp.getFirstSubcomponent('vtimezone');
    if (vt) {
      const tz = new ICAL.Timezone(vt);
      ICAL.TimezoneService.register(tz.tzid, tz);
    }
    const ev = new ICAL.Event(comp.getFirstSubcomponent('vevent'));
    const iso = ev.startDate.toJSDate().toISOString();
    ICAL.TimezoneService.reset();
    return iso;
  };

  it('America/Denver summer midnight resolves to MDT (06:00Z), not MST', () => {
    expect(resolve('America/Denver', 2026, '20260615T000000')).toBe('2026-06-15T06:00:00.000Z');
  });

  it('America/Denver winter midnight resolves to MST (07:00Z)', () => {
    expect(resolve('America/Denver', 2026, '20260115T000000')).toBe('2026-01-15T07:00:00.000Z');
  });

  it('America/Phoenix (no DST) resolves to a fixed -07:00 year-round', () => {
    expect(resolve('America/Phoenix', 2026, '20260615T000000')).toBe('2026-06-15T07:00:00.000Z');
    expect(resolve('America/Phoenix', 2026, '20260115T000000')).toBe('2026-01-15T07:00:00.000Z');
  });

  it('Europe/Berlin honors the EU last-Sunday DST rule (CEST +2 in summer)', () => {
    expect(resolve('Europe/Berlin', 2026, '20260615T120000')).toBe('2026-06-15T10:00:00.000Z');
    expect(resolve('Europe/Berlin', 2026, '20260115T120000')).toBe('2026-01-15T11:00:00.000Z');
  });

  it('emits recurring (RRULE) transitions for a DST zone', () => {
    const lines = buildVTimezone('America/Denver', 2026);
    expect(lines.filter((l) => l.startsWith('RRULE:')).length).toBe(2);
    expect(lines.some((l) => l.includes('BYDAY=2SU'))).toBe(true); // 2nd Sun March
    expect(lines.some((l) => l.includes('BYDAY=1SU'))).toBe(true); // 1st Sun November
  });

  it('returns no VTIMEZONE for UTC / empty', () => {
    expect(buildVTimezone('UTC')).toEqual([]);
    expect(buildVTimezone('')).toEqual([]);
  });
});
