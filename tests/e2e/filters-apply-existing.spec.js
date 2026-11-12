import { expect, test } from '@playwright/test';
import { setupAuthenticatedMailbox, isMobileProject } from '../fixtures/mailbox-helpers.js';

// A service worker answers fetches before page.route sees them (WebKit).
test.use({ serviceWorkers: 'block' });

// "Also apply to messages already in the Inbox" (PR #116): the rule runs over
// the Inbox only, "is exactly" compares the bare address, changes go through
// the mailbox's own actions, and a long run can be cancelled.

const MANAGED = 'webmail-filters';
const scriptFor = (rules) =>
  `# Filters managed by the Forward Email webmail app.\n# fe-filters-v1:${JSON.stringify(rules)}\n`;

const starAlice = {
  id: 'r1',
  name: 'Alice',
  enabled: true,
  match: 'all',
  conditions: [{ field: 'from', op: 'is', value: 'alice@example.com' }],
  actions: { star: true },
};

const inboxRow = (id, from, extra = {}) => ({
  id,
  uid: Number(id.replace(/\D/g, '')) || 1,
  folder: 'INBOX',
  subject: `Message ${id}`,
  from,
  to: [{ address: 'test@example.com' }],
  date: '2026-11-01T10:00:00.000Z',
  flags: [],
  labels: [],
  ...extra,
});

async function mockServer(page, { rows, listDelayMs = 0 }) {
  const server = { content: scriptFor([starAlice]), lists: [], updates: [] };
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
      server.content = req.postDataJSON().content;
      return json({ id: 's1', name: MANAGED, is_active: true });
    }
    return route.fallback();
  });
  await page.route(/\/v1\/messages(\/[^?]*)?(\?.*)?$/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'PUT') {
      server.updates.push({
        id: decodeURIComponent(url.pathname.split('/').pop()),
        body: req.postDataJSON(),
      });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (req.method() !== 'GET' || !url.pathname.endsWith('/v1/messages')) return route.fallback();
    // Only the existing-mail run asks for 100 at a time without other filters.
    if (url.searchParams.get('limit') !== '100' || url.searchParams.has('is_unread')) {
      return route.fallback();
    }
    server.lists.push(Object.fromEntries(url.searchParams));
    if (listDelayMs) await new Promise((resolve) => setTimeout(resolve, listDelayMs));
    const page = Number(url.searchParams.get('page')) || 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(rows.slice((page - 1) * 100, page * 100)),
    });
  });
  return server;
}

async function applyToExisting(page) {
  await page.goto('/');
  await page.goto('/mailbox/settings#filters');
  await expect(page.getByText('Alice', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit filter' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Also apply to messages already in the Inbox').click();
  await dialog.getByRole('button', { name: 'Update filter' }).click();
  await page.getByRole('button', { name: 'Save filters' }).click();
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'Settings > Filters is covered on desktop');
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await setupAuthenticatedMailbox(page);
});

test('stars Inbox mail from the exact address, display name or not', async ({ page }) => {
  const server = await mockServer(page, {
    rows: [
      inboxRow('m1', [{ name: 'Alice Smith', address: 'alice@example.com' }]),
      inboxRow('m2', [{ name: 'Bob', address: 'bob@example.com' }]),
      inboxRow('m3', [{ address: 'ALICE@example.com' }]),
      inboxRow('m4', [{ name: 'Alice', address: 'alice@example.com' }], { flags: ['\\Flagged'] }),
    ],
  });

  await applyToExisting(page);

  await expect(page.getByText(/Applied "Alice": changed 2 messages in the Inbox/)).toBeVisible();
  await expect.poll(() => server.updates.map((u) => u.id).sort()).toEqual(['m1', 'm3']);
  for (const update of server.updates) expect(JSON.stringify(update.body)).toContain('\\\\Flagged');
  expect(server.lists.length).toBeGreaterThan(0);
  for (const params of server.lists) expect(params.folder).toBe('INBOX');
});

test('cancelling a long run stops before anything changes', async ({ page }) => {
  const rows = Array.from({ length: 100 }, (_, i) =>
    inboxRow(`m${i + 1}`, [{ address: 'alice@example.com' }]),
  );
  const server = await mockServer(page, { rows, listDelayMs: 2500 });

  await applyToExisting(page);

  const progress = page.getByTestId('filter-apply-progress');
  await expect(progress).toContainText('Applying "Alice" to the Inbox');
  await progress.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByText('Stopped "Alice" before changing anything.')).toBeVisible();
  await expect(progress).toHaveCount(0);
  expect(server.updates).toHaveLength(0);
});

test('delete and forward rules cannot be applied to existing mail', async ({ page }) => {
  await mockServer(page, { rows: [] });
  await page.goto('/');
  await page.goto('/mailbox/settings#filters');
  await page.getByRole('button', { name: 'Add filter' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('value').fill('spam@example.com');
  await dialog.getByText('Delete it', { exact: false }).first().click();

  await expect(dialog.getByRole('checkbox', { name: /already in the Inbox/ })).toBeDisabled();
  await expect(dialog.getByTestId('filter-apply-existing-help')).toHaveText(
    'Delete and forward apply to new mail only.',
  );
});
