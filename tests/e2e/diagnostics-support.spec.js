import { expect, test } from '@playwright/test';
import { setupAuthenticatedMailbox, navigateToMailbox } from '../fixtures/mailbox-helpers.js';

// "Email to support" on the diagnostics page set window.location to a mailto:
// link, which the iOS and Android apps drop, so nothing happened. Signed in,
// it now opens our composer with the report attached; signed out it hands the
// report to the system share sheet.

async function openDiagnostics(page) {
  await page.evaluate(() => {
    history.pushState({ route: 'diagnostics', fromApp: true }, '', '/mailbox/diagnostics');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  const send = page.getByRole('button', { name: 'Email to support' });
  await expect(send).toBeVisible({ timeout: 20_000 });
  return send;
}

test('signed in, the report opens in our composer addressed to support', async ({ page }) => {
  await setupAuthenticatedMailbox(page);
  await navigateToMailbox(page);
  const send = await openDiagnostics(page);

  // The new probes are in the report
  for (const label of ['Storage use', 'Cache contents', 'Page reloads']) {
    await expect(page.getByText(`${label}:`, { exact: true })).toBeVisible();
  }

  await send.click();
  await expect(page.getByPlaceholder('Subject').first()).toHaveValue(
    'Forward Email diagnostics report',
  );
  await expect(page.getByText('support@forwardemail.net').first()).toBeVisible();
  await expect(page.getByText('diagnostics.json').first()).toBeVisible();
  await expect(page.locator('[contenteditable="true"]').first()).toContainText(
    'Forward Email Diagnostics',
  );
});

test('signed out, the report goes to the share sheet as a file', async ({ page }) => {
  await page.addInitScript(() => {
    window.__shared = [];
    navigator.canShare = () => true;
    navigator.share = async (data) => {
      window.__shared.push({ text: data.text, files: (data.files || []).map((f) => f.name) });
    };
  });
  await page.goto('/mailbox/diagnostics');
  const send = page.getByRole('button', { name: 'Email to support' });
  await expect(send).toBeVisible({ timeout: 20_000 });
  await send.click();

  await expect
    .poll(() => page.evaluate(() => window.__shared))
    .toEqual([
      {
        text: expect.stringContaining('Please send to support@forwardemail.net'),
        files: ['diagnostics.json'],
      },
    ]);
  await expect(page.getByPlaceholder('Subject')).toHaveCount(0);
});
