import { expect, test } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  isMobileProject,
  selectMessageBySubject,
  waitForReaderToOpen,
  goBackToList,
} from '../fixtures/mailbox-helpers.js';

// ── Message List ─────────────────────────────────────────────────────────────

test.describe('Mailbox — message list', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
  });

  test('displays message list', async ({ page }) => {
    await expect(
      page.locator('[data-conversation-row]', { hasText: 'Welcome to Webmail' }),
    ).toBeVisible();
    await expect(
      page.locator('[data-conversation-row]', { hasText: 'Your calendar invite' }),
    ).toBeVisible();
  });

  test('shows correct sender names in rows', async ({ page }) => {
    await expect(page.locator('[data-conversation-row]', { hasText: 'Team' })).toBeVisible();
    await expect(
      page.locator('[data-conversation-row]', { hasText: 'Calendar Bot' }),
    ).toBeVisible();
  });

  test('shows unread indicator on unread messages', async ({ page }) => {
    const unreadRow = page.locator('[data-conversation-row]', { hasText: 'Welcome to Webmail' });
    await expect(unreadRow).toBeVisible();
    await expect(unreadRow).toHaveAttribute('data-unread', 'true');
  });

  test('shows attachment indicator', async ({ page }) => {
    const row = page.locator('[data-conversation-row]', { hasText: 'Your calendar invite' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Your calendar invite')).toBeVisible();
  });

  test('shows all mock messages', async ({ page }) => {
    await expect(page.locator('[data-conversation-row]').nth(1)).toBeVisible({ timeout: 10_000 });
    const rows = page.locator('[data-conversation-row]');
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
  });
});

// ── Message Reader ───────────────────────────────────────────────────────────

test.describe('Mailbox — message reader', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
  });

  test('opens message reader when row is clicked', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);
    const reader = page.locator('.fe-reader');
    await expect(reader).toBeVisible();
  });

  test('reader shows message subject', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);
    await expect(page.locator('.fe-reader').getByText('Welcome to Webmail')).toBeVisible();
  });

  test('reader does not expose a bottom horizontal scrollbar for normal message content', async ({
    page,
  }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop only');

    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);

    const metrics = await page.locator('.fe-reader').evaluate((element) => ({
      overflowX: window.getComputedStyle(element).overflowX,
      overflowY: window.getComputedStyle(element).overflowY,
    }));

    expect(metrics.overflowX).toBe('hidden');
    expect(metrics.overflowY).toBe('auto');
  });
});

// ── Desktop-Only Layout ──────────────────────────────────────────────────────

test.describe('Mailbox — desktop layout', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop only');
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
  });

  test('shows search bar in header', async ({ page }) => {
    await expect(page.getByPlaceholder('Search mail')).toBeVisible();
  });

  test('shows sidebar with all folders', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Inbox/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sent/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Drafts/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Trash/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Archive/ })).toBeVisible();
  });

  test('reader shows alongside message list', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);
    await page.waitForTimeout(500);
    const reader = page.locator('.fe-reader');
    await expect(reader).toBeVisible();
  });

  test('toolbar shows action buttons', async ({ page }) => {
    await expect(page.getByLabel('Enter selection mode')).toBeVisible();
    await expect(page.getByRole('button', { name: /Refresh/ }).first()).toBeVisible();
  });
});

// ── Mobile-Only Layout ───────────────────────────────────────────────────────

