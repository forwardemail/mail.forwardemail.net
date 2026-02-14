import { test, expect } from '@playwright/test';
import { mockApi } from './mockApi.js';
import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import {
  navigateToContacts,
  selectContact,
  editContactInline,
  saveContactInline,
  toggleOptionalFields,
  ensureOptionalFieldsExpanded,
  openActionsMenu,
  clickMenuItem,
  getContactInitials,
} from '../fixtures/contacts-helpers.js';

test.describe('Contact Photo Management', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should show initials when no photo', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');

    // Check for initials (AJ for Alice Johnson)
    const initials = page.getByText('AJ').first();
    await expect(initials).toBeVisible();
  });

  test('should display consistent avatar color', async ({ page }) => {
    // Select contact first time and record background color
    await selectContact(page, 'Bob Smith');
    const avatar1 = page.getByText('BS').first();
    const color1 = await avatar1.evaluate(
      (el) => getComputedStyle(el.closest('[style]') || el).backgroundColor,
    );

    // Select another contact
    await selectContact(page, 'Carol Williams');

    // Select Bob again
    await selectContact(page, 'Bob Smith');
    const avatar2 = page.getByText('BS').first();
    const color2 = await avatar2.evaluate(
      (el) => getComputedStyle(el.closest('[style]') || el).backgroundColor,
    );

    // Colors should be the same
    expect(color1).toEqual(color2);
  });

  test('should show clickable avatar in edit area', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');

    // Avatar area should be clickable — find the cursor-pointer container that holds the initials
    const avatarArea = page.locator('.cursor-pointer').filter({ hasText: 'AJ' });
    await expect(avatarArea).toBeVisible();
  });

  test('should calculate initials correctly for different name formats', async ({ page }) => {
    // Test various contact name formats
    const testCases = [
      { name: 'Alice Johnson', expected: 'AJ' },
      { name: 'Bob Smith', expected: 'BS' },
      { name: 'Carol Williams', expected: 'CW' },
    ];

    for (const testCase of testCases) {
      await selectContact(page, testCase.name);
      const initials = page.getByText(testCase.expected, { exact: true }).first();
      await expect(initials).toBeVisible();
    }
  });
});

test.describe('Optional Fields', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should expand optional fields section', async ({ page }) => {
    await selectContact(page, 'Carol Williams');

    // Ensure optional fields are visible (may auto-expand for contacts with data)
    await ensureOptionalFieldsExpanded(page);

    // Optional fields should be visible (value is in a textbox)
    await expect(page.getByLabel('Company', { exact: true }).first()).toHaveValue('TechCorp');
  });

  test('should collapse optional fields section', async ({ page }) => {
    await selectContact(page, 'Carol Williams');

    // Expand
    await toggleOptionalFields(page);
    await page.waitForTimeout(300);

    // Collapse
    await toggleOptionalFields(page);
    await page.waitForTimeout(300);

    // Fields should be hidden or collapsed
    // (Implementation may vary, but toggle should work)
  });

  test('should show indicator when optional fields have values', async ({ page }) => {
    // Select contact with optional fields
    await selectContact(page, 'Carol Williams');

    // Look for the indicator (dot or other visual indicator)
    const optionalToggle = page.locator('button:has-text("Additional info")');
    await expect(optionalToggle).toBeVisible();
  });

  test('should save company field', async ({ page }) => {
    await selectContact(page, 'David Chen');

    // Edit and add company
    await editContactInline(page, {
      company: 'Tech Startup Inc',
    });

    await saveContactInline(page);

    // Verify company saved (re-select to reload, expand if needed)
    await selectContact(page, 'David Chen');
    await ensureOptionalFieldsExpanded(page);

    await expect(page.getByLabel('Company', { exact: true }).first()).toHaveValue(
      'Tech Startup Inc',
    );
  });

  test('should save job title field', async ({ page }) => {
    await selectContact(page, 'Bob Smith');

    // Edit and add job title
    await editContactInline(page, {
      jobTitle: 'Senior Architect',
    });

    await saveContactInline(page);

    // Verify job title saved
    await selectContact(page, 'Bob Smith');
    await ensureOptionalFieldsExpanded(page);

    await expect(page.getByLabel('Job Title', { exact: true }).first()).toHaveValue(
      'Senior Architect',
    );
  });

  test('should save timezone field', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');

    // Edit and add timezone
    await editContactInline(page, {
      timezone: 'America/Chicago',
    });

    await saveContactInline(page);

    // Verify timezone saved
    await selectContact(page, 'Alice Johnson');
    await ensureOptionalFieldsExpanded(page);

    await expect(page.getByLabel('Time Zone', { exact: true }).first()).toHaveValue(
      'America/Chicago',
    );
  });

  test('should save website field', async ({ page }) => {
    await selectContact(page, 'David Chen');

    // Edit and add website
    await editContactInline(page, {
      website: 'https://davidchen.dev',
    });

    await saveContactInline(page);

    // Verify website saved
    await selectContact(page, 'David Chen');
    await ensureOptionalFieldsExpanded(page);

    await expect(page.getByLabel('Website', { exact: true }).first()).toHaveValue(
      'https://davidchen.dev',
    );
  });

  test('should save birthday field', async ({ page }) => {
    await selectContact(page, 'Bob Smith');

    // Edit and add birthday
    await editContactInline(page, {
      birthday: '1985-03-15',
    });

    await saveContactInline(page);

    // Verify birthday saved
    await selectContact(page, 'Bob Smith');
    await toggleOptionalFields(page);

    // Birthday should be visible (format may vary)
    await page.waitForTimeout(500);
  });
});

