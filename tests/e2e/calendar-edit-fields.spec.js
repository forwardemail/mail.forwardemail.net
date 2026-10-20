import { expect, test } from '@playwright/test';

import { openNewEventModal, setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import { mockApi } from './mockApi.js';

// The edit dialog for an existing event, on a phone and on a desktop. Date and
// time fields are the browser's own inputs and open their picker from a click
// anywhere in the field. Delete has to be reachable on both.

const calendars = [{ id: 'calendar', calendar_id: 'calendar', name: 'Calendar' }];
const events = [
  {
    id: 'dentist',
    uid: 'dentist',
    calendar_id: 'calendar',
    summary: 'Dentist appointment',
    start_date: '2026-08-12T15:30:00.000Z',
    end_date: '2026-08-12T16:30:00.000Z',
    ical: [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:dentist',
      'DTSTART:20260812T153000Z',
      'DTEND:20260812T163000Z',
      'SUMMARY:Dentist appointment',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'),
  },
];

async function openEditDialog(page) {
  // Record which inputs asked for their native picker. Headless browsers do
  // not draw one, so the call is what can be checked.
  await page.addInitScript(() => {
    window.__pickers = [];
    HTMLInputElement.prototype.showPicker = function () {
      window.__pickers.push(this.type);
    };
  });
  await page.clock.install({ time: new Date('2026-08-12T12:00:00.000Z') });
  await setupAuthenticatedSession(page);
  await mockApi(page, { calendars, events });
  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-ready')).toBeVisible({ timeout: 10_000 });
  await page.getByText('Dentist appointment', { exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Edit event' })).toBeVisible();
  return dialog;
}

const pickers = (page) => page.evaluate(() => window.__pickers);

for (const [name, viewport] of [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 800 }],
]) {
  test.describe(`edit event on a ${name}`, () => {
    test.use({ viewport });

    test('times are native time fields holding the event times', async ({ page }) => {
      const dialog = await openEditDialog(page);
      const times = dialog.locator('input[type="time"]');
      await expect(times).toHaveCount(2);
      // Local times of 15:30Z and 16:30Z, in whatever zone the run uses
      const local = (iso) =>
        new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      await expect(times.nth(0)).toHaveValue(local(events[0].start_date));
      await expect(times.nth(1)).toHaveValue(local(events[0].end_date));
      // The old typed-time fields and their AM/PM selects are gone
      await expect(dialog.getByPlaceholder('12:00')).toHaveCount(0);
    });

    test('a click on the date or time field opens its picker', async ({ page }) => {
      const dialog = await openEditDialog(page);
      // Click the left edge of the field, away from the picker icon
      const startDate = dialog.locator('input[type="date"]').first();
      await startDate.click({ position: { x: 12, y: 12 } });
      await dialog
        .locator('input[type="time"]')
        .first()
        .click({ position: { x: 12, y: 12 } });
      expect(await pickers(page)).toEqual(['date', 'time']);
    });

    test('a new start time moves the end time with it', async ({ page }) => {
      await openEditDialog(page);
      await page.keyboard.press('Escape');
      const dialog = await openNewEventModal(page);
      const times = dialog.locator('input[type="time"]');
      await times.nth(0).fill('07:45');
      // A new event keeps its one hour length when the start moves
      await expect(times.nth(1)).toHaveValue('08:45');
    });

    test('Delete is reachable and asks before deleting', async ({ page }) => {
      const dialog = await openEditDialog(page);
      const remove = dialog.getByLabel('Delete', { exact: true });
      await expect(remove).toBeVisible();
      await remove.click();
      await expect(page.getByRole('heading', { name: 'Delete event?' })).toBeVisible();
    });
  });
}

// A rule the repeat chips cannot represent, like one made in another app.
// It cannot be saved from here, but deleting never rewrites the rule.
const quarterlyIcal = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:quarterly',
  'DTSTART:20260103T150000Z',
  'DTEND:20260103T160000Z',
  'RRULE:FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=1SA',
  'SUMMARY:Quarterly review',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

async function openQuarterlyOccurrence(page) {
  await page.clock.install({ time: new Date('2026-10-03T12:00:00.000Z') });
  await setupAuthenticatedSession(page);
  await mockApi(page, {
    calendars,
    events: [
      {
        id: 'quarterly',
        uid: 'quarterly',
        calendar_id: 'calendar',
        summary: 'Quarterly review',
        start_date: '2026-01-03T15:00:00.000Z',
        end_date: '2026-01-03T16:00:00.000Z',
        ical: quarterlyIcal,
      },
    ],
  });
  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-ready')).toBeVisible({ timeout: 10_000 });
  await page.getByText('Quarterly review', { exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/1st Saturday/)).toBeVisible();
  return dialog;
}

test.describe('a series with a custom repeat rule', () => {
  test('one occurrence can be deleted', async ({ page }) => {
    const dialog = await openQuarterlyOccurrence(page);
    await dialog.getByLabel('Delete', { exact: true }).click();
    const put = page.waitForRequest(
      (r) => r.method() === 'PUT' && r.url().includes('/v1/calendar-events/quarterly'),
    );
    await page.getByRole('button', { name: 'Only this event' }).click();
    const ical = (await put).postDataJSON().ical;
    // The rule is kept as it was and only this Saturday is excluded
    expect(ical).toContain('RRULE:FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=1SA');
    expect(ical).toContain('EXDATE:20261003T150000Z');
  });

  test('one occurrence can be edited, but not the whole series', async ({ page }) => {
    const dialog = await openQuarterlyOccurrence(page);
    await dialog.getByRole('textbox').first().fill('Quarterly review, offsite');
    await dialog.getByRole('button', { name: 'Update' }).click();
    // The tooltip trigger wraps the button, so the button itself is the last match
    await expect(
      page.getByRole('button', { name: 'All events in the series' }).last(),
    ).toBeDisabled();
    const put = page.waitForRequest(
      (r) => r.method() === 'PUT' && r.url().includes('/v1/calendar-events/quarterly'),
    );
    await page.getByRole('button', { name: 'This event', exact: true }).click();
    const ical = (await put).postDataJSON().ical;
    expect(ical).toContain('RRULE:FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=1SA');
    expect(ical).toContain('RECURRENCE-ID:20261003T150000Z');
    expect(ical).toContain('SUMMARY:Quarterly review\\, offsite');
    // The calendar shows the edit on that date
    await expect(page.getByText('Quarterly review, offsite', { exact: true })).toBeVisible();
  });

  test('an occurrence and the ones after it can be deleted', async ({ page }) => {
    const dialog = await openQuarterlyOccurrence(page);
    await dialog.getByLabel('Delete', { exact: true }).click();
    const put = page.waitForRequest(
      (r) => r.method() === 'PUT' && r.url().includes('/v1/calendar-events/quarterly'),
    );
    await page.getByRole('button', { name: 'This and following events' }).click();
    const ical = (await put).postDataJSON().ical;
    // The series now stops the second before this Saturday
    expect(ical).toContain('RRULE:FREQ=MONTHLY;BYMONTH=1,4,7,10;BYDAY=1SA;UNTIL=20261003T145959Z');
    await expect(page.getByText('Quarterly review', { exact: true })).toHaveCount(0);
  });

  test('the whole series can be deleted', async ({ page }) => {
    const dialog = await openQuarterlyOccurrence(page);
    await dialog.getByLabel('Delete', { exact: true }).click();
    await page.getByRole('button', { name: 'All events in the series' }).click();
    const del = page.waitForRequest(
      (r) => r.method() === 'DELETE' && r.url().includes('/v1/calendar-events/quarterly'),
    );
    await page
      .getByRole('dialog')
      .filter({ hasText: 'Delete event?' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    expect(new URL((await del).url()).pathname).toBe('/v1/calendar-events/quarterly');
    await expect(page.getByText('Quarterly review', { exact: true })).toHaveCount(0);
  });
});

test('a series still shows far from today', async ({ page }) => {
  test.setTimeout(90_000);
  await page.clock.install({ time: new Date('2026-10-07T12:00:00.000Z') });
  await setupAuthenticatedSession(page);
  await mockApi(page, {
    calendars,
    events: [
      {
        id: 'standup',
        uid: 'standup',
        calendar_id: 'calendar',
        summary: 'Weekly standup',
        start_date: '2025-01-06T15:00:00.000Z',
        end_date: '2025-01-06T15:30:00.000Z',
        ical: [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:standup',
          'DTSTART:20250106T150000Z',
          'DTEND:20250106T153000Z',
          'RRULE:FREQ=WEEKLY;BYDAY=MO',
          'SUMMARY:Weekly standup',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join('\r\n'),
      },
    ],
  });
  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-ready')).toBeVisible({ timeout: 10_000 });
  const standup = page.getByText('Weekly standup', { exact: true });
  await expect(standup.first()).toBeVisible();
  // Page the month view back to May, past the 90 days before today that are
  // always shown, and check its Mondays are still there
  const back = page.locator('.sx__forward-backward-navigation button').first();
  for (let i = 0; i < 5; i++) await back.click();
  await expect(page.getByText('May 2026')).toBeVisible();
  // The May grid runs from Monday April 27 to Sunday June 7: six Mondays
  await expect(standup).toHaveCount(6);
});
