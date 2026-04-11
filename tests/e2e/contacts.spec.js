import { test, expect } from '@playwright/test';
import { mockApi } from './mockApi.js';
import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import { navigateToContacts, searchContacts, selectContact } from '../fixtures/contacts-helpers.js';

const buildPaginatedContacts = (total) =>
  Array.from({ length: total }, (_, index) => {
    const id = String(index + 1).padStart(3, '0');
    return {
      id: `contact-${id}`,
      full_name: `Paged Contact ${id}`,
      emails: [{ value: `paged-${id}@example.com` }],
      phone_numbers: [],
      content: `BEGIN:VCARD\nVERSION:3.0\nFN:Paged Contact ${id}\nEMAIL;TYPE=INTERNET:paged-${id}@example.com\nEND:VCARD`,
    };
  });

test.describe('Contacts Page Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
  });

  test('should show contacts header with actions', async ({ page }) => {
    await navigateToContacts(page);
    await expect(page.getByText('Contacts', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /New contact/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Import/i })).toBeVisible();
    await expect(page.getByLabel('Back', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('4 contacts', { exact: true }).first()).toBeVisible();
  });

  test('should display contacts list', async ({ page }) => {
    await navigateToContacts(page);
    const contactRows = page.locator('ul li button');
    await expect(contactRows.first()).toBeVisible();
  });

  test('should show contact names and emails in list', async ({ page }) => {
    await navigateToContacts(page);

    // Verify mock contacts are displayed
    await expect(page.locator('li button').filter({ hasText: 'Alice Johnson' })).toBeVisible();
    await expect(page.locator('li button').filter({ hasText: 'alice@example.com' })).toBeVisible();
    await expect(page.locator('li button').filter({ hasText: 'Bob Smith' })).toBeVisible();
  });

  test('should select first contact by default', async ({ page }) => {
    await navigateToContacts(page);

    // First contact should be visible and detail panel should show contact info
    const firstContact = page.locator('li button').first();
    await expect(firstContact).toBeVisible();

    // Detail panel should show some contact info (name or email)
    await expect(page.getByText('Alice Johnson').first()).toBeVisible();
  });

  test('should display contact detail panel', async ({ page }) => {
    await navigateToContacts(page);

    // Detail panel should show contact info - look for name and initials
    await expect(page.getByText('Alice Johnson').first()).toBeVisible();
  });
});

test.describe('Contacts Search', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should search contacts by name', async ({ page }) => {
    await searchContacts(page, 'Alice');

    // Should show only Alice
    await expect(page.locator('li button').filter({ hasText: 'Alice Johnson' })).toBeVisible();

    // Should not show other contacts
    await expect(page.locator('li button').filter({ hasText: 'Bob Smith' })).toHaveCount(0);
  });

  test('should search contacts by email', async ({ page }) => {
    await searchContacts(page, 'techcorp.com');

    // Should show only contact with techcorp email
    await expect(page.locator('li button').filter({ hasText: 'carol@techcorp.com' })).toBeVisible();

    // Should not show example.com contacts
    await expect(page.locator('li button').filter({ hasText: 'alice@example.com' })).toHaveCount(0);
  });

  test('should search contacts by company', async ({ page }) => {
    await searchContacts(page, 'Acme');

    // Should show contact from Acme Corp
    await expect(page.locator('li button').filter({ hasText: 'Alice Johnson' })).toBeVisible();

    // Should not show contacts from other companies
    await expect(page.locator('li button').filter({ hasText: 'David Chen' })).toHaveCount(0);
  });

  test('should show no contacts found when no matches', async ({ page }) => {
    await searchContacts(page, 'NonExistentContact12345');

    // Should show empty state
    await expect(page.getByText('No contacts found')).toBeVisible();
  });

  test('should clear search and restore full list', async ({ page }) => {
    await searchContacts(page, 'Alice');
    await expect(page.locator('li button').filter({ hasText: 'Alice Johnson' })).toBeVisible();
    await expect(page.locator('li button').filter({ hasText: 'Bob Smith' })).toHaveCount(0);
    await expect(page.getByText('Showing 1 of 4 contacts', { exact: true })).toBeVisible();

    await searchContacts(page, '');

    await expect(page.locator('li button').filter({ hasText: 'Alice Johnson' })).toBeVisible();
    await expect(page.locator('li button').filter({ hasText: 'Bob Smith' })).toBeVisible();
    await expect(page.locator('li button').filter({ hasText: 'Carol Williams' })).toBeVisible();
    await expect(page.getByText('4 contacts', { exact: true }).first()).toBeVisible();
  });

  test('should preserve the contact count after reload', async ({ page }) => {
    await expect(page.getByText('4 contacts', { exact: true }).first()).toBeVisible();

    await page.reload();
    await navigateToContacts(page);

    await expect(page.getByText('4 contacts', { exact: true }).first()).toBeVisible();
    await expect(page.locator('li button')).toHaveCount(4);
  });

  test('should load every contacts page and show the full total', async ({ browser }) => {
    const page = await browser.newPage();
    await mockApi(page, { contacts: buildPaginatedContacts(754) });
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);

    await expect(page.getByText('754 contacts', { exact: true }).first()).toBeVisible();
    await expect(page.locator('li button').filter({ hasText: 'Paged Contact 754' })).toBeVisible();

    await page.close();
  });

  test('should refresh the total after a server-side contact addition event', async ({
    browser,
  }) => {
    const page = await browser.newPage();
    await mockApi(page, { contacts: buildPaginatedContacts(500) });
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);

    await expect(page.getByText('500 contacts', { exact: true }).first()).toBeVisible();

    await page.evaluate(async () => {
      await fetch('/v1/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          full_name: 'Server Added Contact',
          emails: [{ value: 'server-added@example.com' }],
          content:
            'BEGIN:VCARD\nVERSION:3.0\nFN:Server Added Contact\nEMAIL;TYPE=INTERNET:server-added@example.com\nEND:VCARD',
        }),
      });

      window.dispatchEvent(new CustomEvent('fe:contact-changed', { detail: { source: 'test' } }));
    });

    await expect(page.getByText('501 contacts', { exact: true }).first()).toBeVisible();
    await expect(
      page.locator('li button').filter({ hasText: 'Server Added Contact' }),
    ).toBeVisible();

    await page.close();
  });
});

test.describe('Contact Selection', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should select different contact on click', async ({ page }) => {
    // Click second contact
    await selectContact(page, 'Bob Smith');

    // Detail panel should show Bob's info (use nth to avoid strict mode)
    await expect(page.getByText('Bob Smith').nth(1)).toBeVisible();
  });

  test('should maintain selection across operations', async ({ page }) => {
    // Select a specific contact
    await selectContact(page, 'Carol Williams');

    // Detail panel should show Carol's info
    await expect(page.getByText('Carol Williams').nth(1)).toBeVisible();
  });

  test('should show contact avatar with initials', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');

    // Check for initials (AJ for Alice Johnson)
    await expect(page.getByText('AJ').first()).toBeVisible();
  });
});
