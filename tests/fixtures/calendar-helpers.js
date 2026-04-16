import { expect } from '@playwright/test';

/**
 * Install an auth bootstrap into the page so every navigation starts with a
 * valid session in localStorage AND the tab-scoped sessionStorage keys the
 * storage layer looks at first. Must be called before `page.goto`.
 */
export async function setupAuthenticatedSession(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('webmail_authToken', 'mock-auth-token-12345');
      localStorage.setItem('webmail_email', 'test@example.com');
      localStorage.setItem('webmail_alias_auth', 'test@example.com:mock-password');
      // Tab-scoped keys (see TAB_SCOPED_KEYS in src/utils/storage.js) are
      // read from sessionStorage first, so seed them there too to avoid a
      // race where the first read returns null before the copy-on-read fires.
      sessionStorage.setItem('alias_auth', 'test@example.com:mock-password');
      sessionStorage.setItem('email', 'test@example.com');
      sessionStorage.setItem('authToken', 'mock-auth-token-12345');
    } catch {
      // storage may be unavailable in edge cases — ignore and let the test fail with
      // a more informative error later.
    }
  });
}

/**
 * Navigate to /calendar and wait for the Schedule-X component to finish mounting.
 * Uses the `data-testid="calendar-ready"` marker the app renders once
 * calendarInstance is created, so it survives Schedule-X internal class
 * renames.
 */
export async function navigateToCalendar(page) {
  await page.goto('/calendar');
  await page
    .locator('[data-testid="calendar-ready"]')
    .waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Open new event modal
 */
export async function openNewEventModal(page) {
  await page.getByRole('button', { name: '+ New Event' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  return modal;
}

/**
 * Fill event form with provided data
 */
export async function fillEventForm(page, eventData) {
  const {
    title,
    date,
    allDay = false,
    startTime,
    startMeridiem,
    endTime,
    endMeridiem,
    description,
    location,
    url,
    timezone,
    attendees,
  } = eventData;

  const modal = page.getByRole('dialog');

  if (title) {
    await modal.getByLabel('Title').fill(title);
  }

  if (date) {
    await modal.getByLabel('Date').fill(date);
  }

  if (allDay) {
    await modal.getByLabel('All-day').check();
  } else {
    if (startTime) {
      await page.click('input[id="new-event-start"]');
      await page.click(`.time-dropdown button:has-text("${startTime}")`);
    }
    if (startMeridiem) {
      await page.selectOption('select:near(input[id="new-event-start"])', startMeridiem);
    }
    if (endTime) {
      await page.click('input[id="new-event-end"]');
      await page.click(`.time-dropdown button:has-text("${endTime}")`);
    }
    if (endMeridiem) {
      await page.selectOption('select:near(input[id="new-event-end"])', endMeridiem);
    }
  }

  if (description) {
    await modal.getByLabel('Description').fill(description);
  }

  if (location || url || timezone || attendees) {
    const moreDetailsBtn = page.locator('button:has-text("More details")');
    if (await moreDetailsBtn.isVisible()) {
      await moreDetailsBtn.click();
    }

    if (location) {
      await page.fill('input[placeholder="Add location"]', location);
    }
    if (url) {
      await page.fill('input[type="url"][placeholder="https://"]', url);
    }
    if (timezone) {
      await page.fill('input[placeholder*="America/Chicago"]', timezone);
    }
    if (attendees) {
      await page.fill('input[placeholder*="Comma-separated"]', attendees);
    }
  }
}

/**
 * Save event form
 */
export async function saveEventForm(page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Upload ICS file
 */
export async function uploadICSFile(page, filePath) {
  const fileInput = page.locator(
    'input[type="file"][accept*="ics"], input[type="file"][accept*="calendar"]',
  );
  await fileInput.setInputFiles(filePath);
}

/**
 * Wait for success toast. Polls the toast list rather than sleeping.
 */
export async function waitForSuccessToast(page, expectedText) {
  const toast = page.locator('[data-testid="toast"]').first();
  await toast.waitFor({ state: 'visible', timeout: 5000 });
  if (expectedText) {
    await expect(toast.getByTestId('toast-message')).toHaveText(
      typeof expectedText === 'string' ? expect.stringContaining(expectedText) : expectedText,
    );
  }
}

/**
 * Wait for error toast
 */
export async function waitForErrorToast(page) {
  await page
    .locator('[data-testid="toast"][data-toast-type="error"], [data-testid="toast"]')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Click on calendar event by title. Polls for Schedule-X to render events
 * instead of sleeping.
 */
export async function clickCalendarEvent(page, eventTitle) {
  const eventElement = page.locator('[class*="sx__"]').filter({ hasText: eventTitle }).first();
  await eventElement.waitFor({ state: 'visible', timeout: 5000 });
  await eventElement.click();
  await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Verify event exists on calendar
 */
export async function verifyEventOnCalendar(page, eventTitle) {
  await expect(page.locator('[class*="sx__"]').filter({ hasText: eventTitle }).first()).toBeVisible(
    { timeout: 5000 },
  );
}

/**
 * Verify event does not exist on calendar
 */
export async function verifyEventNotOnCalendar(page, eventTitle) {
  await expect(
    page.locator('[class*="sx__"]').filter({ hasText: eventTitle }).first(),
  ).not.toBeVisible({ timeout: 3000 });
}

/**
 * Delete event from edit modal
 */
export async function deleteEventFromModal(page) {
  await page.click('button[aria-label="Event actions"]');
  await page.click('button:has-text("Delete")');

  const confirmModal = page.getByRole('dialog');
  await expect(confirmModal).toBeVisible();
  await confirmModal.locator('button:has-text("Delete")').click();

  await confirmModal.waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Get current date in YYYY-MM-DD format
 */
export function getFormattedDate(daysOffset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  return date.toISOString().split('T')[0];
}

/**
 * Verify modal field values
 */
export async function verifyModalFields(page, expectedData) {
  const modal = page.getByRole('dialog');

  if (expectedData.title) {
    await expect(modal.locator(`input[value="${expectedData.title}"]`)).toBeVisible();
  }

  if (expectedData.date) {
    await expect(modal.locator('input[type="date"]')).toHaveValue(expectedData.date);
  }

  if (expectedData.description) {
    await expect(modal.locator('textarea')).toHaveValue(expectedData.description);
  }

  if (
    expectedData.location ||
    expectedData.url ||
    expectedData.timezone ||
    expectedData.attendees
  ) {
    const moreDetailsBtn = modal.locator('button:has-text("More details")');
    if (await moreDetailsBtn.isVisible()) {
      await moreDetailsBtn.click();
    }

    if (expectedData.location) {
      await expect(modal.locator(`input[value="${expectedData.location}"]`)).toBeVisible();
    }
    if (expectedData.url) {
      await expect(modal.locator(`input[value="${expectedData.url}"]`)).toBeVisible();
    }
  }
}
