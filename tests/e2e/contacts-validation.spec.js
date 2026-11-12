import { expect, test } from '@playwright/test';

import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import {
  fillContactForm,
  navigateToContacts,
  openNewContactModal,
  selectContact,
} from '../fixtures/contacts-helpers.js';
import { mockApi } from './mockApi.js';

// A contact needs a name or an email address, and the address must be one.
// type="email" is only checked by the browser inside a <form>, so before
// this a contact with the address "jane" or with nothing at all was saved.

test.describe('contact validation', () => {
  let writes;

  test.beforeEach(async ({ page }) => {
    writes = [];
    await mockApi(page);
    await page.route('**/v1/contacts**', (route) => {
      if (['POST', 'PUT'].includes(route.request().method())) writes.push(route.request().method());
      return route.fallback();
    });
    await setupAuthenticatedSession(page);
    await navigateToContacts(page);
  });

  test('new contact: refuses an address that is not one, and an empty contact', async ({
    page,
  }) => {
    const modal = await openNewContactModal(page);
    await fillContactForm(modal, { name: 'Jane', email: 'jane' });
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal.getByText('Not an email address: jane')).toBeVisible();
    await expect(modal.getByLabel('Email', { exact: true }).first()).toBeFocused();

    await fillContactForm(modal, { name: '', email: '' });
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal.getByText('Add a name or an email address.')).toBeVisible();
    expect(writes).toEqual([]);

    // Fixed, it saves.
    await fillContactForm(modal, { name: 'Jane', email: 'jane@example.com' });
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal).toBeHidden();
    expect(writes).toEqual(['POST']);
  });

  test('editing a contact: refuses an address that is not one', async ({ page }) => {
    await selectContact(page, 'Alice Johnson');
    await fillContactForm(page, { email: 'not an address' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Not an email address: not an address')).toBeVisible();
    expect(writes).toEqual([]);
  });
});
