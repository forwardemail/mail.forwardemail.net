/**
 * recurrence unit tests.
 *
 * Calendar recurrence (RRULE) is complex, pure logic at ~0% coverage — a bug
 * shows the wrong recurring events. Cover the RRULE build/parse round-trip and
 * the master→instances expansion (windowing, EXDATE exclusion, RECURRENCE-ID
 * overrides), which is what actually paints repeating events on the calendar.
 */
import { describe, expect, it } from 'vitest';
import {
  isRecurringEvent,
  jsDayToRfcWeekday,
  buildRrule,
  parseRrule,
  expandRecurringMaster,
  expandRecurringEvents,
  getRecurrenceText,
  DEFAULT_RECURRENCE,
  type RecurrenceSpec,
} from '../../src/utils/recurrence';

const spec = (over: Partial<RecurrenceSpec>): RecurrenceSpec => ({
  ...DEFAULT_RECURRENCE,
  ...over,
});

describe('isRecurringEvent', () => {
  it('detects the is_recurring flag (top-level and on raw)', () => {
    expect(isRecurringEvent({ is_recurring: true })).toBe(true);
    expect(isRecurringEvent({ raw: { is_recurring: true } })).toBe(true);
  });
  it('detects an RRULE in the ical', () => {
    expect(isRecurringEvent({ ical: 'DTSTART:20260601T090000Z\nRRULE:FREQ=DAILY' })).toBe(true);
  });
  it('is false for a plain event and for undefined', () => {
    expect(isRecurringEvent({ ical: 'DTSTART:20260601T090000Z' })).toBe(false);
    expect(isRecurringEvent(undefined)).toBe(false);
  });
});

describe('jsDayToRfcWeekday', () => {
  it('maps JS getDay() to RFC tokens', () => {
    expect(jsDayToRfcWeekday(new Date('2026-06-07T12:00:00Z'))).toBe('SU'); // Sunday
    expect(jsDayToRfcWeekday(new Date('2026-06-08T12:00:00Z'))).toBe('MO'); // Monday
    expect(jsDayToRfcWeekday(new Date('2026-06-13T12:00:00Z'))).toBe('SA'); // Saturday
  });
});

describe('buildRrule', () => {
  it('returns empty for mode none', () => {
    expect(buildRrule(spec({ mode: 'none' }), null)).toBe('');
  });
  it('preserves a custom rule verbatim', () => {
    expect(buildRrule(spec({ mode: 'custom', rawRrule: 'RRULE:FREQ=HOURLY' }), null)).toBe(
      'RRULE:FREQ=HOURLY',
    );
  });
  it('builds daily / monthly / yearly', () => {
    expect(buildRrule(spec({ mode: 'daily' }), null)).toBe('RRULE:FREQ=DAILY');
    expect(buildRrule(spec({ mode: 'monthly' }), null)).toBe('RRULE:FREQ=MONTHLY');
    expect(buildRrule(spec({ mode: 'yearly' }), null)).toBe('RRULE:FREQ=YEARLY');
  });
  it('includes INTERVAL only when > 1', () => {
    expect(buildRrule(spec({ mode: 'daily', interval: 1 }), null)).toBe('RRULE:FREQ=DAILY');
    expect(buildRrule(spec({ mode: 'daily', interval: 3 }), null)).toBe(
      'RRULE:FREQ=DAILY;INTERVAL=3',
    );
  });
  it('weekly uses explicit BYDAY when provided', () => {
    expect(buildRrule(spec({ mode: 'weekly', byday: ['MO', 'WE', 'FR'] }), null)).toBe(
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
    );
  });
  it('weekly defaults BYDAY to the DTSTART weekday when none chosen', () => {
    const monday = new Date('2026-06-08T09:00:00Z');
    expect(buildRrule(spec({ mode: 'weekly', byday: [] }), monday)).toBe(
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
    );
  });
  it('encodes COUNT and UNTIL end conditions', () => {
    expect(buildRrule(spec({ mode: 'daily', ends: 'after', count: 5 }), null)).toBe(
      'RRULE:FREQ=DAILY;COUNT=5',
    );
    expect(buildRrule(spec({ mode: 'daily', ends: 'on', until: '2026-12-31' }), null)).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20261231T235959Z',
    );
  });
});

