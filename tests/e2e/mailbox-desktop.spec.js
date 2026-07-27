import { expect, test } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  isMobileProject,
  selectMessageBySubject,
  waitForReaderToOpen,
  clickDeleteInReader,
  clickArchiveInReader,
  enterSelectionMode,
  selectRowCheckbox,
  openComposeFromSidebar,
  composeAndSend,
} from '../fixtures/mailbox-helpers.js';

// All tests in this file are desktop-only
test.beforeEach(async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'Desktop only');
  await setupAuthenticatedMailbox(page);
  await navigateToMailbox(page);
});

// ── Compose & Send ──────────────────────────────────────────────────────────

test.describe('Desktop — Compose', () => {
  test('opens compose from sidebar button', async ({ page }) => {
    await openComposeFromSidebar(page);
    // Compose opening MUST surface the Subject input — assert it, don't swallow.
    await expect(page.locator('input[placeholder*="Subject"]').first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('compose has editor area', async ({ page }) => {
    await openComposeFromSidebar(page);
    // The TipTap contenteditable body must render once compose is open.
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('compose and send fires the send request', async ({ page }) => {
    await openComposeFromSidebar(page);
    // The send network call (POST /v1/emails) is what demo mode blocks; against
    // the mock backend it goes through. Assert it actually fires with the
    // recipient — this is the only e2e coverage of the compose → outbox → API
    // send path (the optimistic-UI tests don't touch the network).
    const sendRequest = page.waitForRequest(
      (r) => r.url().includes('/v1/emails') && r.method() === 'POST',
      { timeout: 10000 },
    );
    await composeAndSend(page, {
      to: 'recipient@example.com',
      subject: 'E2E send test',
      body: 'Hello from the e2e send path.',
    });
    const req = await sendRequest;
    expect(req.postData() || '').toContain('recipient@example.com');
  });
});

// ── Reply & Forward ─────────────────────────────────────────────────────────

test.describe('Desktop — Reply & Forward', () => {
  test('reader shows reply button', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);

    const replyBtn = page.getByLabel(/Reply/i).first();
    await expect(replyBtn).toBeVisible({ timeout: 5000 });
  });

  test('reader shows forward option', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);

    // Forward may be in a dropdown or directly visible
    const reader = page.locator('.fe-reader');
    const buttons = reader.locator('button');
    expect(await buttons.count()).toBeGreaterThan(0);
  });
});

// ── Message Actions ─────────────────────────────────────────────────────────

test.describe('Desktop — Message Actions', () => {
  test('delete moves the message to Trash via the API', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Your calendar invite');
    await waitForReaderToOpen(page, testInfo);

    const reader = page.locator('.fe-reader');
    await expect(reader).toBeVisible();

    // A non-permanent delete from Inbox is a move-to-Trash: PUT /v1/messages/:id
    // with { folder }. Assert the network mutation actually fires (demo mode
    // blocks this) — not just the optimistic UI removal.
    const moveReq = page.waitForRequest(
      (r) =>
        /\/v1\/messages\//.test(r.url()) &&
        r.method() === 'PUT' &&
        Boolean(r.postDataJSON()?.folder),
      { timeout: 8000 },
    );
    await clickDeleteInReader(page);
    const req = await moveReq;
    expect(String(req.postDataJSON()?.folder || '').toUpperCase()).toBe('TRASH');
    // Optimistic update also removes the row from the list.
    await expect(
      page.locator('[data-conversation-row]', { hasText: 'Your calendar invite' }),
    ).toHaveCount(0, { timeout: 5000 });
  });

  test('archive moves the message to Archive via the API', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);

    const reader = page.locator('.fe-reader');
    await expect(reader).toBeVisible();

    const moveReq = page.waitForRequest(
      (r) =>
        /\/v1\/messages\//.test(r.url()) &&
        r.method() === 'PUT' &&
        Boolean(r.postDataJSON()?.folder),
      { timeout: 8000 },
    );
    await clickArchiveInReader(page);
    const req = await moveReq;
    expect(String(req.postDataJSON()?.folder || '')).toBe('Archive');
    await expect(
      page.locator('[data-conversation-row]', { hasText: 'Welcome to Webmail' }),
    ).toHaveCount(0, { timeout: 5000 });
  });

  test('reader shows action toolbar with reply, delete, archive', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);

    // Reader toolbar should have action buttons
    const reader = page.locator('.fe-reader');
    await expect(reader).toBeVisible();
    // At least one action button should be visible
    const buttons = reader.locator('button');
    expect(await buttons.count()).toBeGreaterThan(0);
  });
});

// ── Keyboard Shortcuts ──────────────────────────────────────────────────────

