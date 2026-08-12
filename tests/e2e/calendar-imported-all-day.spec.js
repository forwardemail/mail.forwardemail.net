import { expect, test } from '@playwright/test';

import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import { mockApi } from './mockApi.js';

const calendars = [
  { id: 'calendar', calendar_id: 'calendar', name: 'Calendar', color: '#2563eb' },
  { id: 'memories', calendar_id: 'memories', name: 'Memories', color: '#be185d' },
];

const events = [
  {
    id: 'legacy-memory',
    uid: 'legacy-memory',
    calendar_id: 'memories',
    summary: 'Annual memory',
    start_date: '2010-08-10T00:00:00.000Z',
    end_date: '2010-08-11T00:00:00.000Z',
    ical: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:legacy-memory',
      'DTSTART;VALUE=DATE:20100810',
      'DTEND;VALUE=DATE:20100811',
      'RRULE:FREQ=YEARLY',
      'SUMMARY:Annual memory',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'),
  },
  {
    id: 'timed-appointment',
    uid: 'timed-appointment',
    calendar_id: 'calendar',
    summary: 'Dentist appointment',
    start_date: '2026-08-12T09:00:00.000Z',
    end_date: '2026-08-12T10:00:00.000Z',
    ical: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:timed-appointment',
      'DTSTART:20260812T090000Z',
      'DTEND:20260812T100000Z',
      'SUMMARY:Dentist appointment',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'),
  },
];

test('renders an imported legacy all-day recurrence without hiding appointments from another calendar', async ({
  page,
}) => {
  // Keep the calendar view on the relevant month and make the legacy bug
  // deterministic: before the regression fix rrule.js used this current date
  // as the fallback anchor for DTSTART;VALUE=DATE.
  await page.clock.install({ time: new Date('2026-08-12T12:00:00.000Z') });
  await setupAuthenticatedSession(page);
  await mockApi(page, { calendars, events });

  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-ready')).toBeVisible({ timeout: 10_000 });

  // Both selected calendars are fetched as one combined event set. The imported
  // all-day series is materialized at its real annual date and a normal timed
  // appointment remains visible instead of being masked by the archive calendar.
  await expect(page.getByText('Annual memory', { exact: true })).toBeVisible();
  await expect(page.getByText('Dentist appointment', { exact: true })).toBeVisible();
});
