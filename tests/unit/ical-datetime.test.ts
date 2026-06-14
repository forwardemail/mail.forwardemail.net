import { describe, it, expect } from 'vitest';
import {
  toICalDate,
  addDaysISO,
  buildAllDayRange,
  buildLocalDateTime,
  zoneOffsetMinutes,
  zonedWallClockToUTC,
  parseAllDayFromIcal,
  localDateOf,
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
