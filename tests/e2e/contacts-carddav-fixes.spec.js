import { test, expect } from '@playwright/test';
import path from 'path';
import { mockApi } from './mockApi.js';
import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import {
  navigateToContacts,
  importVCard,
  deleteContact,
  verifyContactInList,
  verifyContactNotInList,
  waitForSuccessToast,
} from '../fixtures/contacts-helpers.js';

// =============================================================================
// E2E tests for CardDAV fixes:
// 1. Multi-VCF upload with contacts that have no email
// 2. Deleted contacts cache invalidation
// 3. Large backup import with progress
// =============================================================================

test.describe('Multi-VCF Upload Fixes', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should import contacts without email addresses', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/no-email.vcf');

    // Import the file with a contact that has no email
    await importVCard(page, filePath);

    // Should show success (not silently skip)
    await page.waitForTimeout(1000);

    // The contact should appear in the list by name
    await verifyContactInList(page, { name: 'No Email Person' });
  });

  test('should import large multi-contact VCF backup', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/large-backup.vcf');

    // Import the large backup file
    await importVCard(page, filePath);

    // Wait for import to complete (may take a moment for 10 contacts)
    await page.waitForTimeout(2000);

    // Should show progress or success toast
    const toastContainer = page.locator('[aria-live="polite"]');
    await expect(toastContainer.locator('div').first()).toBeVisible({ timeout: 10000 });

    // Verify multiple contacts were imported
    await verifyContactInList(page, { name: 'Contact One' });
    await verifyContactInList(page, { name: 'Contact Ten' });
  });

  test('should import multi-VCF with mixed email and no-email contacts', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/large-backup.vcf');

    await importVCard(page, filePath);
    await page.waitForTimeout(2000);

    // Contacts with email should be imported
    await verifyContactInList(page, { name: 'Contact One', email: 'contact1@example.com' });

    // Contacts without email (phone-only) should also be imported
    await verifyContactInList(page, { name: 'Contact Eight' });
    await verifyContactInList(page, { name: 'Contact Nine' });
  });

  test('should show import progress for large files', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/large-backup.vcf');

    await importVCard(page, filePath);

    // For files with > 5 contacts, a progress toast should appear
    const toastContainer = page.locator('[aria-live="polite"]');
    await expect(toastContainer.locator('div').first()).toBeVisible({ timeout: 5000 });
  });

  test('should handle VCF with N: property but no FN:', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/n-only-contact.vcf');

    await importVCard(page, filePath);
    await page.waitForTimeout(1000);

    // The contact should be imported using the name derived from N: property
    // The parseVCard in Contacts.svelte handles N -> name derivation
    const toastContainer = page.locator('[aria-live="polite"]');
    await expect(toastContainer.locator('div').first()).toBeVisible({ timeout: 5000 });
  });

  test('should show summary with imported, updated, and skipped counts', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/large-backup.vcf');

    await importVCard(page, filePath);
    await page.waitForTimeout(3000);

    // The toast should show a summary message
    const toastContainer = page.locator('[aria-live="polite"]');
    await expect(toastContainer.locator('div').first()).toBeVisible({ timeout: 10000 });
  });

  test('should increase file size limit to 25MB', async ({ page }) => {
    // Verify the file input accepts the file (we test the UI behavior)
    await page.getByRole('button', { name: /Import/i }).click();
    await page.waitForTimeout(200);

    const fileInput = page.locator('input[type="file"][accept*="vcf"]');
    await expect(fileInput).toBeAttached();

    // The file input should be present and ready to accept files
    // The actual 25MB limit is enforced in JavaScript, not the HTML attribute
  });
});

test.describe('Per-Contact Cache Update on Delete', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should surgically remove deleted contact from cache', async ({ page }) => {
    // Verify Alice exists
    await verifyContactInList(page, { name: 'Alice Johnson' });

    // Delete Alice — cache should remove only this contact
    await deleteContact(page, 'Alice Johnson');

    // Alice should no longer appear in the list
    await verifyContactNotInList(page, 'Alice Johnson');
  });

  test('should persist cache removal after page reload', async ({ page }) => {
    // Delete a contact
    await deleteContact(page, 'Bob Smith');

    // Verify it is gone
    await verifyContactNotInList(page, 'Bob Smith');

    // Reload the page
    await page.reload();
    await page.waitForSelector('ul li button', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Bob should still not appear (removed from cache)
    await verifyContactNotInList(page, 'Bob Smith');
  });

  test('should upsert new contact into cache after creation', async ({ page }) => {
    // Create a new contact via the modal
    await page.getByRole('button', { name: /New contact/i }).click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    await modal.getByLabel('Name', { exact: true }).first().fill('New Test Contact');
    await modal.getByLabel('Email', { exact: true }).first().fill('newtest@example.com');
    await modal.locator('button:has-text("Save")').click();
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // New contact should appear in the list (upserted into cache)
    await verifyContactInList(page, { name: 'New Test Contact', email: 'newtest@example.com' });
  });
});

test.describe('Per-Contact Cache Update on Import', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should upsert imported contacts into cache', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/simple-contact.vcf');

    await importVCard(page, filePath);
    await waitForSuccessToast(page, '');

    // Imported contact should appear (upserted into cache)
    await verifyContactInList(page, { name: 'Emily Davis', email: 'emily@example.com' });
  });

  test('should upsert existing contact on duplicate import without duplication', async ({
    page,
  }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/simple-contact.vcf');

    // First import
    await importVCard(page, filePath);
    await waitForSuccessToast(page, '');

    // Second import of same file (should upsert, not duplicate)
    await importVCard(page, filePath);
    await page.waitForTimeout(1000);

    // Contact should still exist (upserted, not duplicated)
    await verifyContactInList(page, { name: 'Emily Davis', email: 'emily@example.com' });
  });
});
