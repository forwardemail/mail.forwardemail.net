import { test, expect } from '@playwright/test';
import { mockApi } from './mockApi.js';
import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import { navigateToContacts } from '../fixtures/contacts-helpers.js';

const row = (page, name) => page.getByTestId('contact-item').filter({ hasText: name });
const selectedName = (page) =>
  page.locator('[data-testid="contact-item"].border-l-primary').getAttribute('data-contact-name');

test.describe('Contact list menu and keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
    await expect(row(page, 'Alice Johnson')).toBeVisible();
  });

  test('right-click opens the contact actions for that contact', async ({ page }) => {
    await row(page, 'Bob Smith').click({ button: 'right' });
    const menu = page.getByTestId('contact-context-menu');
    await expect(menu).toBeVisible();
    for (const label of ['Email', 'Add event', 'View emails', 'Export vCard', 'Delete']) {
      await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible();
    }
    // Right-click does not change which contact is open.
    expect(await selectedName(page)).toBe('Alice Johnson');

    // Delete acts on the contact that was right-clicked.
    await menu.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(menu).toBeHidden();
    await expect(page.getByRole('dialog')).toContainText('Bob Smith');
  });

  test('Command-click opens the same menu', async ({ page }) => {
    await row(page, 'Bob Smith').click({ modifiers: ['Meta'] });
    await expect(page.getByTestId('contact-context-menu')).toBeVisible();
    expect(await selectedName(page)).toBe('Alice Johnson');
  });

  test('Escape and a click outside close the menu', async ({ page }) => {
    await row(page, 'Bob Smith').click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('contact-context-menu')).toBeHidden();

    await row(page, 'Bob Smith').click({ button: 'right' });
    await page.mouse.click(5, 5);
    await expect(page.getByTestId('contact-context-menu')).toBeHidden();
  });

  test('the arrow keys move the selection through the list', async ({ page }) => {
    const names = await page
      .getByTestId('contact-item')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-contact-name')));
    await row(page, names[0]).click();
    await page.keyboard.press('ArrowDown');
    expect(await selectedName(page)).toBe(names[1]);
    await page.keyboard.press('ArrowDown');
    expect(await selectedName(page)).toBe(names[2]);
    await page.keyboard.press('ArrowUp');
    expect(await selectedName(page)).toBe(names[1]);
    // The open contact follows.
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(names[1]);
  });

  test('the arrow keys leave the search field alone', async ({ page }) => {
    await row(page, 'Alice Johnson').click();
    await page.getByPlaceholder('Search contacts').click();
    await page.keyboard.press('ArrowDown');
    expect(await selectedName(page)).toBe('Alice Johnson');
  });

  test('the arrow keys do nothing to contacts once another page is showing', async ({ page }) => {
    await row(page, 'Alice Johnson').click();
    // Leave for the mailbox, then Settings, which has no arrow keys of its
    // own; Contacts stays mounted, hidden.
    await page.locator('[aria-label="Back"]:visible').first().click();
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('contact-list')).toBeHidden();
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.locator('[aria-label="Back"]:visible').first().click();
    await page.getByRole('button', { name: 'Contacts' }).first().click();
    await expect(row(page, 'Alice Johnson')).toBeVisible();
    expect(await selectedName(page)).toBe('Alice Johnson');
  });
});
