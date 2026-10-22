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

// On a phone the inbox list was one compositing layer for as long as it was
// on screen (a constant transform for pull-to-refresh), and switching
// accounts left the drawer it was picked from over the new account's mail.

const inbox = (count, prefix = 'Message') =>
  Array.from({ length: count }, (_, i) =>
    buildMessage(i + 1, { subject: `${prefix} ${String(i + 1).padStart(4, '0')}` }),
  );

test.describe('Phone inbox position', () => {
  test.skip(({ isMobile }) => !isMobile, 'Phone layout');

  test('the list carries no transform while nothing is pulled', async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    await installMailServer(page, { messages: inbox(30) });
    await openMailbox(page, 'Message 0001');
    const style = await page
      .locator('.fe-message-list-wrapper [aria-busy]')
      .first()
      .getAttribute('style');
    expect(style || '').not.toMatch(/transform/);
  });

  test('switching accounts closes the drawer and shows the new inbox', async ({ page }) => {
    const OTHER = { email: 'other@example.net', password: 'other-Pa55word' };
    await mockApi(page);
    await installMockSocket(page);
    await installAccountServers(page, {
      [ACCOUNT]: { password: PASSWORD, messages: inbox(10, 'Mine') },
      [OTHER.email]: { password: OTHER.password, messages: inbox(10, 'Theirs') },
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

    await page.getByLabel('Toggle sidebar').click();
    const sidebar = page.getByTestId('mailbox-sidebar');
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('button', { name: ACCOUNT }).first().click();
    await sidebar.getByRole('button', { name: OTHER.email }).click();

    await expect(row(page, 'Theirs 0001')).toBeVisible({ timeout: 15_000 });
    await expect(sidebar).toBeHidden();
    await expect(page).toHaveURL(/\/mailbox#INBOX$/);
  });
});
