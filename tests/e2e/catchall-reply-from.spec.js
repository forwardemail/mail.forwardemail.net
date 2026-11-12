import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// A service worker answers fetches before page.route sees them (WebKit).
test.use({ serviceWorkers: 'block' });

// Catch-all From addresses (discussion #590): a reply to mail sent to an
// address on a catch-all domain is sent from that address, and addresses sent
// from before are offered in the From menu.

const basic = (credential) => `Basic ${Buffer.from(credential).toString('base64')}`;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'Desktop reader layout');
  await setupAuthenticatedMailbox(page);
  await installMockSocket(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        'webmail_catchall_credentials',
        JSON.stringify([
          { domain: 'acme.test', password: 'catch-pw', addresses: ['sales@acme.test'] },
        ]),
      );
    } catch {
      // sandboxed email frame
    }
  });
  await installMailServer(page, {
    messages: [
      buildMessage(1, {
        subject: 'Question about my order',
        from: [{ name: 'Casey Customer', address: 'casey@customer.test' }],
        to: [{ name: '', address: 'contact@acme.test' }],
      }),
    ],
  });
});

test('replying to mail sent to a catch-all address sends from that address', async ({ page }) => {
  const sends = [];
  await page.route('**/v1/emails**', async (route) => {
    const req = route.request();
    sends.push({ auth: req.headers().authorization, body: req.postDataJSON() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"e1"}' });
  });

  await openMailbox(page, 'Question about my order');
  await row(page, 'Question about my order').click();
  await page.locator('.fe-reader').getByRole('button', { name: 'Reply', exact: true }).click();

  // A catch-all From is shown as an editable address on its domain.
  const fromLocal = page.getByLabel('Address to send from at acme.test');
  await expect(fromLocal).toHaveValue('contact');

  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type('Thanks, looking into it.');
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();

  await expect.poll(() => sends.length).toBeGreaterThan(0);
  expect(sends[0].auth).toBe(basic('contact@acme.test:catch-pw'));
  expect(JSON.stringify(sends[0].body.from)).toContain('contact@acme.test');
  // The reply goes to the customer, not back to the alias it was sent from.
  expect(JSON.stringify(sends[0].body.to)).toContain('casey@customer.test');
  expect(JSON.stringify(sends[0].body.cc || '')).not.toContain('contact@acme.test');

  // Sending from it adds it to the addresses offered next time.
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('webmail_catchall_credentials') || '[]')),
    )
    .toEqual([
      expect.objectContaining({
        domain: 'acme.test',
        addresses: ['contact@acme.test', 'sales@acme.test'],
      }),
    ]);
});

test('the From menu offers catch-all addresses sent from before', async ({ page }) => {
  await openMailbox(page, 'Question about my order');
  await page.getByRole('button', { name: 'Compose' }).first().click();
  const fromRow = page.getByTestId('compose-from');
  await fromRow.getByRole('button', { name: 'Choose the account to send from' }).click();
  await page.getByRole('menuitem', { name: /sales@acme\.test/ }).click();
  await expect(page.getByLabel('Address to send from at acme.test')).toHaveValue('sales');
});