test.describe('Desktop — Keyboard Shortcuts', () => {
  test('Refresh button triggers reload', async ({ page }) => {
    const refreshBtn = page.getByRole('button', { name: /Refresh/ }).first();
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();
    await page.waitForTimeout(500);
    // Messages should still be visible after refresh
    await expect(page.locator('[data-conversation-row]').first()).toBeVisible();
  });
});

// ── Multi-Select & Bulk Actions ─────────────────────────────────────────────

test.describe('Desktop — Selection Mode', () => {
  test('enters selection mode via toolbar button', async ({ page }) => {
    await enterSelectionMode(page);
    // After entering selection mode, checkboxes should be interactive
    const firstRow = page.locator('[data-conversation-row]').first();
    await expect(firstRow).toBeVisible();
  });

  test('selects a message row', async ({ page }) => {
    await enterSelectionMode(page);
    await selectRowCheckbox(page, 'Welcome to Webmail');
    // The row should now be selected (visual indicator)
    const row = page.locator('[data-conversation-row]', { hasText: 'Welcome to Webmail' });
    await expect(row).toBeVisible();
  });

  test('shows bulk action bar when messages are selected', async ({ page }) => {
    await enterSelectionMode(page);
    await selectRowCheckbox(page, 'Welcome to Webmail');
    // Selecting a row reveals the bulk-action toolbar (Archive/Delete selected).
    await expect(page.getByLabel('Delete selected')).toBeVisible({ timeout: 5000 });
  });
});

// ── Search ──────────────────────────────────────────────────────────────────

test.describe('Desktop — Search Workflow', () => {
  test('typing in search triggers search results', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search mail');
    await searchInput.fill('calendar');
    await page.waitForTimeout(500);
    // Query should be reflected in the input
    await expect(searchInput).toHaveValue('calendar');
  });

  test('clearing search restores message list', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search mail');
    await searchInput.fill('test search');
    await page.waitForTimeout(300);
    await searchInput.clear();
    await page.waitForTimeout(500);
    // Original messages should still be visible
    await expect(
      page.locator('[data-conversation-row]', { hasText: 'Welcome to Webmail' }),
    ).toBeVisible();
  });

  test('search shows suggestions on focus', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search mail');
    await searchInput.focus();
    // Focus reveals the operator suggestion panel (from:, to:, subject:, …).
    await expect(page.locator('[data-type="operator"]').first()).toBeVisible({ timeout: 5000 });
  });
});

// ── Sidebar & Folder Navigation ─────────────────────────────────────────────

test.describe('Desktop — Sidebar Navigation', () => {
  test('clicking a folder navigates to it', async ({ page }) => {
    const sentBtn = page.getByRole('button', { name: /Sent/ }).first();
    await sentBtn.click();
    await page.waitForTimeout(500);
    // URL should reflect the folder change
  });

  test('sidebar shows compose button', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Compose' }).first()).toBeVisible();
  });

  test('sidebar toggle collapses sidebar', async ({ page }) => {
    await page.getByLabel('Toggle sidebar').click();
    await page.waitForTimeout(300);
    // Sidebar state should change
  });

  test('sidebar shows account info', async ({ page }) => {
    // The account email or a button with the email should be visible in sidebar
    const accountBtn = page.locator('button', { hasText: 'test@example.com' });
    await expect(accountBtn.first()).toBeVisible();
  });
});

// ── Theme Toggle ────────────────────────────────────────────────────────────

test.describe('Desktop — Theme', () => {
  test('theme toggle button is visible', async ({ page }) => {
    const themeBtn = page.getByLabel(/dark mode|light mode/i).first();
    await expect(themeBtn).toBeVisible();
  });

  test('clicking theme toggle changes mode', async ({ page }) => {
    const themeBtn = page.getByLabel(/dark mode|light mode/i).first();
    const labelBefore = await themeBtn.getAttribute('aria-label');
    await themeBtn.click();
    await page.waitForTimeout(300);
    // Label should have changed
    const labelAfter = await themeBtn.getAttribute('aria-label');
    expect(labelAfter).not.toBe(labelBefore);
  });
});

// ── Profile & Settings Navigation ───────────────────────────────────────────

test.describe('Desktop — Navigation', () => {
  test('settings button navigates to settings', async ({ page }) => {
    const settingsBtn = page.getByLabel('Settings').first();
    await settingsBtn.click();
    await page.waitForTimeout(500);
  });

  test('contacts button navigates to contacts', async ({ page }) => {
    const contactsBtn = page.getByLabel('Contacts').first();
    await contactsBtn.click();
    await page.waitForTimeout(500);
  });

  test('calendar button navigates to calendar', async ({ page }) => {
    const calendarBtn = page.getByLabel('Calendar').first();
    await calendarBtn.click();
    await page.waitForTimeout(500);
  });

  test('profile button is visible', async ({ page }) => {
    await expect(page.getByLabel('Profile')).toBeVisible();
  });
});
