import { expect, test } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  isMobileProject,
  openComposeFromSidebar,
} from '../fixtures/mailbox-helpers.js';

// Compose From menu: lists the accounts signed in on this device, and sending
// from one authenticates as that account. The API only accepts a From address
// with that alias's own credentials.

const basic = (credential) => `Basic ${Buffer.from(credential).toString('base64')}`;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'Desktop only');
  // page.route does not cover WebSockets, so without this the app connects to
  // the real server with fake credentials. The resulting auth failures can sign
  // the session out mid-test. Accept the socket and stay quiet.
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await setupAuthenticatedMailbox(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        'webmail_accounts',
        JSON.stringify([
          { email: 'test@example.com', aliasAuth: 'test@example.com:mock-password' },
          { email: 'alias@example.com', aliasAuth: 'alias@example.com:alias-password' },
          // Signed out: no credentials left, so it cannot send.
          { email: 'gone@example.com' },
        ]),
      );
      localStorage.setItem('webmail_profile_name_alias@example.com', 'Alias Person');
    } catch {
      // sandboxed frame
    }
  });
  await navigateToMailbox(page);
});

test('From menu lists only accounts that can send', async ({ page }) => {
  await openComposeFromSidebar(page);
  const fromRow = page.getByTestId('compose-from');
  await expect(fromRow).toContainText('test@example.com');

  await fromRow.getByRole('button', { name: 'Choose the account to send from' }).click();
  await expect(page.getByRole('menuitem', { name: /test@example\.com/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /alias@example\.com/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /gone@example\.com/ })).toHaveCount(0);
});

test('sending from another account uses its credentials', async ({ page }) => {
  const requests = [];
  await page.route('**/v1/emails**', async (route) => {
    const req = route.request();
    requests.push({ kind: 'send', auth: req.headers().authorization, body: req.postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"e1"}' });
  });
  await page.route('**/v1/messages', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    requests.push({ kind: 'sent-copy', auth: req.headers().authorization });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"m1"}' });
  });

  await openComposeFromSidebar(page);
  const fromRow = page.getByTestId('compose-from');
  await fromRow.getByRole('button', { name: 'Choose the account to send from' }).click();
  await page.getByRole('menuitem', { name: /alias@example\.com/ }).click();
  await expect(fromRow).toContainText('Alias Person <alias@example.com>');

  const to = page.locator('input[placeholder="To"]').first();
  await to.fill('friend@example.org');
  await to.press('Enter');
  await page.getByPlaceholder('Subject').first().fill('From the alias');
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();

  await expect.poll(() => requests.find((r) => r.kind === 'send')).toBeTruthy();
  const send = requests.find((r) => r.kind === 'send');
  expect(send.auth).toBe(basic('alias@example.com:alias-password'));
  expect(send.body.from).toBe('"Alias Person" <alias@example.com>');

  await expect.poll(() => requests.find((r) => r.kind === 'sent-copy')).toBeTruthy();
  expect(requests.find((r) => r.kind === 'sent-copy').auth).toBe(
    basic('alias@example.com:alias-password'),
  );
});
