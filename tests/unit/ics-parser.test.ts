import { describe, it, expect } from 'vitest';
import {
  parseIcs,
  isCalendarAttachment,
  normalizeIcsForCalendar,
  buildReplyIcs,
  fetchAttachmentText,
  findMatchingCachedEvent,
  findConflictingEvents,
} from '../../src/utils/ics-parser';

const sampleIcs = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Test//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:abc123@example.com',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20260520T150000Z',
  'DTEND:20260520T160000Z',
  'SUMMARY:Quarterly Review',
  'DESCRIPTION:Discuss roadmap',
  'LOCATION:Zoom',
  'URL:https://zoom.us/j/12345',
  'ORGANIZER;CN=Alice:mailto:alice@example.com',
  'ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:bob@example.com',
  'ATTENDEE;CN=Carol;PARTSTAT=ACCEPTED:mailto:carol@example.com',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const allDayIcs = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:allday@x',
  'DTSTART;VALUE=DATE:20260601',
  'DTEND;VALUE=DATE:20260602',
  'SUMMARY:Holiday',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const recurringIcs = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:rec@x',
  'DTSTART:20260520T150000Z',
  'DTEND:20260520T160000Z',
  'SUMMARY:Weekly Sync',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('isCalendarAttachment', () => {
  it('matches text/calendar content type', () => {
    expect(isCalendarAttachment({ contentType: 'text/calendar' })).toBe(true);
    expect(isCalendarAttachment({ contentType: 'text/calendar; method=REQUEST' })).toBe(true);
    expect(isCalendarAttachment({ contentType: 'TEXT/CALENDAR' })).toBe(true);
  });

  it('matches application/ics', () => {
    expect(isCalendarAttachment({ contentType: 'application/ics' })).toBe(true);
  });

  it('matches by .ics / .ical / .ifb extension', () => {
    expect(isCalendarAttachment({ filename: 'invite.ics' })).toBe(true);
    expect(isCalendarAttachment({ filename: 'INVITE.ICAL' })).toBe(true);
    expect(isCalendarAttachment({ filename: 'busy.ifb' })).toBe(true);
    expect(isCalendarAttachment({ name: 'invite.ics' })).toBe(true);
  });

  it('rejects unrelated attachments', () => {
    expect(isCalendarAttachment({ contentType: 'image/png', filename: 'logo.png' })).toBe(false);
    expect(isCalendarAttachment({ contentType: 'application/pdf' })).toBe(false);
    expect(isCalendarAttachment({})).toBe(false);
  });
});

describe('parseIcs', () => {
  it('returns null for invalid input', () => {
    expect(parseIcs('')).toBeNull();
    expect(parseIcs('not ics')).toBeNull();
    expect(parseIcs(null as unknown as string)).toBeNull();
  });

  it('extracts core event fields', () => {
    const parsed = parseIcs(sampleIcs);
    expect(parsed).not.toBeNull();
    expect(parsed!.uid).toBe('abc123@example.com');
    expect(parsed!.summary).toBe('Quarterly Review');
    expect(parsed!.description).toBe('Discuss roadmap');
    expect(parsed!.location).toBe('Zoom');
    expect(parsed!.url).toBe('https://zoom.us/j/12345');
    expect(parsed!.method).toBe('REQUEST');
  });

  it('parses organizer with CN and strips mailto:', () => {
    const parsed = parseIcs(sampleIcs)!;
    expect(parsed.organizer).toEqual({ name: 'Alice', email: 'alice@example.com' });
  });

  it('parses attendees with all parameters', () => {
    const parsed = parseIcs(sampleIcs)!;
    expect(parsed.attendees).toHaveLength(2);
    expect(parsed.attendees[0]).toMatchObject({
      email: 'bob@example.com',
      name: 'Bob',
      partstat: 'NEEDS-ACTION',
      role: 'REQ-PARTICIPANT',
      rsvp: true,
    });
    expect(parsed.attendees[1]).toMatchObject({
      email: 'carol@example.com',
      partstat: 'ACCEPTED',
    });
  });

  it('extracts DTSTART/DTEND as JS Dates', () => {
    const parsed = parseIcs(sampleIcs)!;
    expect(parsed.startDate?.toISOString()).toBe('2026-05-20T15:00:00.000Z');
    expect(parsed.endDate?.toISOString()).toBe('2026-05-20T16:00:00.000Z');
    expect(parsed.allDay).toBe(false);
  });

  it('detects allDay events via VALUE=DATE', () => {
    const parsed = parseIcs(allDayIcs)!;
    expect(parsed.allDay).toBe(true);
    expect(parsed.summary).toBe('Holiday');
  });

  it('extracts RRULE recurrence as a string', () => {
    const parsed = parseIcs(recurringIcs)!;
    expect(parsed.recurrence).toMatch(/FREQ=WEEKLY/);
    expect(parsed.recurrence).toMatch(/BYDAY=MO/);
  });

  it('preserves the raw ICS for round-tripping', () => {
    const parsed = parseIcs(sampleIcs)!;
    expect(parsed.raw).toBe(sampleIcs);
  });

  it('returns null when there is no VEVENT', () => {
    const noEvent = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR'].join('\r\n');
    expect(parseIcs(noEvent)).toBeNull();
  });
});

