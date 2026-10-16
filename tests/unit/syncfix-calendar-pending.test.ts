import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPendingEventMutations,
  icalUid,
  swapCreatedEvent,
  type PendingEventMutation,
} from '../../src/utils/calendar-pending';

const ICAL = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:1760550000000@forwardemail.net',
  'DTSTART:20261020T150000Z',
  'DTEND:20261020T160000Z',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const provisional = {
  id: 'temp-6f1c',
  title: 'Dentist',
  start: '2026-10-20T15:00:00.000Z',
  end: '2026-10-20T16:00:00.000Z',
  calendarId: 'cal-1',
  raw: null,
};

// What the events list returns for the same event once the POST has landed.
const fetched = {
  id: '6710aa0f9c1e2b0012ab34cd',
  title: 'Dentist',
  start: '2026-10-20T15:00:00.000Z',
  end: '2026-10-20T16:00:00.000Z',
  calendarId: 'cal-1',
  raw: {
    id: '6710aa0f9c1e2b0012ab34cd',
    uid: '1760550000000@forwardemail.net',
    calendar_id: 'cal-1',
    ical: ICAL,
  },
};

const other = { id: 'evt-other', title: 'Standup', calendarId: 'cal-1', raw: { uid: 'x@y' } };

const pendingCreate = (): Map<string, PendingEventMutation> =>
  new Map([
    [provisional.id, { token: 1, patch: provisional, insert: true, icalUid: icalUid(ICAL) }],
  ]);

describe('optimistic calendar create', () => {
  it('reads the UID the create was sent with', () => {
    expect(icalUid(ICAL)).toBe('1760550000000@forwardemail.net');
  });

  it('does not show the provisional copy next to the server copy a refetch brought in', () => {
    // A websocket-triggered refetch lands after the server stored the event
    // but before the POST response reached us.
    const list = applyPendingEventMutations([other, fetched], pendingCreate());
    expect(list.map((ev) => (ev as { id: string }).id)).toEqual([other.id, fetched.id]);
  });

  it('still shows the provisional copy while the server does not have it yet', () => {
    const list = applyPendingEventMutations([other], pendingCreate());
    expect(list.map((ev) => (ev as { id: string }).id)).toEqual([other.id, provisional.id]);
  });

  it('drops the provisional copy on POST success when the server copy is already listed', () => {
    const before = [other, fetched, provisional];
    const after = swapCreatedEvent(before, provisional.id, fetched.id, fetched.raw);
    expect(after.map((ev) => (ev as { id: string }).id)).toEqual([other.id, fetched.id]);
  });

  it('renames the provisional copy when no refetch has brought the server copy in', () => {
    const after = swapCreatedEvent([other, provisional], provisional.id, fetched.id, fetched.raw);
    expect(after).toEqual([other, { ...provisional, id: fetched.id, raw: fetched.raw }]);
  });
});

describe('account switch', () => {
  it('drops pending calendar changes when the calendar resets for another account', () => {
    const source = readFileSync(resolve(__dirname, '../../src/svelte/Calendar.svelte'), 'utf8');
    const reset = source.slice(source.indexOf('const resetCalendarState = () => {'));
    const body = reset.slice(0, reset.indexOf('\n  };'));
    expect(body).toContain('pendingEventMutations.clear()');
  });
});
