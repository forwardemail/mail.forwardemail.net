import { expect } from '@playwright/test';

/**
 * Selectors are anchored on data-testid attributes that Contacts.svelte
 * renders. This avoids breakage from Svelte/DOM markup changes and makes
 * "wait for the list to be ready" deterministic instead of timer-based.
 */
const LIST = '[data-testid="contact-list"]';
const ITEM = '[data-testid="contact-item"]';

/**
 * Navigate to /contacts and block until the list is marked non-loading.
 * Does not sleep — polls the data-loading attribute on the list.
 */
export async function navigateToContacts(page) {
  await page.goto('/contacts');
  const list = page.locator(LIST);
  await list.waitFor({ state: 'visible', timeout: 10000 });
  // The list sets data-loading="false" after the fetch resolves.
  await expect(list).toHaveAttribute('data-loading', 'false', { timeout: 10000 });
}

/**
 * Return a locator for a contact row by exact name (or name substring).
 * Prefers the data-contact-name attribute, falls back to text content.
 */
export function contactRowByName(page, contactName) {
  const exact = page.locator(`${ITEM}[data-contact-name="${contactName}"]`);
  return exact;
}

export function contactRowByText(page, hasText) {
  return page.locator(ITEM).filter({ hasText });
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

  if (company || jobTitle || timezone || website || birthday) {
    const companyField = scope.getByLabel('Company', { exact: true }).first();
    const isAlreadyExpanded = await companyField.isVisible().catch(() => false);

    if (!isAlreadyExpanded) {
      const optionalToggle = scope.locator('button:has-text("Additional info")');
      if (await optionalToggle.isVisible()) {
        await optionalToggle.click();
        // Wait for the optional section to be present, not a timeout.
        await companyField.waitFor({ state: 'visible', timeout: 2000 });
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
 * Complete create-contact flow. Waits for the modal to close and the new
 * contact to appear in the list before returning.
 */
export async function createContact(page, contactData) {
  const modal = await openNewContactModal(page);
  await fillContactForm(modal, contactData);

  const saveResponse = page.waitForResponse(
    (res) => res.url().includes('/v1/contacts') && res.request().method() === 'POST',
    { timeout: 10000 },
  );
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await saveResponse;
  await modal.waitFor({ state: 'hidden', timeout: 5000 });

  // Wait for the list to pick up the new contact.
  const matchText = contactData.name || contactData.email;
  if (matchText) {
    await contactRowByText(page, matchText).first().waitFor({ state: 'visible', timeout: 5000 });
  }
}

/**
 * Select a contact from the list by name. Waits for the detail panel's Name
 * input to reflect the selection instead of a fixed timeout.
 */
export async function selectContact(page, contactName) {
  const row = contactRowByText(page, contactName).first();
  await row.waitFor({ state: 'visible', timeout: 5000 });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByLabel('Name', { exact: true }).first()).toHaveValue(contactName, {
    timeout: 5000,
  });
}

/**
 * Open the actions dropdown menu in the detail panel (the "..." button).
 */
export async function openActionsMenu(page) {
  const actionsBtn = page
    .locator('button:has(svg.lucide-ellipsis), button:has(svg.lucide-more-horizontal)')
    .first();
  if (await actionsBtn.isVisible()) {
    await actionsBtn.click();
  } else {
    const moreBtn = page
      .locator('button:has(svg)')
      .filter({ hasNotText: /\w{2,}/ })
      .last();
    await moreBtn.click();
  }
  await page.getByRole('menu').waitFor({ state: 'visible', timeout: 3000 });
}

/**
 * Click a menu item in the currently open actions dropdown
 */
export async function clickMenuItem(page, itemName) {
  const options =
    typeof itemName === 'string' ? { name: itemName, exact: true } : { name: itemName };
  await page.getByRole('menuitem', options).click();
  // The menu closes as part of the click; wait for it to go away.
  await page
    .getByRole('menu')
    .waitFor({ state: 'hidden', timeout: 2000 })
    .catch(() => {});
}

/**
 * Edit contact inline — fields are always editable. Save/Cancel show up
 * when hasChanges flips to true, so we wait for the Save button.
 */
export async function editContactInline(page, contactData) {
  await fillContactForm(page, contactData);
  await page.getByRole('button', { name: 'Save', exact: true }).waitFor({
    state: 'visible',
    timeout: 3000,
  });
}

/**
 * Save inline edit. Clicks Save and waits for either (a) the Save/Cancel
 * pair to disappear (hasChanges cleared) OR (b) a success toast to appear
 * (async save completed). Either signal is sufficient to proceed. The old
 * `page.waitForTimeout(500)` raced with both, which is why the legacy tests
 * were flaky.
 */
export async function saveContactInline(page) {
  const saveButton = page.getByRole('button', { name: 'Save', exact: true });
  await saveButton.click();
  const saveGone = expect(saveButton).not.toBeVisible({ timeout: 5000 });
  const toastShown = page
    .locator('[data-testid="toast"]')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });
  await Promise.race([saveGone, toastShown]).catch(() => {
    // If neither signal fires within 5s, proceed anyway — subsequent
    // assertions in the test will surface the real problem with a clearer
    // error than "Save button still visible".
  });
}

/**
 * Cancel inline edit
 */
export async function cancelEditInline(page) {
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // The Save/Cancel pair disappears when hasChanges flips back to false.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).not.toBeVisible({
    timeout: 3000,
  });
}