describe('parseRrule round-trips buildRrule', () => {
  const eventFor = (rrule: string) => ({
    ical: `BEGIN:VEVENT\nDTSTART:20260608T090000Z\n${rrule}\nEND:VEVENT`,
  });

  it('weekly with byday + count', () => {
    const original = spec({ mode: 'weekly', byday: ['MO', 'WE'], ends: 'after', count: 10 });
    const parsed = parseRrule(eventFor(buildRrule(original, null)));
    expect(parsed.mode).toBe('weekly');
    expect(parsed.byday).toEqual(['MO', 'WE']);
    expect(parsed.ends).toBe('after');
    expect(parsed.count).toBe(10);
  });

  it('daily with until', () => {
    const original = spec({ mode: 'daily', ends: 'on', until: '2026-12-31' });
    const parsed = parseRrule(eventFor(buildRrule(original, null)));
    expect(parsed.mode).toBe('daily');
    expect(parsed.ends).toBe('on');
    expect(parsed.until).toBe('2026-12-31');
  });

  it('collapses an unrecognized rule to custom with rawRrule preserved', () => {
    const parsed = parseRrule(eventFor('RRULE:FREQ=MINUTELY;INTERVAL=15'));
    expect(parsed.mode).toBe('custom');
    expect(parsed.rawRrule).toContain('FREQ=MINUTELY');
  });

  it('returns mode none for a non-recurring event', () => {
    expect(parseRrule({ ical: 'BEGIN:VEVENT\nDTSTART:20260608T090000Z\nEND:VEVENT' }).mode).toBe(
      'none',
    );
  });
});

describe('expandRecurringMaster', () => {
  const dailyIcs = (extra = '') =>
    [
      'BEGIN:VEVENT',
      'UID:evt-1',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'RRULE:FREQ=DAILY;COUNT=5',
      extra,
      'END:VEVENT',
    ]
      .filter(Boolean)
      .join('\n');

  const win = [new Date('2026-06-01T00:00:00Z'), new Date('2026-06-10T00:00:00Z')] as const;

  it('expands a daily series into one instance per day, preserving duration', () => {
    const out = expandRecurringMaster(dailyIcs(), win[0], win[1]);
    expect(out).toHaveLength(5);
    expect(out[0].start.toISOString()).toBe('2026-06-01T09:00:00.000Z');
    // DTEND - DTSTART = 1h duration carried to every instance
    expect(out[0].end.getTime() - out[0].start.getTime()).toBe(60 * 60 * 1000);
    expect(out[4].start.toISOString()).toBe('2026-06-05T09:00:00.000Z');
  });

  it('honors the expansion window', () => {
    const out = expandRecurringMaster(
      dailyIcs(),
      new Date('2026-06-03T00:00:00Z'),
      new Date('2026-06-10T00:00:00Z'),
    );
    expect(out.map((i) => i.start.toISOString())).toEqual([
      '2026-06-03T09:00:00.000Z',
      '2026-06-04T09:00:00.000Z',
      '2026-06-05T09:00:00.000Z',
    ]);
  });

  it('excludes EXDATE occurrences', () => {
    const out = expandRecurringMaster(dailyIcs('EXDATE:20260603T090000Z'), win[0], win[1]);
    expect(out).toHaveLength(4);
    expect(out.map((i) => i.start.toISOString())).not.toContain('2026-06-03T09:00:00.000Z');
  });

  it('applies a RECURRENCE-ID override (different time, isOverride flagged)', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:evt-1',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'RRULE:FREQ=DAILY;COUNT=5',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:evt-1',
      'RECURRENCE-ID:20260602T090000Z',
      'DTSTART:20260602T140000Z',
      'DTEND:20260602T150000Z',
      'END:VEVENT',
    ].join('\n');
    const out = expandRecurringMaster(ics, win[0], win[1]);
    expect(out).toHaveLength(5);
    const jun2 = out.find((i) => i.occurrence.toISOString() === '2026-06-02T09:00:00.000Z');
    expect(jun2?.isOverride).toBe(true);
    expect(jun2?.start.toISOString()).toBe('2026-06-02T14:00:00.000Z');
  });

  it('returns [] for malformed / non-recurring ics', () => {
    expect(expandRecurringMaster('not ics', win[0], win[1])).toEqual([]);
    expect(
      expandRecurringMaster('BEGIN:VEVENT\nDTSTART:20260601T090000Z\nEND:VEVENT', win[0], win[1]),
    ).toEqual([]);
  });
});

