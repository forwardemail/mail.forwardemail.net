import { expect } from '@playwright/test';

/**
 * Set up authenticated session for calendar tests
 */
export async function setupAuthenticatedSession(page) {
  await page.addInitScript(() => {
    localStorage.setItem('webmail_authToken', 'mock-auth-token-12345');
    localStorage.setItem('webmail_email', 'test@example.com');
    localStorage.setItem('webmail_alias_auth', 'test@example.com:mock-password');
  });
}

/**
 * Navigate to calendar and wait for it to load
 */
export async function navigateToCalendar(page) {
  await page.goto('/calendar');
  await page.waitForSelector('.sx-svelte-calendar-wrapper', { timeout: 10000 });
  await page.waitForTimeout(500);
}

/**
 * Open new event modal
 */
export async function openNewEventModal(page) {
  await page.click('button:has-text("+ New Event")');
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
  await page.click('button:has-text("Save")');
  await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });
}

/**
 * Upload ICS file
 */
export async function uploadICSFile(page, filePath) {
  // Calendar page has nested Import buttons (tooltip trigger + actual button),
  // use the input[type="file"] directly via setInputFiles
  const fileInput = page.locator(
    'input[type="file"][accept*="ics"], input[type="file"][accept*="calendar"]',
  );
  await fileInput.setInputFiles(filePath);
}

/**
 * Wait for success toast with specific message
 */
export async function waitForSuccessToast(page, expectedText) {
  const toastContainer = page.locator('[aria-live="polite"]');
  if (expectedText) {
    await expect(toastContainer.getByText(expectedText)).toBeVisible({ timeout: 5000 });
  } else {
    await expect(toastContainer.locator('div').first()).toBeVisible({ timeout: 5000 });
  }
}

/**
 * Wait for error toast
 */
export async function waitForErrorToast(page) {
  const errorLocator = page.locator('[aria-live="polite"] div, div[role="alert"]');
  await expect(errorLocator.first()).toBeVisible({ timeout: 5000 });
}

/**
 * Click on calendar event by title
 */
export async function clickCalendarEvent(page, eventTitle) {
  await page.waitForTimeout(1000);
  const eventElement = page.locator('[class*="sx__"]').filter({ hasText: eventTitle });
  await eventElement.first().click();
  await page.waitForSelector('div[role="dialog"]');
}

/**
 * Verify event exists on calendar
 */
export async function verifyEventOnCalendar(page, eventTitle) {
  await page.waitForTimeout(500);
  const eventElement = page.locator('[class*="sx__"]').filter({ hasText: eventTitle });
  await expect(eventElement.first()).toBeVisible();
}

/**
 * Verify event does not exist on calendar
 */
export async function verifyEventNotOnCalendar(page, eventTitle) {
  await page.waitForTimeout(500);
  const eventElement = page.locator('[class*="sx__"]').filter({ hasText: eventTitle });
  await expect(eventElement).not.toBeVisible();
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

  await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });
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
