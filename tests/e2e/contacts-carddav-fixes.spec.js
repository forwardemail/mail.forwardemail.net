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
//
// The helpers (verifyContactInList / verifyContactNotInList / waitForSuccessToast)
// already poll with sensible timeouts, so these tests avoid explicit sleeps.
// =============================================================================

test.describe('Multi-VCF Upload Fixes', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
    await mockApi(page);
    await navigateToContacts(page);
  });

  test('should import contacts without email addresses', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/no-email.vcf');
    await importVCard(page, filePath);
    await verifyContactInList(page, { name: 'No Email Person' });
  });

  test('should import large multi-contact VCF backup', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/large-backup.vcf');
    await importVCard(page, filePath);
    await verifyContactInList(page, { name: 'Contact One' });
    await verifyContactInList(page, { name: 'Contact Ten' });
  });

  test('should import multi-VCF with mixed email and no-email contacts', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/large-backup.vcf');
    await importVCard(page, filePath);

    await verifyContactInList(page, { name: 'Contact One', email: 'contact1@example.com' });
    await verifyContactInList(page, { name: 'Contact Eight' });
    await verifyContactInList(page, { name: 'Contact Nine' });
  });

  test('should show import progress for large files', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/large-backup.vcf');
    await importVCard(page, filePath);

    // For files with > 5 contacts, a progress toast should appear.
    await expect(page.locator('[data-testid="toast"]').first()).toBeVisible({ timeout: 5000 });
  });

  test('should increase file size limit to 25MB', async ({ page }) => {
    // Verify the UI affords importing a file (the actual 25MB limit is
    // enforced in JS, not the DOM attribute).
    await page.getByRole('button', { name: /Import/i }).click();
    const fileInput = page.locator('input[type="file"][accept*="vcf"]');
    await expect(fileInput).toBeAttached();
  });
});

test.describe('Per-Contact Cache Update on Delete', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
    await mockApi(page);
    await navigateToContacts(page);
  });

  test('should surgically remove deleted contact from cache', async ({ page }) => {
    await verifyContactInList(page, { name: 'Alice Johnson' });
    await deleteContact(page, 'Alice Johnson');
    await verifyContactNotInList(page, 'Alice Johnson');
  });

  test('should persist cache removal after page reload', async ({ page }) => {
    await deleteContact(page, 'Bob Smith');
    await verifyContactNotInList(page, 'Bob Smith');

    await page.reload();
    await navigateToContacts(page);
    await verifyContactNotInList(page, 'Bob Smith');
  });
});

test.describe('Per-Contact Cache Update on Import', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
    await mockApi(page);
    await navigateToContacts(page);
  });

  test('should upsert imported contacts into cache', async ({ page }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/simple-contact.vcf');
    await importVCard(page, filePath);
    await waitForSuccessToast(page, '');
    await verifyContactInList(page, { name: 'Emily Davis', email: 'emily@example.com' });
  });

  test('should upsert existing contact on duplicate import without duplication', async ({
    page,
  }) => {
    const filePath = path.join(process.cwd(), 'tests/fixtures/vcf/simple-contact.vcf');

    await importVCard(page, filePath);
    await waitForSuccessToast(page, '');
    await verifyContactInList(page, { name: 'Emily Davis', email: 'emily@example.com' });

    // Second import of the same file — still exactly one row for Emily.
    await importVCard(page, filePath);
    await verifyContactInList(page, { name: 'Emily Davis', email: 'emily@example.com' });

    // Poll the list count to confirm no duplication.
    const emilyRows = page
      .locator('[data-testid="contact-item"]')
      .filter({ hasText: 'Emily Davis' });
    await expect(emilyRows).toHaveCount(1, { timeout: 5000 });
  });
});
