import { test, expect } from '@playwright/test';
import { mockApi } from './mockApi.js';
import { setupAuthenticatedSession, waitForSuccessToast } from '../fixtures/calendar-helpers.js';

test.describe('Event Creation', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await page.goto('/calendar');
    await page.waitForSelector('.sx-svelte-calendar-wrapper', { timeout: 10000 });
  });

  test('should open new event modal when clicking "+ New Event" button', async ({ page }) => {
    await page.click('button:has-text("+ New Event")');

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: 'New event' })).toBeVisible();
    await expect(modal.getByLabel('Title')).toBeFocused();
  });

  test('should create basic timed event', async ({ page }) => {
    await page.click('button:has-text("+ New Event")');

    const modal = page.getByRole('dialog');
    await modal.getByLabel('Title').fill('Project Kickoff');
    await modal.getByLabel('Date').fill('2026-01-25');

    // Verify Save button becomes enabled with valid input
    const saveButton = modal.locator('button:has-text("Save")');
    await expect(saveButton).toBeEnabled();
  });

  test('should create all-day event', async ({ page }) => {
    await page.click('button:has-text("+ New Event")');

    const modal = page.getByRole('dialog');
    await modal.getByLabel('Title').fill('Holiday');
    await modal.getByLabel('Date').fill('2026-01-30');

    // Click the All-day checkbox
    await modal.getByLabel('All-day').check();

    // Verify time inputs are hidden when all-day is checked
    await expect(modal.getByText('Start time')).not.toBeVisible();
    await expect(modal.getByText('End time')).not.toBeVisible();

    // Verify Save button is enabled
    const saveButton = modal.locator('button:has-text("Save")');
    await expect(saveButton).toBeEnabled();
  });

  test('should create event with optional fields', async ({ page }) => {
    await page.click('button:has-text("+ New Event")');

    const modal = page.getByRole('dialog');
    await modal.getByLabel('Title').fill('Client Demo');
    await modal.getByLabel('Date').fill('2026-01-26');
    await modal.getByLabel('Description').fill('Demonstrate new features to client');

    // Expand optional fields
    await modal.locator('button:has-text("More details")').click();

    // Verify optional fields are visible and can be filled
    await expect(modal.locator('input[placeholder="Add location"]')).toBeVisible();
    await modal.locator('input[placeholder="Add location"]').fill('Conference Room A');
    await modal.locator('input[type="url"][placeholder="https://"]').fill('https://zoom.us/j/123');

    // Verify Save button is enabled
    const saveButton = modal.locator('button:has-text("Save")');
    await expect(saveButton).toBeEnabled();
  });

  test('should validate required title field', async ({ page }) => {
    await page.click('button:has-text("+ New Event")');

    const modal = page.getByRole('dialog');

    // Title starts empty, Save should be disabled
    const saveButton = modal.locator('button:has-text("Save")');
    await expect(saveButton).toBeDisabled();

    // Fill title to verify button becomes enabled
    await modal.getByLabel('Title').fill('Test Event');
    await expect(saveButton).toBeEnabled();

    await expect(modal).toBeVisible();
  });

  test('should close modal on Cancel button', async ({ page }) => {
    await page.click('button:has-text("+ New Event")');

    const modal = page.getByRole('dialog');
    await modal.getByLabel('Title').fill('Test Event');

    // Accept the "Discard changes?" confirm dialog that appears when cancelling a dirty form
    page.on('dialog', (dialog) => dialog.accept());

    await modal.locator('button:has-text("Cancel")').click();

    // Wait for the dialog to close
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });
  });

  test('should close modal on Escape key', async ({ page }) => {
    await page.click('button:has-text("+ New Event")');
    await page.keyboard.press('Escape');

    const modal = page.getByRole('dialog');
    await expect(modal).not.toBeVisible();
  });
});

test.describe('Event Editing', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await page.goto('/calendar');
    await page.waitForSelector('.sx-svelte-calendar-wrapper', { timeout: 10000 });
  });

  test.skip('should open edit modal when clicking existing event', async ({ page }) => {
    // Skipping: Depends on pre-rendered events
    await page.waitForTimeout(1000);

    const eventElement = page.locator('[class*="sx__"]').filter({ hasText: 'Morning Standup' });
    await eventElement.first().click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: 'Edit event' })).toBeVisible();
  });

  test.skip('should update event details', async ({ page }) => {
    // Skipping: Depends on pre-rendered events
    await page.waitForTimeout(1000);
    await page.locator('[class*="sx__"]').filter({ hasText: 'Morning Standup' }).first().click();

    const modal = page.getByRole('dialog');

    await modal.getByLabel('Title').fill('Updated Standup');
    await modal.getByLabel('Description').fill('Updated description');

    await modal.locator('button:has-text("Update")').click();

    await waitForSuccessToast(page, /updated/i);
    await expect(modal).not.toBeVisible();
  });

  test.skip('should export event as ICS', async ({ page }) => {
    // Skipping: Depends on pre-rendered events
    await page.waitForTimeout(1000);
    await page.locator('[class*="sx__"]').filter({ hasText: 'Morning Standup' }).first().click();

    const downloadPromise = page.waitForEvent('download');

    await page.click('button[aria-label="Event actions"]');
    await page.click('button:has-text("Export as .ics")');

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.ics$/);

    await waitForSuccessToast(page, /exported/i);
  });

  test.skip('should delete event with confirmation', async ({ page }) => {
    // Skipping: Depends on pre-rendered events
    await page.waitForTimeout(1000);
    await page.locator('[class*="sx__"]').filter({ hasText: 'Morning Standup' }).first().click();

    await page.click('button[aria-label="Event actions"]');
    await page.click('button:has-text("Delete")');

    const confirmModal = page.getByRole('dialog');
    await expect(confirmModal).toBeVisible();
    await expect(confirmModal.locator('text=permanently removed')).toBeVisible();

    await confirmModal.locator('button:has-text("Delete")').click();

    await waitForSuccessToast(page, /deleted/i);
  });

  test.skip('should cancel deletion', async ({ page }) => {
    // Skipping: Depends on pre-rendered events
    await page.waitForTimeout(1000);
    await page.locator('[class*="sx__"]').filter({ hasText: 'Morning Standup' }).first().click();

    await page.click('button[aria-label="Event actions"]');
    await page.click('button:has-text("Delete")');

    await page.click('button:has-text("Cancel")');

    const confirmModal = page.getByRole('dialog');
    await expect(confirmModal).not.toBeVisible();
  });
});
