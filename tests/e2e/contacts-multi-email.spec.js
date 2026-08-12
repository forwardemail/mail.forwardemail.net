import { expect, test } from '@playwright/test';

import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import { navigateToContacts } from '../fixtures/contacts-helpers.js';
import { mockApi } from './mockApi.js';

const contacts = [
  {
    id: 'tino-kremer',
    full_name: 'Tino Kremer',
    emails: [
      { value: 'tino@tinokremer.nl', type: 'INTERNET' },
      { value: 'info@tinokremer.nl', type: 'WORK' },
      { value: 'family@tinokremer.nl', type: 'HOME' },
    ],
    content: [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:tino-kremer',
      'FN:Tino Kremer',
      'EMAIL;TYPE=INTERNET:tino@tinokremer.nl',
      'EMAIL;TYPE=WORK:info@tinokremer.nl',
      'EMAIL;TYPE=HOME:family@tinokremer.nl',
      'END:VCARD',
    ].join('\r\n'),
  },
];

test.describe('CardDAV contacts with multiple email addresses', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedSession(page);
    await mockApi(page, { contacts });
  });

  test('shows every address in the contact detail and searches secondary addresses', async ({
    page,
  }) => {
    await navigateToContacts(page);

    const tino = page.getByTestId('contact-item').filter({ hasText: 'Tino Kremer' });
    await expect(tino).toContainText('info@tinokremer.nl');
    await tino.click();

    await expect(page.getByTestId('contact-email-list')).toContainText('tino@tinokremer.nl');
    await expect(page.getByTestId('contact-email-list')).toContainText('info@tinokremer.nl');
    await expect(page.getByTestId('contact-email-list')).toContainText('family@tinokremer.nl');

    await page.getByPlaceholder('Search contacts').fill('family@tinokremer.nl');
    await expect(page.getByTestId('contact-item')).toHaveCount(1);
    await expect(page.getByTestId('contact-item')).toContainText('Tino Kremer');
  });

  test('suggests and selects a secondary CardDAV address while composing', async ({ page }) => {
    await page.goto('/mailbox');
    await page.getByRole('button', { name: 'Compose' }).first().click();

    const to = page.locator('input[placeholder="To"]');
    await expect(to).toBeVisible();
    await to.fill('info@tinokremer.nl');

    const suggestion = page
      .locator('.contact-suggestions')
      .getByRole('button', { name: /Tino Kremer.*info@tinokremer\.nl/i });
    await expect(suggestion).toBeVisible();
    await suggestion.click();

    await expect(page.locator('.contact-suggestions')).toHaveCount(0);
    await expect(
      page.getByTestId('compose-modal').getByText('info@tinokremer.nl', { exact: true }),
    ).toBeVisible();
  });
});
