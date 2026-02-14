import { test, expect } from '@playwright/test';
import { mockApi } from './mockApi.js';
import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import {
  navigateToContacts,
  openNewContactModal,
  fillContactForm,
  selectContact,
  editContactInline,
  saveContactInline,
  cancelEditInline,
  ensureOptionalFieldsExpanded,
  openActionsMenu,
  clickMenuItem,
  verifyContactInList,
  verifyContactNotInList,
  waitForSuccessToast,
} from '../fixtures/contacts-helpers.js';

test.describe('Contact Creation - Modal', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should open new contact modal on button click', async ({ page }) => {
    await openNewContactModal(page);

    // Verify modal is visible
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    // Verify title
    await expect(modal.getByText(/New contact/i)).toBeVisible();
  });

  test('should create contact with required fields only', async ({ page }) => {
    const modal = await openNewContactModal(page);

    // Fill required fields within the dialog scope
    await fillContactForm(modal, {
      name: 'Test User',
      email: 'test@example.com',
    });

    // Save
    await modal.locator('button:has-text("Save")').click();

    // Wait for modal to close
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // Wait for success toast
    await waitForSuccessToast(page, '');

    // Verify contact appears in list
    await verifyContactInList(page, { name: 'Test User', email: 'test@example.com' });
  });

  test('should create contact with all fields', async ({ page }) => {
    // Modal only supports basic fields (name, email, phone, notes)
    const modal = await openNewContactModal(page);

    await fillContactForm(modal, {
      name: 'Complete User',
      email: 'complete@example.com',
      phone: '555-9876',
      notes: 'Test contact with all fields',
    });

    // Save
    await modal.locator('button:has-text("Save")').click();

    // Wait for modal to close
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // Verify contact appears in list
    await verifyContactInList(page, { name: 'Complete User', email: 'complete@example.com' });

    // Select the new contact and add optional fields via inline edit
    await selectContact(page, 'Complete User');

    await editContactInline(page, {
      company: 'Test Corp',
      jobTitle: 'Tester',
      timezone: 'America/Chicago',
      website: 'https://test.com',
      birthday: '1990-05-15',
    });

    await saveContactInline(page);

    // Verify detail panel shows the info
    await expect(page.getByText('Complete User').first()).toBeVisible();
    await expect(page.getByText('complete@example.com').first()).toBeVisible();
  });

  test('should validate email is required', async ({ page }) => {
    const modal = await openNewContactModal(page);

    // Fill name but leave email empty
    await fillContactForm(modal, {
      name: 'No Email User',
      email: '',
    });

    // Try to save
    await modal.locator('button:has-text("Save")').click();

    // Modal should stay open
    await page.waitForTimeout(500);
    await expect(modal).toBeVisible();
  });

  test('should cancel contact creation', async ({ page }) => {
    const modal = await openNewContactModal(page);

    // Fill some fields
    await fillContactForm(modal, {
      name: 'Cancelled User',
      email: 'cancelled@example.com',
    });

    // Click Cancel
    await modal.locator('button:has-text("Cancel")').click();

    // Modal should close
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // Contact should not be created
    await verifyContactNotInList(page, 'Cancelled User');
  });

  test('should close modal on Escape key', async ({ page }) => {
    await openNewContactModal(page);

    // Press Escape
    await page.keyboard.press('Escape');

    // Modal should close
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });
  });
});