describe('expandRecurringEvents', () => {
  const win = [new Date('2026-06-01T00:00:00Z'), new Date('2026-06-10T00:00:00Z')] as const;

  it('passes non-recurring events through untouched', () => {
    const ev = { id: 'a', title: 'Lunch', start: '2026-06-01T12:00:00Z' };
    expect(expandRecurringEvents([ev], win[0], win[1])).toEqual([ev]);
  });

  it('replaces a recurring master with API-id-prefixed instances carrying metadata', () => {
    const master = {
      id: 'api-123',
      title: 'Standup',
      calendarId: 'cal-1',
      is_recurring: true,
      ical: 'BEGIN:VEVENT\nUID:u1\nDTSTART:20260601T090000Z\nDTEND:20260601T091500Z\nRRULE:FREQ=DAILY;COUNT=3\nEND:VEVENT',
    };
    const out = expandRecurringEvents([master], win[0], win[1]) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('api-123::2026-06-01T09:00:00.000Z');
    expect(out[0].title).toBe('Standup'); // metadata preserved
    expect(out[0].recurrenceMasterId).toBe('u1');
    expect(out[0].recurrenceIsOverride).toBe(false);
  });
});

describe('getRecurrenceText', () => {
  it('produces human text for a known rule and "" for none', () => {
    const weekly = 'BEGIN:VEVENT\nDTSTART:20260608T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO\nEND:VEVENT';
    expect(getRecurrenceText({ ical: weekly })).toMatch(/week/i);
    expect(getRecurrenceText({ ical: 'BEGIN:VEVENT\nDTSTART:20260608T090000Z\nEND:VEVENT' })).toBe(
      '',
    );
  });
});

describe('legacy all-day recurrence expansion (VALUE=DATE anchor)', () => {
  /**
   * Regression: rrule.js silently ignores DTSTART;VALUE=DATE and falls back to
   * parse-time as the anchor. Imported "memories" calendars with yearly all-day
   * events therefore always expanded to the current day, not their anniversary.
   * The fix normalises VALUE=DATE anchors to a UTC midnight datetime before
   * passing them to rrule.js.
   */
  it('anchors a VALUE=DATE yearly series to its imported date instead of the current day', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:legacy-memory',
      'DTSTART;VALUE=DATE:20100214',
      'DTEND;VALUE=DATE:20100215',
      'RRULE:FREQ=YEARLY',
      'SUMMARY:Valentine memory',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = expandRecurringEvents(
      [
        {
          id: 'legacy-memory-event',
          calendarId: 'memories',
          allDay: true,
          ical,
        },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-12-31T23:59:59.999Z'),
    );

    expect(events).toHaveLength(1);
    const inst = events[0] as Record<string, unknown>;
    expect(inst.id).toBe('legacy-memory-event::2026-02-14T00:00:00.000Z');
    expect(inst.calendarId).toBe('memories');
    expect(inst.allDay).toBe(true);
    expect(inst.recurrenceOccurrence).toBe('2026-02-14T00:00:00.000Z');
    // start/end are ISO strings produced by expandRecurringEvents
    expect(inst.start).toBe('2026-02-14T00:00:00.000Z');
    // end = start + duration (DTEND - DTSTART = 1 day = 86400000 ms)
    expect(inst.end).toBe('2026-02-15T00:00:00.000Z');
  });

  it('does not affect timed events with a proper DTSTART', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:timed-daily',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'RRULE:FREQ=DAILY;COUNT=3',
      'END:VEVENT',
    ].join('\r\n');

    const events = expandRecurringEvents(
      [{ id: 'timed-1', calendarId: 'cal', ical }],
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-10T00:00:00.000Z'),
    );

    expect(events).toHaveLength(3);
    const first = events[0] as Record<string, unknown>;
    expect(first.start).toBe('2026-06-01T09:00:00.000Z');
  });
});