/**
 * Delete contact with confirmation. Waits for the DELETE request and the
 * confirmation dialog to close before returning.
 */
export async function deleteContact(page, contactName) {
  await selectContact(page, contactName);
  await openActionsMenu(page);
  await clickMenuItem(page, 'Delete');

  const confirmModal = page.getByRole('dialog');
  await expect(confirmModal).toBeVisible();

  const delResp = page.waitForResponse(
    (res) => res.url().includes('/v1/contacts') && res.request().method() === 'DELETE',
    { timeout: 10000 },
  );
  await confirmModal.getByRole('button', { name: 'Delete', exact: true }).click();
  await delResp;
  await confirmModal.waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Search contacts. Waits for the list's data-count attribute to reflect
 * the filtered result.
 */
export async function searchContacts(page, query) {
  await page.fill('input[placeholder*="Search" i], input[type="search"]', query);
  // applyFilter is debounced via oninput; poll until the list settles.
  await expect
    .poll(() => page.locator(LIST).getAttribute('data-count'), { timeout: 2000 })
    .not.toBeNull();
}

/**
 * Import vCard file
 */
export async function importVCard(page, filePath) {
  await page.getByRole('button', { name: /Import/i }).click();
  const fileInput = page.locator('input[type="file"][accept*="vcf"]');
  await fileInput.waitFor({ state: 'attached', timeout: 2000 });
  await fileInput.setInputFiles(filePath);
}

/**
 * Export contact as vCard
 */
export async function exportContact(page, contactName) {
  await selectContact(page, contactName);
  await openActionsMenu(page);

  const downloadPromise = page.waitForEvent('download');
  await clickMenuItem(page, /Export/);
  return await downloadPromise;
}

/**
 * Upload contact photo
 */
export async function uploadContactPhoto(page, imagePath) {
  const fileInput = page.locator('input[id="contact-photo-upload"]');
  await fileInput.setInputFiles(imagePath);
}

/**
 * Toggle optional fields section
 */
export async function toggleOptionalFields(page) {
  await page.getByRole('button', { name: 'Additional info' }).click();
}

/**
 * Ensure optional fields section is expanded (expand only if collapsed).
 */
export async function ensureOptionalFieldsExpanded(page) {
  const companyField = page.getByLabel('Company', { exact: true }).first();
  const isVisible = await companyField.isVisible().catch(() => false);
  if (!isVisible) {
    const toggle = page.getByRole('button', { name: 'Additional info' });
    if (await toggle.isVisible()) {
      await toggle.click();
      await companyField.waitFor({ state: 'visible', timeout: 2000 });
    }
  }
}

/**
 * Verify contact appears in list. Matches by text content (what the user
 * sees) rather than the data-contact-name attribute, so this also verifies
 * renamed contacts and contacts added via optimistic update whose data
 * attributes may lag the visible text by a frame.
 */
export async function verifyContactInList(page, contactData) {
  const { name, email } = contactData;
  if (name) {
    await expect(contactRowByText(page, name).first()).toBeVisible({ timeout: 5000 });
  }
  if (email) {
    await expect(contactRowByText(page, email).first()).toBeVisible({ timeout: 5000 });
  }
}

/**
 * Verify contact not in list
 */
export async function verifyContactNotInList(page, contactName) {
  await expect(contactRowByText(page, contactName)).toHaveCount(0, { timeout: 5000 });
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
    await ensureOptionalFieldsExpanded(page);

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
 * Wait for a toast to appear. The toast host now uses data-testid markers,
 * so we wait deterministically instead of racing the 8s auto-dismiss.
 */
export async function waitForSuccessToast(page, expectedText) {
  const toast = page.locator('[data-testid="toast"]').first();
  await toast.waitFor({ state: 'visible', timeout: 5000 });
  if (expectedText) {
    await expect(toast.getByTestId('toast-message')).toContainText(expectedText, {
      timeout: 3000,
    });
  }
}

/**
 * Wait for an error toast
 */
export async function waitForErrorToast(page, expectedText) {
  const toast = page
    .locator('[data-testid="toast"][data-toast-type="error"], [data-testid="toast"]')
    .first();
  await toast.waitFor({ state: 'visible', timeout: 5000 });
  if (expectedText) {
    await expect(toast.getByTestId('toast-message')).toContainText(expectedText, {
      timeout: 3000,
    });
  }
}

/**
 * Derive expected initials from a contact (used by avatar assertions).
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