test.describe('Contact Update - Inline Editing', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should enable inline editing mode', async ({ page }) => {
    // Select a contact
    await selectContact(page, 'Alice Johnson');

    // Fields are always editable - modify a field and Save/Cancel should appear
    await editContactInline(page, { name: 'Alice Johnson Modified' });

    // Verify Save and Cancel buttons appear when changes are detected
    await expect(page.locator('button:has-text("Save")')).toBeVisible();
    await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
  });

  test('should update contact name', async ({ page }) => {
    await selectContact(page, 'Bob Smith');

    // Edit contact (fields are always editable)
    await editContactInline(page, {
      name: 'Robert Smith',
    });

    // Save
    await saveContactInline(page);

    // Verify name updated in list
    await verifyContactInList(page, { name: 'Robert Smith' });
  });

  test('should update contact email', async ({ page }) => {
    await selectContact(page, 'David Chen');

    // Edit email
    await editContactInline(page, {
      email: 'david.chen@startup.io',
    });

    // Save
    await saveContactInline(page);

    // Verify email updated
    await verifyContactInList(page, { email: 'david.chen@startup.io' });
  });

  test('should update contact phone', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');

    // Edit phone
    await editContactInline(page, {
      phone: '555-1111',
    });

    // Save
    await saveContactInline(page);

    // Select contact again to see details
    await selectContact(page, 'Alice Johnson');

    // Verify phone updated in detail panel (value is in a textbox input)
    await expect(page.getByLabel('Phone', { exact: true }).first()).toHaveValue('555-1111');
  });

  test('should update contact notes', async ({ page }) => {
    await selectContact(page, 'Bob Smith');

    // Edit notes
    await editContactInline(page, {
      notes: 'Updated notes for Bob',
    });

    // Save
    await saveContactInline(page);

    // Verify notes updated (value is in a textbox input)
    await selectContact(page, 'Bob Smith');
    await expect(page.getByLabel('Notes', { exact: true }).first()).toHaveValue(
      'Updated notes for Bob',
    );
  });

  test('should update optional fields', async ({ page }) => {
    await selectContact(page, 'Carol Williams');

    // Edit optional fields
    await editContactInline(page, {
      company: 'TechCorp International',
      jobTitle: 'Senior Engineering Lead',
      timezone: 'America/Los_Angeles',
    });

    // Save
    await saveContactInline(page);

    // Verify optional fields updated
    await selectContact(page, 'Carol Williams');

    // Ensure optional fields are visible (auto-expands when contact has data)
    await ensureOptionalFieldsExpanded(page);

    await expect(page.getByLabel('Company', { exact: true }).first()).toHaveValue(
      'TechCorp International',
    );
  });

  test('should cancel inline edit without saving', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');

    // Edit contact
    await editContactInline(page, {
      name: 'Changed Name',
    });

    // Cancel
    await cancelEditInline(page);

    // Verify name didn't change
    await expect(page.getByText('Alice Johnson').first()).toBeVisible();
    await expect(page.getByText('Changed Name')).not.toBeVisible();
  });

  test('should validate email on update', async ({ page }) => {
    // Use Alice Johnson (not renamed by earlier tests in this suite)
    await selectContact(page, 'Alice Johnson');

    // Try to clear email using the labeled input
    const emailInput = page.getByLabel('Email', { exact: true }).first();
    await emailInput.fill('');

    // Try to save
    await page.click('button:has-text("Save")');

    // Should stay in edit mode or show error
    await page.waitForTimeout(500);
    await expect(page.locator('button:has-text("Save")')).toBeVisible();
  });
});

test.describe('Contact Deletion', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('should open delete confirmation dialog', async ({ page }) => {
    await selectContact(page, 'David Chen');

    // Open actions menu and click Delete menuitem
    await openActionsMenu(page);
    await clickMenuItem(page, 'Delete');

    // Verify confirmation modal appears
    const confirmModal = page.getByRole('dialog');
    await expect(confirmModal).toBeVisible();

    // Should show contact name in confirmation
    await expect(confirmModal.getByText(/David Chen/)).toBeVisible();
  });

  test('should delete contact after confirmation', async ({ page }) => {
    await selectContact(page, 'David Chen');

    // Delete contact via menu
    await openActionsMenu(page);
    await clickMenuItem(page, 'Delete');

    // Confirm deletion (dialog buttons ARE button role)
    const confirmModal = page.getByRole('dialog');
    await confirmModal.locator('button:has-text("Delete")').click();

    // Wait for modal to close
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // Verify contact removed from list
    await verifyContactNotInList(page, 'David Chen');
  });

  test('should cancel deletion', async ({ page }) => {
    await selectContact(page, 'Bob Smith');

    // Open delete dialog
    await openActionsMenu(page);
    await clickMenuItem(page, 'Delete');

    // Click Cancel
    const confirmModal = page.getByRole('dialog');
    await confirmModal.locator('button:has-text("Cancel")').click();

    // Modal should close
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // Contact should still exist
    await verifyContactInList(page, { name: 'Bob Smith' });
  });

  test('should close delete dialog on Escape', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');

    // Open delete dialog
    await openActionsMenu(page);
    await clickMenuItem(page, 'Delete');

    // Press Escape
    await page.keyboard.press('Escape');

    // Modal should close
    await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });

    // Contact should still exist
    await verifyContactInList(page, { name: 'Alice Johnson' });
  });
});