describe('normalizeIcsForCalendar', () => {
  it('strips METHOD line so the ICS can be PUT to user calendar', () => {
    const out = normalizeIcsForCalendar(sampleIcs);
    expect(out).not.toMatch(/^METHOD:/m);
    expect(out).toMatch(/BEGIN:VEVENT/);
  });

  it('emits CRLF line endings', () => {
    const lf = sampleIcs.replace(/\r\n/g, '\n');
    const out = normalizeIcsForCalendar(lf);
    expect(out.split(/\r\n/).length).toBeGreaterThan(5);
  });

  it('moves a Google Meet URL from LOCATION to URL when URL is empty', () => {
    const meetIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      'UID:meet@x',
      'DTSTART:20260520T150000Z',
      'DTEND:20260520T160000Z',
      'SUMMARY:Meet',
      'LOCATION:https://meet.google.com/abc-defg-hij',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = normalizeIcsForCalendar(meetIcs);
    expect(out).toMatch(/URL:https:\/\/meet\.google\.com\/abc-defg-hij/);
    expect(out).not.toMatch(/LOCATION:/);
  });

  it('moves a Zoom URL from LOCATION to URL', () => {
    const zoomIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:z@x',
      'DTSTART:20260520T150000Z',
      'DTEND:20260520T160000Z',
      'SUMMARY:Zoom',
      'LOCATION:https://zoom.us/j/12345',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = normalizeIcsForCalendar(zoomIcs);
    expect(out).toMatch(/URL:https:\/\/zoom\.us\/j\/12345/);
    expect(out).not.toMatch(/LOCATION:/);
  });

  it('leaves a non-URL LOCATION untouched', () => {
    const physicalIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:p@x',
      'DTSTART:20260520T150000Z',
      'DTEND:20260520T160000Z',
      'SUMMARY:Office',
      'LOCATION:Conference Room B',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = normalizeIcsForCalendar(physicalIcs);
    expect(out).toMatch(/LOCATION:Conference Room B/);
    expect(out).not.toMatch(/^URL:/m);
  });

  it('does not overwrite an existing URL property', () => {
    const bothIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:b@x',
      'DTSTART:20260520T150000Z',
      'DTEND:20260520T160000Z',
      'SUMMARY:Both',
      'LOCATION:https://meet.google.com/xyz-abc-def',
      'URL:https://example.com/details',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = normalizeIcsForCalendar(bothIcs);
    expect(out).toMatch(/LOCATION:https:\/\/meet\.google\.com\/xyz-abc-def/);
    expect(out).toMatch(/URL:https:\/\/example\.com\/details/);
  });
});

describe('buildReplyIcs', () => {
  it('returns empty string for missing inputs', () => {
    expect(
      buildReplyIcs(
        { raw: '' } as unknown as ReturnType<typeof parseIcs> & object,
        'a@b',
        'ACCEPTED',
      ),
    ).toBe('');
  });

  it('produces METHOD:REPLY with a single ATTENDEE bearing chosen PARTSTAT', () => {
    const invite = parseIcs(sampleIcs)!;
    const reply = buildReplyIcs(invite, 'bob@example.com', 'ACCEPTED');
    expect(reply).toMatch(/METHOD:REPLY/);
    const attendees = reply.match(/^ATTENDEE.*$/gm) || [];
    expect(attendees).toHaveLength(1);
    expect(attendees[0]).toMatch(/PARTSTAT=ACCEPTED/);
    expect(attendees[0]).toMatch(/mailto:bob@example.com/);
  });

  it('preserves UID, SUMMARY, and DTSTART from the original', () => {
    const invite = parseIcs(sampleIcs)!;
    const reply = buildReplyIcs(invite, 'bob@example.com', 'TENTATIVE');
    expect(reply).toMatch(/UID:abc123@example.com/);
    expect(reply).toMatch(/SUMMARY:Quarterly Review/);
    expect(reply).toMatch(/DTSTART:20260520T150000Z/);
  });

  it('strips DESCRIPTION and VALARM per RFC 5546 best practice', () => {
    const invite = parseIcs(sampleIcs)!;
    const reply = buildReplyIcs(invite, 'bob@example.com', 'DECLINED');
    expect(reply).not.toMatch(/DESCRIPTION:/);
    expect(reply).not.toMatch(/BEGIN:VALARM/);
  });

  it('refreshes DTSTAMP in UTC', () => {
    const invite = parseIcs(sampleIcs)!;
    const reply = buildReplyIcs(invite, 'bob@example.com', 'ACCEPTED');
    expect(reply).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
  });

  it('keeps CN parameter from the matched attendee', () => {
    const invite = parseIcs(sampleIcs)!;
    const reply = buildReplyIcs(invite, 'bob@example.com', 'ACCEPTED');
    expect(reply).toMatch(/CN=Bob/);
  });

  it('matches user email case-insensitively', () => {
    const invite = parseIcs(sampleIcs)!;
    const reply = buildReplyIcs(invite, 'BOB@example.com', 'ACCEPTED');
    expect(reply).toMatch(/mailto:BOB@example.com/);
    // CN comes from the matched attendee even when the casing differs
    expect(reply).toMatch(/CN=Bob/);
  });
});

