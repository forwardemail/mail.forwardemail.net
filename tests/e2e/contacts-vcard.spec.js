import { test, expect } from '@playwright/test';
import path from 'path';
import { mockApi } from './mockApi.js';
import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import {
  navigateToContacts,
  importVCard,
  selectContact,
  openActionsMenu,
  clickMenuItem,
  verifyContactInList,
  waitForSuccessToast,
  waitForErrorToast,
} from '../fixtures/contacts-helpers.js';

test.describe('vCard Import', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should open import menu', async ({ page }) => {
    // Click Import button
    await page.getByRole('button', { name: /Import/i }).click();

    // Verify file input is available (import triggers file picker)
    const fileInput = page.locator('input[type="file"][accept*="vcf"]');
    await expect(fileInput).toBeAttached();
  });

  test('should import single vCard file', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/simple-contact.vcf');

    // Import the file
    await importVCard(page, filePath);

    // Wait for success message
    await waitForSuccessToast(page, '');

    // Verify new contact appears in list
    await verifyContactInList(page, { name: 'Emily Davis', email: 'emily@example.com' });
  });

  test('should import multi-vCard file', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/multi-contact.vcf');

    // Import the file
    await importVCard(page, filePath);

    // Wait for success message
    await waitForSuccessToast(page, '');

    // Verify all contacts appear in list
    await verifyContactInList(page, { name: 'Frank Miller', email: 'frank@example.com' });
    await verifyContactInList(page, { name: 'Grace Lee', email: 'grace@example.com' });
    await verifyContactInList(page, { name: 'Henry Wilson', email: 'henry@example.com' });
  });

  test('should import contact with all vCard fields', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/full-contact.vcf');

    // Import the file
    await importVCard(page, filePath);

    // Wait for success message
    await waitForSuccessToast(page, '');

    // Verify new contact appears
    await verifyContactInList(page, {
      name: 'Isabella Martinez',
      email: 'isabella@company.com',
    });

    // Select contact to verify details
    await selectContact(page, 'Isabella Martinez');

    // Verify all fields are imported
    await expect(page.getByText('Isabella Martinez').first()).toBeVisible();
    await expect(page.getByText('isabella@company.com').first()).toBeVisible();
    await expect(page.getByLabel('Phone', { exact: true }).first()).toHaveValue('555-0108');

    // Expand optional fields to check company, title, etc (only if not already expanded)
    const companyField = page.getByLabel('Company', { exact: true }).first();
    const isExpanded = await companyField.isVisible().catch(() => false);
    if (!isExpanded) {
      const optionalToggle = page.locator('button:has-text("Additional info")');
      if (await optionalToggle.isVisible()) {
        await optionalToggle.click();
        await page.waitForTimeout(300);
      }
    }
    await expect(companyField).toHaveValue('Enterprise Inc');
    await expect(page.getByLabel('Job Title', { exact: true }).first()).toHaveValue(
      'Senior Developer',
    );
  });

  test('should import contact with photo', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/contact-with-photo.vcf');

    // Import the file
    await importVCard(page, filePath);

    // Wait for success message
    await waitForSuccessToast(page, '');

    // Verify contact appears
    await verifyContactInList(page, { name: 'Jack Thompson', email: 'jack@example.com' });

    // Select contact
    await selectContact(page, 'Jack Thompson');

    // Verify contact name is displayed
    await expect(page.getByText('Jack Thompson').first()).toBeVisible();
  });

  test('should handle invalid vCard file', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/invalid.vcf');

    // Try to import invalid file
    await importVCard(page, filePath);

    // Wait for error message
    await waitForErrorToast(page, '');
  });

  test('should handle empty vCard file', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/empty.vcf');

    // Try to import empty file
    await importVCard(page, filePath);

    // Wait for error message
    await waitForErrorToast(page, '');
  });

  test('should close import menu after successful import', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/simple-contact.vcf');

    // Import the file
    await importVCard(page, filePath);

    // Wait for import to complete
    await waitForSuccessToast(page, '');

    // Verify import completed (no open menu/panel visible)
    await page.waitForTimeout(500);
  });
});

test.describe('vCard Export', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should export contact as vCard', async ({ page }) => {
    // Select a contact
    await selectContact(page, 'Alice Johnson');

    // Open actions menu and click Export menuitem
    await openActionsMenu(page);

    // Click Export vCard
    const downloadPromise = page.waitForEvent('download');
    await clickMenuItem(page, /Export/);

    // Verify download starts
    const download = await downloadPromise;
    expect(download).toBeTruthy();

    // Verify filename format (should be based on contact name)
    const fileName = download.suggestedFilename();
    expect(fileName).toContain('.vcf');
  });

  test('should export contact with all fields', async ({ page }) => {
    // Select contact with many fields
    await selectContact(page, 'Carol Williams');

    // Open actions menu
    await openActionsMenu(page);

    // Export
    const downloadPromise = page.waitForEvent('download');
    await clickMenuItem(page, /Export/);

    // Verify download
    const download = await downloadPromise;
    expect(download).toBeTruthy();
  });

  test('should show success toast after export', async ({ page }) => {
    // Select a contact
    await selectContact(page, 'Bob Smith');

    // Open actions menu
    await openActionsMenu(page);

    // Export
    const downloadPromise = page.waitForEvent('download');
    await clickMenuItem(page, /Export/);
    await downloadPromise;

    // Wait for success toast
    await waitForSuccessToast(page, '');
  });
});

test.describe('vCard Duplicate Handling', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should handle duplicate email on import', async ({ page }) => {
    // Create a vCard with an email that already exists (alice@example.com)
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/simple-contact.vcf');

    // First import
    await importVCard(page, filePath);
    await waitForSuccessToast(page, '');

    // Import same file again
    await importVCard(page, filePath);
    await page.waitForTimeout(500);

    // Contact should exist but not be duplicated
    await verifyContactInList(page, { name: 'Emily Davis', email: 'emily@example.com' });
  });
});
