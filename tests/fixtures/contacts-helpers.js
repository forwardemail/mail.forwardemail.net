import { expect } from '@playwright/test';

/**
 * Navigate to contacts and wait for it to load
 */
export async function navigateToContacts(page) {
  await page.goto('/contacts');
  // Wait for the contact list to render (li buttons inside the sidebar)
  await page.waitForSelector('ul li button', { timeout: 10000 });
  await page.waitForTimeout(500);
}

/**
 * Open new contact modal
 */
export async function openNewContactModal(page) {
  await page.getByRole('button', { name: /New contact/i }).click();
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  return modal;
}

/**
 * Fill contact form with provided data.
 * Works for both the new contact dialog and the inline detail panel.
 * @param {import('@playwright/test').Page | import('@playwright/test').Locator} scope - page or dialog locator
 * @param {object} contactData - fields to fill
 */
export async function fillContactForm(scope, contactData) {
  const { name, email, phone, notes, company, jobTitle, timezone, website, birthday } = contactData;

  if (name !== undefined) {
    await scope.getByLabel('Name', { exact: true }).first().fill(name);
  }

  if (email !== undefined) {
    await scope.getByLabel('Email', { exact: true }).first().fill(email);
  }

  if (phone !== undefined) {
    await scope.getByLabel('Phone', { exact: true }).first().fill(phone);
  }

  if (notes !== undefined) {
    await scope.getByLabel('Notes', { exact: true }).first().fill(notes);
  }

  // Handle optional fields (only available in the inline detail panel, not the new-contact modal)
  if (company || jobTitle || timezone || website || birthday) {
    // Check if optional fields are already visible; if not, expand the toggle.
    // The section auto-expands when a contact already has optional data,
    // so we must avoid clicking the toggle when it would collapse the section.
    const companyField = scope.getByLabel('Company', { exact: true }).first();
    const isAlreadyExpanded = await companyField.isVisible().catch(() => false);

    if (!isAlreadyExpanded) {
      const optionalToggle = scope.locator('button:has-text("Additional info")');
      if (await optionalToggle.isVisible()) {
        await optionalToggle.click();
        (await scope.page?.waitForTimeout?.(300)) || (await new Promise((r) => setTimeout(r, 300)));
      }
    }

    if (company !== undefined) {
      await companyField.fill(company);
    }

    if (jobTitle !== undefined) {
      await scope.getByLabel('Job Title', { exact: true }).first().fill(jobTitle);
    }

    if (timezone !== undefined) {
      await scope.getByLabel('Time Zone', { exact: true }).first().fill(timezone);
    }

    if (website !== undefined) {
      await scope.getByLabel('Website', { exact: true }).first().fill(website);
    }

    if (birthday !== undefined) {
      await scope.getByLabel('Birthday', { exact: true }).first().fill(birthday);
    }
  }
}

/**
 * Complete create contact flow
 */
export async function createContact(page, contactData) {
  const modal = await openNewContactModal(page);
  await fillContactForm(modal, contactData);
  await modal.locator('button:has-text("Save")').click();
  await page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: 5000 });
}

/**
 * Select a contact from the list by name
 */
export async function selectContact(page, contactName) {
  const contactRow = page.locator('li button').filter({ hasText: contactName });
  await contactRow.click();
  await page.waitForTimeout(300);
}

/**
 * Open actions dropdown menu in detail panel (the "..." button).
 * The menu items use role="menuitem", not button.
 */
export async function openActionsMenu(page) {
  // The actions button is a DropdownMenu.Trigger with a MoreHorizontal icon (no text).
  // It renders as a button with an SVG child and no visible text.
  const actionsBtn = page
    .locator('button:has(svg.lucide-ellipsis), button:has(svg.lucide-more-horizontal)')
    .first();
  if (await actionsBtn.isVisible()) {
    await actionsBtn.click();
  } else {
    // Fallback: find icon-only button (button with SVG and no meaningful text)
    const moreBtn = page
      .locator('button:has(svg)')
      .filter({ hasNotText: /\w{2,}/ })
      .last();
    await moreBtn.click();
  }
  // Wait for menu to appear
  await page.waitForSelector('[role="menu"]', { timeout: 3000 });
  await page.waitForTimeout(200);
}

/**
 * Click a menu item in the currently open actions dropdown
 */
export async function clickMenuItem(page, itemName) {
  // Use exact matching for strings to avoid substring matches (e.g. "Email" vs "View emails")
  const options =
    typeof itemName === 'string' ? { name: itemName, exact: true } : { name: itemName };
  await page.getByRole('menuitem', options).click();
  await page.waitForTimeout(300);
}

/**
 * Edit contact inline - fields are always editable, just fill them.
 * Save/Cancel buttons appear automatically when changes are detected.
 */
export async function editContactInline(page, contactData) {
  await fillContactForm(page, contactData);
  // Wait for hasChanges to be detected and Save/Cancel to appear
  await page.waitForTimeout(300);
}

/**
 * Save inline edit
 */
export async function saveContactInline(page) {
  await page.click('button:has-text("Save")');
  await page.waitForTimeout(500);
}

/**
 * Cancel inline edit
 */