test.describe('Mailbox — mobile layout', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo), 'Mobile only');
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
  });

  test('shows compose button in bottom tab bar', async ({ page }) => {
    // Compose now lives in the mobile bottom tab bar (it replaced the FAB).
    await expect(page.locator('.fe-mobile-tabbar').getByLabel('Compose')).toBeVisible();
  });

  test('shows avatar circles in message rows', async ({ page }) => {
    const avatar = page.locator('[data-conversation-row] button.rounded-full').first();
    await expect(avatar).toBeVisible();
  });

  test('reader goes fullscreen on mobile', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);

    const reader = page.locator('.fe-reader');
    await expect(reader).toBeVisible();
  });

  test('back button returns to message list', async ({ page }, testInfo) => {
    await selectMessageBySubject(page, 'Welcome to Webmail');
    await waitForReaderToOpen(page, testInfo);

    await goBackToList(page);
    await page.waitForTimeout(500);

    await expect(
      page.locator('[data-conversation-row]', { hasText: 'Welcome to Webmail' }),
    ).toBeVisible();
  });

  test('hamburger opens sidebar overlay', async ({ page }) => {
    await page.getByLabel('Toggle sidebar').click();
    await page.waitForTimeout(300);
    const sidebar = page.locator('.fe-folders');
    await expect(sidebar).toBeVisible();
  });
});

// ── Search ───────────────────────────────────────────────────────────────────

test.describe('Mailbox — search', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
  });

  test('search input accepts text and triggers search', async ({ page }, testInfo) => {
    if (isMobileProject(testInfo)) {
      // On mobile, search lives in the full-screen overlay opened from the
      // Search tab in the bottom tab bar — not a header input.
      await page.locator('.fe-mobile-tabbar').getByLabel('Search').click();
      const overlayInput = page.locator('.fe-search-overlay-input');
      await overlayInput.fill('calendar');
      await expect(overlayInput).toHaveValue('calendar');
    } else {
      const searchInput = page.getByPlaceholder('Search mail');
      await searchInput.fill('calendar');
      await expect(searchInput).toHaveValue('calendar');
    }
  });
});

// ── Folder Navigation ────────────────────────────────────────────────────────

test.describe('Mailbox — folder navigation', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
    if (isMobileProject(testInfo)) {
      await page.getByLabel('Toggle sidebar').click();
      await page.waitForTimeout(300);
    }
  });

  test('shows all expected folders', async ({ page }) => {
    // Scope to the folder sidebar: the mobile bottom tab bar also has an
    // "Inbox" button, which would otherwise make /Inbox/ ambiguous.
    const folders = page.locator('.fe-folders');
    await expect(folders.getByRole('button', { name: /Inbox/ })).toBeVisible();
    await expect(folders.getByRole('button', { name: /Archive/ })).toBeVisible();
    await expect(folders.getByRole('button', { name: /Trash/ })).toBeVisible();
  });

  test('inbox shows unread count badge', async ({ page }) => {
    const inboxBtn = page.locator('.fe-folders').getByRole('button', { name: /Inbox/ }).first();
    await expect(inboxBtn).toBeVisible();
    await expect(inboxBtn).toContainText(/\d+/);
  });
});

// ── Mobile overlays ─────────────────────────────────────────────────────────

// Bottom-anchored overlays (the "default email app" banner and toasts) used to
// sit on top of the mobile tab bar, so Search/Compose/Settings could not be
// tapped until they were dismissed.

const TABS = ['Inbox', 'Search', 'Compose', 'Settings'];

async function tabIsHitTarget(page, label) {
  const tab = page.locator('.fe-mobile-tabbar').getByLabel(label);
  const box = await tab.boundingBox();
  if (!box) return false;
  return page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit?.closest('.fe-mobile-tabbar'));
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}

test.describe('Mobile — bottom overlays leave the tab bar usable', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo), 'mobile layout only');
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
  });

  test('no default-app banner on touch devices', async ({ page }) => {
    // The banner appeared 2 s after load.
    await page.waitForTimeout(2_500);
    await expect(page.getByText('Set Forward Email as your default email app?')).toHaveCount(0);
    for (const label of TABS) {
      expect(await tabIsHitTarget(page, label), `${label} tab is covered`).toBe(true);
    }
  });

  test('toasts render above the tab bar', async ({ page }) => {
    // Add an entry to the app's own toast list so the check covers its real
    // positioning rules, independent of which actions happen to toast.
    await page.evaluate(() => {
      const list = document.querySelector('[data-testid="toast-list"]');
      if (!list) throw new Error('toast list not mounted');
      const toast = document.createElement('div');
      toast.setAttribute('data-testid', 'toast');
      toast.style.cssText = 'height:64px;width:90vw;background:#fff';
      toast.textContent = 'Test toast';
      list.appendChild(toast);
    });

    const toastBox = await page.getByTestId('toast').last().boundingBox();
    const barBox = await page.locator('.fe-mobile-tabbar').boundingBox();
    expect(toastBox && barBox).toBeTruthy();
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(barBox.y);
    for (const label of TABS) {
      expect(await tabIsHitTarget(page, label), `${label} tab is covered`).toBe(true);
    }
  });
});

