/**
 * The lifetime of a series after it is created: edit one occurrence, delete
 * one, delete one and everything after it. Each edit rewrites the stored ICS,
 * and the calendar shows whatever expanding that ICS gives, so these tests
 * check both the ICS and what it expands to.
 */
import { describe, expect, it } from 'vitest';
import {
  addExdateToMaster,
  addOverrideToMaster,
  endMasterBefore,
  expandRecurringEvents,
} from '../../src/utils/recurrence';

// A rule the repeat chips cannot build, as another app would write it:
// January, April, July and October, on the first Saturday.
const QUARTERLY_RULE = 'RRULE:FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=1SA';
const quarterly = (rule = QUARTERLY_RULE) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Other App//EN',
    'BEGIN:VEVENT',
    'UID:quarterly@example.com',
    'DTSTART:20260103T150000Z',
    'DTEND:20260103T160000Z',
    rule,
    'SUMMARY:Quarterly review',
    'LOCATION:Room 4',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';

const win = [new Date('2026-01-01T00:00:00Z'), new Date('2028-01-01T00:00:00Z')] as const;

const show = (ical: string) =>
  expandRecurringEvents(
    [{ id: 'api-1', title: 'Quarterly review', location: 'Room 4', is_recurring: true, ical }],
    win[0],
    win[1],
  ) as Array<Record<string, string>>;

const dates = (ical: string) => show(ical).map((e) => e.start.slice(0, 10));

describe('a custom series over its lifetime', () => {
  it('starts with every first Saturday of the quarter', () => {
    expect(dates(quarterly())).toEqual([
      '2026-01-03',
      '2026-04-04',
      '2026-07-04',
      '2026-10-03',
      '2027-01-02',
      '2027-04-03',
      '2027-07-03',
      '2027-10-02',
    ]);
  });

  it('shows an edited occurrence with its own title and place, and leaves the rest alone', () => {
    const ical = addOverrideToMaster(quarterly(), new Date('2026-07-04T15:00:00Z'), {
      summary: 'Quarterly review, offsite; bring laptops',
      location: 'Lake house',
      start: new Date('2026-07-04T17:00:00Z'),
      end: new Date('2026-07-04T19:00:00Z'),
    });
    const events = show(ical);
    const july = events.find((e) => e.start.startsWith('2026-07-04'))!;
    expect(july.title).toBe('Quarterly review, offsite; bring laptops');
    expect(july.location).toBe('Lake house');
    expect(july.start).toBe('2026-07-04T17:00:00.000Z');
    // The edit stays tied to its original date so it can be edited again
    expect(july.id).toBe('api-1::2026-07-04T15:00:00.000Z');
    const april = events.find((e) => e.start.startsWith('2026-04-04'))!;
    expect(april.title).toBe('Quarterly review');
    expect(april.location).toBe('Room 4');
    expect(ical).toContain(QUARTERLY_RULE);
  });

  it('does not take the title of a reminder inside an edited occurrence', () => {
    const ical = addOverrideToMaster(quarterly(), new Date('2026-04-04T15:00:00Z'), {
      start: new Date('2026-04-04T15:00:00Z'),
      end: new Date('2026-04-04T16:00:00Z'),
      description: 'Agenda to follow',
      reminderMinutes: 30,
    });
    const april = show(ical).find((e) => e.start.startsWith('2026-04-04'))!;
    expect(april.description).toBe('Agenda to follow');
    // No SUMMARY of its own, so it keeps the series title
    expect(april.title).toBe('Quarterly review');
    // An edited occurrence is a whole event: no LOCATION means none
    expect(april.location).toBe('');
  });

  it('deletes one occurrence, edited or not', () => {
    let ical = addOverrideToMaster(quarterly(), new Date('2026-07-04T15:00:00Z'), {
      summary: 'Moved',
      start: new Date('2026-07-04T17:00:00Z'),
      end: new Date('2026-07-04T18:00:00Z'),
    });
    ical = addExdateToMaster(ical, new Date('2026-04-04T15:00:00Z'));
    ical = addExdateToMaster(ical, new Date('2026-07-04T15:00:00Z'));
    expect(dates(ical)).toEqual([
      '2026-01-03',
      '2026-10-03',
      '2027-01-02',
      '2027-04-03',
      '2027-07-03',
      '2027-10-02',
    ]);
    expect(ical).toContain(QUARTERLY_RULE);
  });

  it('deletes an occurrence and everything after it, keeping the rule', () => {
    let ical = addOverrideToMaster(quarterly(), new Date('2026-04-04T15:00:00Z'), {
      summary: 'Kept edit',
      start: new Date('2026-04-04T15:00:00Z'),
      end: new Date('2026-04-04T16:00:00Z'),
    });
    ical = addOverrideToMaster(ical, new Date('2027-01-02T15:00:00Z'), {
      summary: 'Edit after the cut',
      start: new Date('2027-01-02T15:00:00Z'),
      end: new Date('2027-01-02T16:00:00Z'),
    });
    const ended = endMasterBefore(ical, new Date('2026-10-03T15:00:00Z'))!;
    expect(dates(ended)).toEqual(['2026-01-03', '2026-04-04', '2026-07-04']);
    expect(ended).toContain('RRULE:FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=1SA;UNTIL=20261003T145959Z');
    expect(ended).toContain('SUMMARY:Kept edit');
    expect(ended).not.toContain('Edit after the cut');
    // The series' own reminder and the calendar wrapper are untouched
    expect(ended).toContain('TRIGGER:-PT15M');
    expect(ended).toContain('PRODID:-//Other App//EN');
    expect(ended.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('replaces a COUNT or an earlier UNTIL rather than adding a second end', () => {
    const counted = endMasterBefore(
      quarterly('RRULE:FREQ=MONTHLY;COUNT=6;BYMONTH=1,4,7,10;BYDAY=1SA'),
      new Date('2026-07-04T15:00:00Z'),
    )!;
    expect(counted).toContain(
      'RRULE:FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=1SA;UNTIL=20260704T145959Z',
    );
    expect(dates(counted)).toEqual(['2026-01-03', '2026-04-04']);
  });

  it('leaves nothing to keep when cut at the first occurrence', () => {
    expect(endMasterBefore(quarterly(), new Date('2026-01-03T15:00:00Z'))).toBeNull();
  });

  it('ends an all-day series on the day before', () => {
    const allDay = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:bins',
      'DTSTART;VALUE=DATE:20260105',
      'DTEND;VALUE=DATE:20260106',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'SUMMARY:Bins out',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const ended = endMasterBefore(allDay, new Date('2026-01-19T00:00:00Z'))!;
    expect(ended).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260118');
  });
});