export async function cancelEditInline(page) {
  await page.click('button:has-text("Cancel")');
  await page.waitForTimeout(300);
}

/**
 * Delete contact with confirmation
 */
export async function deleteContact(page, contactName) {
  await selectContact(page, contactName);
  await openActionsMenu(page);
  await clickMenuItem(page, 'Delete');
  const confirmModal = page.getByRole('dialog');
  await expect(confirmModal).toBeVisible();
  await confirmModal.locator('button:has-text("Delete")').click();
  await page.waitForTimeout(500);
}

/**
 * Search contacts
 */
export async function searchContacts(page, query) {
  await page.fill('input[placeholder*="Search" i], input[type="search"]', query);
  await page.waitForTimeout(300);
}

/**
 * Import vCard file
 */
export async function importVCard(page, filePath) {
  await page.getByRole('button', { name: /Import/i }).click();
  await page.waitForTimeout(200);
  const fileInput = page.locator('input[type="file"][accept*="vcf"]');
  await fileInput.setInputFiles(filePath);
  await page.waitForTimeout(500);
}

/**
 * Export contact as vCard
 */
export async function exportContact(page, contactName) {
  await selectContact(page, contactName);
  await openActionsMenu(page);

  const downloadPromise = page.waitForEvent('download');
  await clickMenuItem(page, /Export/);
  const download = await downloadPromise;

  return download;
}

/**
 * Upload contact photo
 */
export async function uploadContactPhoto(page, imagePath) {
  const fileInput = page.locator('input[id="contact-photo-upload"]');
  await fileInput.setInputFiles(imagePath);
  await page.waitForTimeout(500);
}

/**
 * Toggle optional fields section
 */
export async function toggleOptionalFields(page) {
  await page.click('button:has-text("Additional info")');
  await page.waitForTimeout(300);
}

/**
 * Ensure optional fields section is expanded (expand only if collapsed).
 * The section auto-expands when a contact has optional data, so this
 * avoids accidentally collapsing it.
 */
export async function ensureOptionalFieldsExpanded(page) {
  const companyField = page.getByLabel('Company', { exact: true }).first();
  const isVisible = await companyField.isVisible().catch(() => false);
  if (!isVisible) {
    const toggle = page.locator('button:has-text("Additional info")');
    if (await toggle.isVisible()) {
      await toggle.click();
      await page.waitForTimeout(300);
    }
  }
}

/**
 * Verify contact appears in list
 */
export async function verifyContactInList(page, contactData) {
  const { name, email } = contactData;
  if (name) {
    await expect(page.locator('li button').filter({ hasText: name }).first()).toBeVisible();
  }
  if (email) {
    await expect(page.locator('li button').filter({ hasText: email }).first()).toBeVisible();
  }
}

/**
 * Verify contact not in list
 */
export async function verifyContactNotInList(page, contactName) {
  await expect(page.locator('li button').filter({ hasText: contactName })).not.toBeVisible();
}

/**
 * Verify contact details in detail panel
 */
export async function verifyContactDetails(page, contactData) {
  const { name, email, phone, notes, company, jobTitle } = contactData;

  if (name) {
    await expect(page.getByText(name).first()).toBeVisible();
  }

  if (email) {
    await expect(page.getByText(email).first()).toBeVisible();
  }

  if (phone) {
    await expect(page.getByText(phone).first()).toBeVisible();
  }

  if (notes) {
    await expect(page.getByText(notes).first()).toBeVisible();
  }

  if (company || jobTitle) {
    const optionalToggle = page.locator('button:has-text("Additional info")');
    if (await optionalToggle.isVisible()) {
      await optionalToggle.click();
      await page.waitForTimeout(300);
    }

    if (company) {
      await expect(page.getByText(company).first()).toBeVisible();
    }

    if (jobTitle) {
      await expect(page.getByText(jobTitle).first()).toBeVisible();
    }
  }
}

/**
 * Click Email action from dropdown menu
 */
export async function clickEmailAction(page) {
  await openActionsMenu(page);
  await clickMenuItem(page, 'Email');
}

/**
 * Click Add Event action from dropdown menu
 */
export async function clickAddEventAction(page) {
  await openActionsMenu(page);
  await clickMenuItem(page, 'Add event');
}

/**
 * Click View Emails action from dropdown menu
 */
export async function clickViewEmailsAction(page) {
  await openActionsMenu(page);
  await clickMenuItem(page, 'View emails');
}

/**
 * Wait for success toast
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
export async function waitForErrorToast(page, expectedText) {
  const errorLocator = page.locator('[aria-live="polite"] div, div[role="alert"]');
  if (expectedText) {
    await expect(errorLocator.filter({ hasText: expectedText }).first()).toBeVisible({
      timeout: 5000,
    });
  } else {
    await expect(errorLocator.first()).toBeVisible({ timeout: 5000 });
  }
}

/**
 * Get expected initials from contact
 */
export function getContactInitials(contact) {
  const name = contact.name || contact.full_name || '';
  const email = contact.email || (contact.emails && contact.emails[0]?.value) || '';

  if (name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  }

  if (email) {
    const localPart = email.split('@')[0];
    return localPart.substring(0, 2).toUpperCase();
  }

  return '??';
}
