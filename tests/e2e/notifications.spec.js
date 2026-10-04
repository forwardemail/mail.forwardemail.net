import { expect, test } from '@playwright/test';
import { setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';

// New mail notifications on the web come from the WebSocket connection and
// need the browser's notification permission. A browser only shows the
// permission prompt for a request a click started, so Settings has to offer
// that click and say what state the permission is in.

// Chrome Headless Shell, Playwright's default Chromium, always reports
// Notification.permission as "denied", even after grantPermissions. Chromium's
// new headless mode reports the real permission like a desktop browser does.
test.use({ channel: 'chromium' });

// Record what reaches the browser's notification APIs.
async function recordNotifications(page) {
  await page.addInitScript(() => {
    window.__shownNotifications = [];
    const record = (title, options) => window.__shownNotifications.push({ title, ...options });
    if (window.ServiceWorkerRegistration?.prototype?.showNotification) {
      const original = window.ServiceWorkerRegistration.prototype.showNotification;
      window.ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
        record(title, options);
        return original.call(this, title, options);
      };
    }
    if (window.Notification) {
      const Original = window.Notification;
      const Wrapped = function (title, options) {
        record(title, options);
        return new Original(title, options);
      };
      Object.defineProperty(Wrapped, 'permission', { get: () => Original.permission });
      Wrapped.requestPermission = (...args) => Original.requestPermission(...args);
      window.Notification = Wrapped;
    }
  });
}

async function openNotificationSettings(page) {
  await page.goto('/mailbox/settings#general');
  const row = page.getByTestId('new-mail-notifications');
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

test.describe('New mail notifications setting', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
  });

  test('offers to allow notifications when the browser has not been asked', async ({ page }) => {
    const row = await openNotificationSettings(page);

    await expect(page.getByTestId('new-mail-notifications-state')).toContainText('Off.');
    await expect(row.getByRole('button', { name: 'Allow notifications' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Send a test notification' })).toHaveCount(0);
  });

  test('shows the permission as on and sends a test notification', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(['notifications'], { origin: baseURL });
    await recordNotifications(page);
    const row = await openNotificationSettings(page);

    await expect(page.getByTestId('new-mail-notifications-state')).toContainText('On.');
    await row.getByRole('button', { name: 'Send a test notification' }).click();

    await expect
      .poll(() => page.evaluate(() => window.__shownNotifications))
      .toEqual([
        expect.objectContaining({
          title: 'Forward Email',
          body: 'Notifications are working. New mail will appear like this.',
          icon: '/icons/icon-192.png',
        }),
      ]);
    await expect(page.getByText('No notification could be shown')).toHaveCount(0);
    // (the page cannot tell whether the system showed it, so it says where to look)
    await expect(page.getByText('Test notification sent.')).toBeVisible();
  });
});

// The whole path for web: a newMessage frame on the WebSocket turns into a
// system notification, an in-app toast, or a notice when the user returns.
// Window focus is the one thing a headless browser cannot give up on its
// own, so document.hasFocus() is driven from the test.
test.describe('New mail from the WebSocket', () => {
  let sockets;

  test.beforeEach(async ({ page }) => {
    sockets = [];
    await page.routeWebSocket(/\/v1\/ws/, (ws) => {
      sockets.push(ws);
    });
    await page.addInitScript(() => {
      window.__appFocused = true;
      Document.prototype.hasFocus = () => window.__appFocused;
    });
    await setupAuthenticatedMailbox(page);
  });

  async function openInbox(page) {
    await page.goto('/mailbox#INBOX');
    await expect(page.locator('[data-conversation-row]').first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => sockets.length, { timeout: 15_000 }).toBeGreaterThan(0);
  }

  function deliverNewMail(
    uid,
    from = 'Alice Sender <alice@example.org>',
    subject = 'Quarterly report',
  ) {
    const frame = JSON.stringify({
      event: 'newMessage',
      mailbox: 'INBOX',
      message: { uid, id: uid, from: { text: from }, subject, snippet: 'Numbers attached' },
    });
    for (const ws of sockets) ws.send(frame);
  }

  test('shows a system notification when the window is open but not focused', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(['notifications'], { origin: baseURL });
    await recordNotifications(page);
    await openInbox(page);

    await page.evaluate(() => {
      window.__appFocused = false;
    });
    deliverNewMail('9101');

    await expect
      .poll(() => page.evaluate(() => window.__shownNotifications))
      .toEqual([
        expect.objectContaining({
          title: 'Alice Sender',
          body: 'Quarterly report\nNumbers attached',
        }),
      ]);
    await expect(page.getByText('New email from Alice Sender')).toHaveCount(0);
  });

  test('shows an in-app toast instead when the user is in the app', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(['notifications'], { origin: baseURL });
    await recordNotifications(page);
    await openInbox(page);

    deliverNewMail('9102');

    await expect(page.getByText('New email from Alice Sender: Quarterly report')).toBeVisible();
    expect(await page.evaluate(() => window.__shownNotifications)).toEqual([]);
  });

  test('without permission, tells the user about the mail when they come back', async ({
    page,
  }) => {
    await recordNotifications(page);
    await openInbox(page);

    await page.evaluate(() => {
      window.__appFocused = false;
    });
    deliverNewMail('9103');
    await page.waitForTimeout(1_000);
    await expect(page.getByText('New email from Alice Sender')).toHaveCount(0);

    await page.evaluate(() => {
      window.__appFocused = true;
      window.dispatchEvent(new Event('focus'));
    });

    await expect(page.getByText('New email from Alice Sender: Quarterly report')).toBeVisible();
    expect(await page.evaluate(() => window.__shownNotifications)).toEqual([]);
  });
});
