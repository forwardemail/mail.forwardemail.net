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
        // Sender and subject, without the preview, unless the user chose
        // more under Privacy & Security > Notification privacy.
        expect.objectContaining({ title: 'Alice Sender', body: 'Quarterly report' }),
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

// Privacy & Security > Notification privacy (issue #113): how much of a new
// email its notification shows. App Lock is off here, so the "While unlocked"
// choice applies to every notification.
test.describe('Notification privacy', () => {
  let sockets;

  const choose = (page, value) =>
    page.addInitScript((level) => {
      try {
        localStorage.setItem('webmail_notification_preview_unlocked', level);
      } catch {
        // sandboxed email frame
      }
    }, value);

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

  async function deliverInBackground(page) {
    await page.goto('/mailbox#INBOX');
    await expect(page.locator('[data-conversation-row]').first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => sockets.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.evaluate(() => {
      window.__appFocused = false;
    });
    const frame = JSON.stringify({
      event: 'newMessage',
      mailbox: 'INBOX',
      message: {
        uid: '9201',
        id: '9201',
        from: { text: 'Alice Sender <alice@example.org>' },
        subject: 'Quarterly report',
        snippet: 'Numbers attached',
      },
    });
    for (const ws of sockets) ws.send(frame);
  }

  test('shows the preview when the user chose it', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['notifications'], { origin: baseURL });
    await recordNotifications(page);
    await choose(page, 'full');
    await deliverInBackground(page);

    await expect
      .poll(() => page.evaluate(() => window.__shownNotifications))
      .toEqual([
        expect.objectContaining({
          title: 'Alice Sender',
          body: 'Quarterly report\nNumbers attached',
        }),
      ]);
  });

  test('names neither sender nor subject when the user chose nothing', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(['notifications'], { origin: baseURL });
    await recordNotifications(page);
    await choose(page, 'none');
    await deliverInBackground(page);

    await expect
      .poll(() => page.evaluate(() => window.__shownNotifications))
      .toEqual([expect.objectContaining({ title: 'New email', body: '' })]);
    const shown = JSON.stringify(await page.evaluate(() => window.__shownNotifications));
    expect(shown).not.toMatch(/Alice|Quarterly|Numbers/);
  });

  test('while App Lock has the app locked, says only that new mail arrived', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/mailbox/settings#privacy');
    await page.getByRole('button', { name: 'Enable App Lock' }).click();
    await page.getByPlaceholder(/Enter \d-digit PIN/).fill('135790');
    await page.getByPlaceholder('Confirm PIN').fill('135790');
    await page.getByRole('button', { name: 'Set PIN & Enable' }).click();
    await expect(page.getByText('App lock enabled successfully')).toBeVisible({ timeout: 30_000 });
    // With App Lock on, the card explains when each choice applies.
    await expect(page.getByTestId('notification-privacy')).toContainText(
      'When App Lock has locked the app, or the app is closed.',
    );

    await page.goto('/mailbox#INBOX');
    await expect(page.locator('[data-conversation-row]').first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => sockets.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fe:lock-app')));
    await expect(page.getByText('Enter your PIN to unlock')).toBeVisible();

    const frame = JSON.stringify({
      event: 'newMessage',
      mailbox: 'INBOX',
      message: {
        uid: '9301',
        id: '9301',
        from: { text: 'Alice Sender <alice@example.org>' },
        subject: 'Quarterly report',
      },
    });
    for (const ws of sockets) ws.send(frame);

    await expect(page.getByText('New email', { exact: true })).toBeVisible();
    await expect(page.getByText(/Alice Sender|Quarterly report/)).toHaveCount(0);
  });

  test('the Privacy & Security card saves each choice and shows an example', async ({ page }) => {
    await page.goto('/mailbox/settings#privacy');
    const card = page.getByTestId('notification-privacy');
    await expect(card).toBeVisible({ timeout: 15_000 });

    // The defaults the issue asks for, with App Lock off.
    await expect(card.locator('#notification_preview_unlocked-select')).toHaveText(
      'Sender and subject',
    );
    await expect(card.locator('#notification_preview_locked-select')).toHaveText(
      'Nothing, just "New email"',
    );
    await expect(card).toContainText('Takes effect when you turn on App Lock above.');

    await card.locator('#notification_preview_unlocked-select').click();
    await page.getByRole('option', { name: 'Sender only' }).click();
    await expect(card.getByTestId('notification_preview_unlocked-example')).toHaveText(
      'Alex Rivera',
    );
    await expect(page.getByText('While unlocked: Sender only')).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem('webmail_notification_preview_unlocked')),
    ).toBe('sender');

    await page.reload();
    await expect(
      page.getByTestId('notification-privacy').locator('#notification_preview_unlocked-select'),
    ).toHaveText('Sender only');
  });
});