describe('findMatchingCachedEvent', () => {
  const invite = parseIcs(sampleIcs)!;

  it('matches by ev.uid', () => {
    const events = [{ id: '1', uid: 'abc123@example.com' }];
    const match = findMatchingCachedEvent(invite, events);
    expect(match?.id).toBe('1');
  });

  it('matches by ev.raw.uid (server payload)', () => {
    const events = [{ id: '2', raw: { uid: 'abc123@example.com' } }];
    const match = findMatchingCachedEvent(invite, events);
    expect(match?.id).toBe('2');
  });

  it('matches by ev.id when the server uses the UID as the id', () => {
    // Calendar.svelte's mapCalendarEvents collapses uid into id
    const events = [{ id: 'abc123@example.com', title: 'Quarterly Review' }];
    const match = findMatchingCachedEvent(invite, events);
    expect(match?.id).toBe('abc123@example.com');
  });

  it('is case-insensitive', () => {
    const events = [{ id: '3', uid: 'ABC123@example.com' }];
    expect(findMatchingCachedEvent(invite, events)?.id).toBe('3');
  });

  it('returns null when no match', () => {
    expect(findMatchingCachedEvent(invite, [{ id: '4', uid: 'other@x' }])).toBeNull();
    expect(findMatchingCachedEvent(invite, [])).toBeNull();
  });

  it('returns null when invite has no UID', () => {
    const noUidInvite = { ...invite, uid: '' };
    expect(findMatchingCachedEvent(noUidInvite, [{ id: '5', uid: 'x' }])).toBeNull();
  });
});

describe('findConflictingEvents', () => {
  const invite = parseIcs(sampleIcs)!;
  // invite is 2026-05-20 15:00–16:00 UTC

  it('finds events overlapping the invite range', () => {
    const events = [
      // overlaps end
      { id: '1', start: '2026-05-20T15:30:00Z', end: '2026-05-20T16:30:00Z' },
      // contained
      { id: '2', start: '2026-05-20T15:10:00Z', end: '2026-05-20T15:50:00Z' },
      // touching the start (ends at invite start) — half-open: NOT a conflict
      { id: '3', start: '2026-05-20T14:00:00Z', end: '2026-05-20T15:00:00Z' },
      // unrelated
      { id: '4', start: '2026-05-21T15:00:00Z', end: '2026-05-21T16:00:00Z' },
    ];
    const found = findConflictingEvents(invite, events);
    expect(found.map((e) => e.id).sort()).toEqual(['1', '2']);
  });

  it('excludes events with the same UID as the invite', () => {
    const events = [
      {
        id: '1',
        uid: 'abc123@example.com',
        start: '2026-05-20T15:30:00Z',
        end: '2026-05-20T16:30:00Z',
      },
      { id: '2', uid: 'other@x', start: '2026-05-20T15:30:00Z', end: '2026-05-20T16:30:00Z' },
    ];
    const found = findConflictingEvents(invite, events);
    expect(found.map((e) => e.id)).toEqual(['2']);
  });

  it('ignores events with invalid dates', () => {
    const events = [
      { id: '1', start: 'garbage', end: 'also garbage' },
      { id: '2', start: '2026-05-20T15:30:00Z', end: '2026-05-20T16:30:00Z' },
    ];
    const found = findConflictingEvents(invite, events);
    expect(found.map((e) => e.id)).toEqual(['2']);
  });

  it('returns empty when invite has no time range', () => {
    const noRange = { ...invite, startDate: null, endDate: null };
    expect(
      findConflictingEvents(noRange, [
        { id: '1', start: '2026-05-20T15:30:00Z', end: '2026-05-20T16:30:00Z' },
      ]),
    ).toEqual([]);
  });
});

describe('fetchAttachmentText', () => {
  it('decodes a base64 data: URL', async () => {
    const text = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR';
    const b64 = btoa(unescape(encodeURIComponent(text)));
    const href = `data:text/calendar;base64,${b64}`;
    expect(await fetchAttachmentText(href)).toBe(text);
  });

  it('decodes a plain (URL-encoded) data: URL', async () => {
    const text = 'BEGIN:VCALENDAR';
    const href = `data:text/calendar,${encodeURIComponent(text)}`;
    expect(await fetchAttachmentText(href)).toBe(text);
  });

  it('returns null for empty input', async () => {
    expect(await fetchAttachmentText('')).toBeNull();
  });
});
