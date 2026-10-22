import { expect, test } from '@playwright/test';
import { mockApi } from './mockApi.js';
import {
  ACCOUNT,
  PASSWORD,
  buildMessage,
  installAccountServers,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';
import { setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';

// History in the phone reader. A message opened from a link or notification
// has no history entry of its own, so swiping to the next one and closing
// went "back" to the first and opened it again. And an entry left from the
// account used before a switch opened that account's message id under the
// new account.

const inbox = (count, prefix = 'Message') =>
  Array.from({ length: count }, (_, i) =>
    buildMessage(i + 1, { subject: `${prefix} ${String(i + 1).padStart(4, '0')}` }),
  );

// A real touch swipe across the reader, through Chromium's input pipeline
async function swipeLeft(page) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y: 420 }],
    });
  await touch('touchStart', 320);
  for (let x = 300; x >= 140; x -= 20) await touch('touchMove', x);
  await touch('touchEnd');
}

test.describe('Phone reader history', () => {
  test.skip(({ isMobile, browserName }) => !isMobile || browserName !== 'chromium', 'Phone, touch');

  test('closing after a link and a swipe stays on the list', async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    await installMailServer(page, { messages: inbox(5) });
    await openMailbox(page, 'Message 0001');

    // As a notification tap or a shared link opens a message
    await page.evaluate(() => {
      location.hash = '#INBOX/msg-1';
    });
    const reader = page.locator('.fe-reader');
    await expect(reader.getByText('Message 0001').first()).toBeVisible();

    await swipeLeft(page);
    await expect(page).toHaveURL(/#INBOX\/msg-2/);
    await expect(reader.getByText('Message 0002').first()).toBeVisible();

    await page.getByRole('button', { name: 'Back to list' }).click();
    await expect(page).toHaveURL(/\/mailbox#INBOX$/);
    // It used to land on msg-1's entry and open it again a moment later
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/mailbox#INBOX$/);
    await expect(page.getByRole('button', { name: 'Back to list' })).toBeHidden();
  });

  test("an entry left from the other account opens this account's inbox", async ({ page }) => {
    const OTHER = { email: 'other@example.net', password: 'other-Pa55word' };
    await mockApi(page);
    await installMockSocket(page);
    // Both accounts have a msg-3: the entry must not open the other one's
    await installAccountServers(page, {
      [ACCOUNT]: { password: PASSWORD, messages: inbox(5, 'Mine') },
      [OTHER.email]: { password: OTHER.password, messages: inbox(5, 'Theirs') },
    });
    await page.addInitScript(
      ({ first, second }) => {
        try {
          localStorage.setItem(
            'webmail_accounts',
            JSON.stringify([
              { email: first.email, aliasAuth: `${first.email}:${first.password}` },
              { email: second.email, aliasAuth: `${second.email}:${second.password}` },
            ]),
          );
          if (!localStorage.getItem('webmail_email')) {
            localStorage.setItem('webmail_email', first.email);
            localStorage.setItem('webmail_alias_auth', `${first.email}:${first.password}`);
          }
        } catch {
          // sandboxed frame
        }
      },
      { first: { email: ACCOUNT, password: PASSWORD }, second: OTHER },
    );
    await openMailbox(page, 'Mine 0001');

    // Open one of this account's messages, then go back to the list. Its
    // entry stays ahead in history.
    await row(page, 'Mine 0003').click();
    await expect(page).toHaveURL(/#INBOX\/msg-3/);
    await page.goBack();
    await expect(page).toHaveURL(/\/mailbox#INBOX$/);

    await page.getByLabel('Toggle sidebar').click();
    const sidebar = page.getByTestId('mailbox-sidebar');
    await sidebar.getByRole('button', { name: ACCOUNT }).first().click();
    await sidebar.getByRole('button', { name: OTHER.email }).click();
    await expect(row(page, 'Theirs 0001')).toBeVisible({ timeout: 15_000 });

    await page.goForward();
    await expect(page).toHaveURL(/\/mailbox#INBOX$/);
    await expect(row(page, 'Theirs 0001')).toBeVisible();
    await expect(page.locator('.fe-reader').getByText('Theirs 0003')).toHaveCount(0);
  });
});
