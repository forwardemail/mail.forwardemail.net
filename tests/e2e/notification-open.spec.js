import { expect, test } from '@playwright/test';
import { navigateToMailbox, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';

// Opening a notification (tapping a push, clicking a desktop or web
// notification) goes through the same in-app link the native side and the
// service worker produce. A tapped notification is usually for the newest
// mail, which may not be in the list the app loaded; the mailbox used to give
// up after two seconds and leave the user on the inbox.

const OLDER = {
  id: 'msg-older',
  folder_path: 'INBOX',
  subject: 'Quarterly numbers from last year',
  from: {
    text: 'Old Sender <old@example.com>',
    value: [{ address: 'old@example.com', name: 'Old Sender' }],
  },
  to: [{ address: 'test@example.com', name: '' }],
  date: new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString(),
  flags: ['\\Seen'],
  html: '<p>The numbers you asked about.</p>',
  attachments: [],
};

async function openLink(page, url) {
  await page.evaluate((link) => {
    window.dispatchEvent(new CustomEvent('app:deep-link', { detail: { url: link } }));
  }, url);
}

test.describe('Opening a notification', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    // Registered after the helper's routes, so it takes precedence.
    await page.route('**/v1/messages/msg-older**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ Result: OLDER }),
      }),
    );
    await navigateToMailbox(page);
  });

  test('opens a message that is in the list', async ({ page }) => {
    await openLink(page, 'forwardemail://mailbox#INBOX/msg-2');
    await expect(page.locator('.fe-reader')).toContainText('Your calendar invite');
    await expect(page).toHaveURL(/#INBOX\/msg-2/);
  });

  test('opens a message that is not in the loaded list by fetching it', async ({ page }) => {
    await openLink(page, 'forwardemail://mailbox#inbox/msg-older');
    await expect(page.locator('.fe-reader')).toContainText('Quarterly numbers from last year', {
      timeout: 10_000,
    });
  });
});
