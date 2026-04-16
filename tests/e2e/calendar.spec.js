import { test, expect } from '@playwright/test';
import { mockApi } from './mockApi.js';
import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';

const buildCalendars = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `calendar-${index + 1}`,
    calendar_id: `calendar-${index + 1}`,
    name: `Calendar ${index + 1}`,
    displayName: `Calendar ${index + 1}`,
    color: `#${String((index + 1) * 1118481)
      .slice(0, 6)
      .padStart(6, '0')}`,
  }));

const buildEvents = (count, calendarId = 'default') =>
  Array.from({ length: count }, (_, index) => ({
    id: `evt-${index + 1}`,
    uid: `evt-${index + 1}`,
    calendar_id: calendarId,
    summary: `Event ${index + 1}`,
    title: `Event ${index + 1}`,
    start: new Date(Date.UTC(2026, 0, (index % 27) + 1, 9, 0, 0)).toISOString(),
    end: new Date(Date.UTC(2026, 0, (index % 27) + 1, 10, 0, 0)).toISOString(),
    start_date: new Date(Date.UTC(2026, 0, (index % 27) + 1, 9, 0, 0)).toISOString(),
    end_date: new Date(Date.UTC(2026, 0, (index % 27) + 1, 10, 0, 0)).toISOString(),
    dtstart: new Date(Date.UTC(2026, 0, (index % 27) + 1, 9, 0, 0)).toISOString(),
    dtend: new Date(Date.UTC(2026, 0, (index % 27) + 1, 10, 0, 0)).toISOString(),
    description: '',
    location: '',
    url: '',
    timezone: 'UTC',
  }));

test.describe('Calendar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Auth FIRST (init script runs before any page scripts), then mocks.
    await setupAuthenticatedSession(page);
    await mockApi(page);
  });

  test('should show calendar header with actions', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.getByTestId('calendar-header')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New Event' })).toBeVisible();
    await expect(page.getByLabel('Import calendar')).toBeVisible();
  });

  test('should display Schedule-X calendar component', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.getByTestId('calendar-ready')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Calendar Pagination', () => {
  test('should request every page of calendars', async ({ page }) => {
    const calendarPages = [];

    page.on('request', (request) => {
      if (!request.url().includes('/v1/calendars')) return;
      const url = new URL(request.url());
      calendarPages.push(Number(url.searchParams.get('page') || '1'));
    });

    await setupAuthenticatedSession(page);
    await mockApi(page, {
      calendars: buildCalendars(51),
      events: [],
    });

    await page.goto('/calendar');
    await expect(page.getByTestId('calendar-ready')).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(() => [...new Set(calendarPages)].sort((left, right) => left - right))
      .toEqual([1, 2]);
  });

  test('should request every page of events for the selected calendar', async ({ page }) => {
    const eventPages = [];

    page.on('request', (request) => {
      if (!request.url().includes('/v1/calendar-events')) return;
      const url = new URL(request.url());
      eventPages.push({
        page: Number(url.searchParams.get('page') || '1'),
        calendarId: url.searchParams.get('calendar_id') || '',
      });
    });

    await setupAuthenticatedSession(page);
    await mockApi(page, {
      calendars: [buildCalendars(1)[0]],
      events: buildEvents(501, 'calendar-1'),
    });

    await page.goto('/calendar');
    await expect(page.getByTestId('calendar-ready')).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(() =>
        [
          ...new Set(eventPages.map((eventPage) => `${eventPage.calendarId}:${eventPage.page}`)),
        ].sort(),
      )
      .toEqual(['calendar-1:1', 'calendar-1:2']);
  });
});
