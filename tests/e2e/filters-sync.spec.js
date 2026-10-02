import { expect, test } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  isMobileProject,
} from '../fixtures/mailbox-helpers.js';

// Filters are Sieve scripts on the server, which other devices and the website
// can change at any time. The Filters view must show the server's rules every
// time it is opened, and must not save over rules that changed elsewhere.

const MANAGED = 'webmail-filters';

// Same format sieve-rules.ts writes: the rule set as JSON in a marker comment.
const scriptFor = (rules) =>
  `# Filters managed by the Forward Email webmail app.\n# fe-filters-v1:${JSON.stringify(rules)}\n`;

const rule = (id, name, value) => ({
  id,
  name,
  enabled: true,
  match: 'all',
  conditions: [{ field: 'from', op: 'contains', value }],
  actions: { star: true },
});

async function mockSieve(page, initialRules) {
  const server = { content: scriptFor(initialRules), writes: 0 };
  await page.route('**/v1/sieve-scripts**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'GET' && url.pathname.endsWith('/v1/sieve-scripts')) {
      return json([{ id: 's1', name: MANAGED, is_active: true }]);
    }
    if (req.method() === 'GET') return json({ id: 's1', name: MANAGED, content: server.content });
    if (req.method() === 'PUT') {
      server.writes += 1;
      server.content = req.postDataJSON().content;
      return json({ id: 's1', name: MANAGED, is_active: true });
    }
    return route.fallback();
  });
  return server;
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'Desktop only');
  // Keep the app's WebSocket off the real server (fake credentials there can
  // sign the session out mid-test).
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await setupAuthenticatedMailbox(page);
});

test('opening Filters on startup shows the server rules', async ({ page }) => {
  await mockSieve(page, [rule('r1', 'Newsletters', 'news@example.com')]);
  await page.goto('/');
  await page.goto('/mailbox/settings#filters');

  await expect(page.getByText('Newsletters', { exact: true })).toBeVisible();
});

test('coming back to Filters picks up changes made elsewhere', async ({ page }) => {
  const server = await mockSieve(page, [rule('r1', 'Newsletters', 'news@example.com')]);
  await navigateToMailbox(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Filters' }).first().click();
  await expect(page.getByText('Newsletters', { exact: true })).toBeVisible();

  // Another device replaces the rules while the user is in the inbox.
  server.content = scriptFor([rule('r2', 'Invoices', 'billing@example.com')]);
  await page.goBack();
  await expect(page.locator('[data-conversation-row]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).first().click();

  await expect(page.getByText('Invoices', { exact: true })).toBeVisible();
  await expect(page.getByText('Newsletters', { exact: true })).toHaveCount(0);
});

test('saving does not overwrite rules changed elsewhere', async ({ page }) => {
  const server = await mockSieve(page, [rule('r1', 'Newsletters', 'news@example.com')]);
  await page.goto('/');
  await page.goto('/mailbox/settings#filters');
  await expect(page.getByText('Newsletters', { exact: true })).toBeVisible();

  // Unsaved local edit, then another device saves first.
  await page.getByRole('checkbox', { name: 'Enable Newsletters' }).click();
  server.content = scriptFor([rule('r2', 'Invoices', 'billing@example.com')]);
  await page.getByRole('button', { name: 'Save filters' }).click();

  await expect(page.getByText(/changed on another device/i)).toBeVisible();
  await expect(page.getByText('Invoices', { exact: true })).toBeVisible();
  expect(server.writes).toBe(0);
});