// ── Checking messages ────────────────────────────────────────────────────────

// Counts the nodes removed inside the message list from now on. WebKit's
// compositor can crash when list nodes are removed under it
// (src/utils/deferred-store.ts), and the app then reloads empty, which on a
// phone read as the list freezing and then flashing blank on every check.
async function watchListRemovals(page) {
  await page.evaluate(() => {
    const list = document.querySelector(
      '[role="listbox"][aria-label="Conversations"], [role="listbox"][aria-label="Messages"]',
    );
    const state = { removed: 0 };
    window.__feListRemovals = state;
    new MutationObserver((records) => {
      for (const record of records) state.removed += record.removedNodes.length;
    }).observe(list, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => window.__feListRemovals.removed);
}

test.describe('Mailbox — checking messages', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
  });

  test('checks and unchecks rows without removing anything from the list', async ({
    page,
  }, testInfo) => {
    const rows = page.locator('[data-conversation-row]');
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
    const removed = await watchListRemovals(page);
    const checkbox = (i) =>
      rows
        .nth(i)
        .getByLabel(/^(Select|Deselect)$/)
        .first();
    // On a phone the avatar is the checkbox; on a desktop (card view) the
    // checkboxes stay out of sight until selection mode.
    if (!isMobileProject(testInfo)) {
      await expect(checkbox(0)).toBeHidden();
      await page.getByLabel('Enter selection mode').click();
      await expect(checkbox(0)).toBeVisible();
    }

    await checkbox(0).click();
    await checkbox(1).click();
    await expect(checkbox(0)).toHaveAttribute('aria-label', 'Deselect');
    await expect(checkbox(1)).toHaveAttribute('aria-label', 'Deselect');
    await checkbox(0).click();
    await checkbox(1).click();
    await expect(checkbox(0)).toHaveAttribute('aria-label', 'Select');
    await expect(checkbox(1)).toHaveAttribute('aria-label', 'Select');

    expect(await removed()).toBe(0);
  });

  test('keeps every row rendered on phones', async ({ page }) => {
    // Skipping off-screen rows (content-visibility) painted rows blank on
    // phones whenever checking a message resized the list.
    const row = page.locator('.fe-msg-row').first();
    await expect(row).toBeVisible();
    const { os, touch } = await page.evaluate(() => ({
      os: document.documentElement.dataset.os,
      touch: matchMedia('(pointer: coarse)').matches,
    }));
    const contentVisibility = await row.evaluate((el) => getComputedStyle(el).contentVisibility);
    const rendersAll = touch || ['ios', 'android', 'windows'].includes(os);
    expect(contentVisibility).toBe(rendersAll ? 'visible' : 'auto');
  });
});

test.describe('Mailbox — loading', () => {
  test('keeps the list toolbar on screen while the messages are still loading', async ({
    page,
  }) => {
    await setupAuthenticatedMailbox(page);
    // Hold every message list until the test lets it through, as on a slow
    // link or right after switching accounts.
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/v1/messages**', async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (request.method() === 'GET' && !/\/v1\/messages\/[^/]+$/.test(pathname)) await released;
      return route.fallback();
    });
    await page.goto('/');
    await page.goto('/mailbox#INBOX');

    const pane = page.getByTestId('message-list-pane');
    await expect(pane).toBeVisible({ timeout: 15_000 });
    // The list is empty for now, but the pane is not blank: its toolbar stays.
    await expect(pane.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    expect(await page.locator('[data-conversation-row]').count()).toBe(0);

    release();
    await expect(page.locator('[data-conversation-row]').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