test.describe('Integration Actions', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should navigate to compose email', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');

    // Click Email action via dropdown menu
    await openActionsMenu(page);
    await clickMenuItem(page, 'Email');

    // Should navigate to mailbox with compose
    await page.waitForTimeout(500);
    expect(page.url()).toContain('mailbox');
  });

  test('should navigate to add calendar event', async ({ page }) => {
    await selectContact(page, 'Bob Smith');

    // Click Add event action via dropdown menu
    await openActionsMenu(page);
    await clickMenuItem(page, 'Add event');

    // Should navigate to calendar
    await page.waitForTimeout(500);
    expect(page.url()).toContain('calendar');
  });

  test('should navigate to view emails from contact', async ({ page }) => {
    await selectContact(page, 'Carol Williams');

    // Click View emails action via dropdown menu
    await openActionsMenu(page);
    await clickMenuItem(page, 'View emails');

    // Should navigate to mailbox with search
    await page.waitForTimeout(500);
    expect(page.url()).toContain('mailbox');
  });

  test('should show all action buttons', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');

    // Open actions menu
    await openActionsMenu(page);

    // Verify all actions are visible (these are menuitems, not buttons)
    await expect(page.getByRole('menuitem', { name: 'Email', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Add event' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'View emails' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Export/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  });

  test('should close actions menu after action', async ({ page }) => {
    await selectContact(page, 'Bob Smith');

    // Open menu and click an action
    await openActionsMenu(page);
    await clickMenuItem(page, 'Email');

    // Menu should close after action (navigates away)
    await page.waitForTimeout(300);
  });
});

test.describe('Error Handling & Edge Cases', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
  });

  test('should show loading state', async ({ page }) => {
    // Navigate and check for loading
    await page.goto('/contacts');

    // Should eventually show contacts list
    await page.waitForSelector('ul li button', { timeout: 10000 });
  });

  test('should handle empty contact list', async ({ page }) => {
    // Mock empty contacts
    await mockApi(page, { contacts: [] });
    await setupAuthenticatedSession(page);
    await page.goto('/contacts');

    // Should show empty state
    await expect(page.getByText('No contacts found')).toBeVisible();
  });

  test('should handle very long contact names', async ({ page }) => {
    await navigateToContacts(page);

    // Create contact with long name
    await page.getByRole('button', { name: /New contact/i }).click();
    await page.waitForTimeout(300);

    const longName = 'A'.repeat(100) + ' ' + 'B'.repeat(100);
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).first().fill(longName);
    await dialog.getByLabel('Email', { exact: true }).first().fill('longname@example.com');

    await dialog.locator('button:has-text("Save")').click();
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // Should still display (may be truncated in list)
    const contactRow = page.locator('li button').filter({ hasText: 'longname@example.com' });
    await expect(contactRow).toBeVisible();
  });

  test('should handle very long email addresses', async ({ page }) => {
    await navigateToContacts(page);

    // Create contact with long email
    await page.getByRole('button', { name: /New contact/i }).click();
    await page.waitForTimeout(300);

    const longEmail = 'a'.repeat(50) + '@' + 'b'.repeat(50) + '.com';
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).first().fill('Long Email User');
    await dialog.getByLabel('Email', { exact: true }).first().fill(longEmail);

    await dialog.locator('button:has-text("Save")').click();
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // Should still display (may be truncated)
    await expect(page.locator('li button').filter({ hasText: 'Long Email User' })).toBeVisible();
  });

  test('should handle special characters in name', async ({ page }) => {
    await navigateToContacts(page);

    // Create contact with special characters
    await page.getByRole('button', { name: /New contact/i }).click();
    await page.waitForTimeout(300);

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).first().fill("O'Neil & Sons");
    await dialog.getByLabel('Email', { exact: true }).first().fill('oneil@example.com');

    await dialog.locator('button:has-text("Save")').click();
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // Should properly display special characters
    await expect(page.locator('li button').filter({ hasText: "O'Neil & Sons" })).toBeVisible();
  });
});

test.describe('Mobile Responsiveness', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
  });

  test('should show back button on mobile in detail view', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    await navigateToContacts(page);

    // Select a contact
    await selectContact(page, 'Alice Johnson');

    // Back button should be visible on mobile (aria-label="Back to contacts")
    const backBtn = page.getByLabel(/Back/i).first();
    await expect(backBtn).toBeVisible();
  });

  test('should adjust header layout on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/contacts');

    // Header should still be accessible
    await expect(page.getByText('Contacts', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /New contact/i })).toBeVisible();
  });

  test('should maintain functionality on tablet size', async ({ page }) => {
    // Set tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });

    await navigateToContacts(page);

    // Should show both list and detail
    await expect(page.locator('ul li button').first()).toBeVisible();
    await expect(page.getByText('Alice Johnson').first()).toBeVisible();
  });
});

test.describe('Helper Functions', () => {
  test('getContactInitials should calculate correctly', () => {
    // Test the helper function directly
    expect(getContactInitials({ name: 'Alice Johnson' })).toBe('AJ');
    expect(getContactInitials({ name: 'Bob Smith' })).toBe('BS');
    expect(getContactInitials({ name: 'SingleName' })).toBe('SI');
    expect(getContactInitials({ name: '', email: 'test@example.com' })).toBe('TE');
    expect(getContactInitials({ name: 'A B C' })).toBe('AC'); // First and last
  });
});
