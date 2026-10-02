/**
 * App Store and Google Play builds hide billing and sign-up links
 * (src/utils/store-policy.js; App Review Guidelines 3.1.1 and 3.1.3(f), and
 * Google Play's Payments policy). This spec runs the real app in Chromium as
 * the iOS app, with the Tauri globals stubbed the way the platform module
 * reads them, and as the web app, which keeps every link.
 */
import { test, expect } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  isMobileProject,
} from '../fixtures/mailbox-helpers.js';

const BILLING_URL = 'https://forwardemail.net/my-account/billing';

const APPS = [
  { name: 'iOS app', store: true },
  { name: 'web app', store: false },
];

async function openAs(page, app) {
  if (!app.store) return;
  await page.addInitScript(() => {
    window.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: 'ios' };
    window.__TAURI_INTERNALS__ = {
      invoke: async () => null,
      transformCallback: () => 0,
      unregisterCallback() {},
      convertFileSrc: (p) => p,
      postMessage() {},
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main', windowLabel: 'main' },
        windows: [{ label: 'main' }],
        webviews: [{ label: 'main', windowLabel: 'main' }],
      },
      plugins: {},
    };
  });
}

// An account with a storage quota, so the sidebar meter and the Storage card render.
async function withStorageQuota(page, storageUsed = 1_073_741_824) {
  await page.route(/\/v1\/account(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ storage_used: storageUsed, storage_quota: 10_737_418_240 }),
    }),
  );
}

async function openSettings(page) {
  // (once the storage figures have loaded)
  await expect(page.getByTestId('sidebar-storage')).toHaveCount(1, { timeout: 10_000 });
  await page.getByLabel('Settings').first().click();
  await expect(page.getByRole('button', { name: 'Delete account' })).toBeVisible({
    timeout: 10_000,
  });
}

test.beforeEach(({ page }, testInfo) => {
  // Playwright requires a destructured fixture parameter here.
  void page;
  test.skip(isMobileProject(testInfo), 'The platform comes from the stub, not the viewport');
});

for (const app of APPS) {
  test.describe(app.name, () => {
    test(`sign-in screen ${app.store ? 'leaves out' : 'shows'} the sign-up link`, async ({
      page,
    }) => {
      await openAs(page, app);
      await page.goto('/');

      await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Sign up' })).toHaveCount(app.store ? 0 : 1);
    });

    test(`storage meter ${app.store ? 'is not' : 'is'} a billing link`, async ({ page }) => {
      await openAs(page, app);
      await setupAuthenticatedMailbox(page);
      await withStorageQuota(page);
      await navigateToMailbox(page);

      const meter = page.getByTestId('sidebar-storage');
      await expect(meter).toHaveCount(1, { timeout: 10_000 });
      await expect(meter).toContainText('1 GB');
      if (app.store) {
        await expect(meter).not.toHaveAttribute('href');
        await expect(page.locator(`a[href="${BILLING_URL}"]`)).toHaveCount(0);
      } else {
        await expect(meter).toHaveAttribute('href', BILLING_URL);
      }
    });

    test(`settings ${app.store ? 'leave out' : 'show'} Increase storage`, async ({ page }) => {
      await openAs(page, app);
      await setupAuthenticatedMailbox(page);
      await withStorageQuota(page);
      await navigateToMailbox(page);
      await openSettings(page);

      await expect(page.getByText('1 GB of 10 GB')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Increase storage' })).toHaveCount(
        app.store ? 0 : 1,
      );
    });

    test(`a nearly full mailbox ${app.store ? 'asks to free up space' : 'suggests upgrading'}`, async ({
      page,
    }) => {
      await openAs(page, app);
      await setupAuthenticatedMailbox(page);
      await withStorageQuota(page, 10_200_547_328); // 95%
      await navigateToMailbox(page);
      await openSettings(page);
      await page.getByRole('button', { name: 'Advanced', exact: true }).click();

      await expect(page.getByText(/^Mailbox storage almost full/)).toHaveText(
        app.store
          ? 'Mailbox storage almost full. Delete emails or empty Trash to free up space.'
          : 'Mailbox storage almost full! Consider upgrading your plan.',
        { timeout: 10_000 },
      );
    });

    test(`demo welcome message ${app.store ? 'asks to sign in' : 'links to sign-up'}`, async ({
      page,
    }) => {
      await openAs(page, app);
      await page.goto('/');
      await page.getByRole('button', { name: 'Try Demo' }).click();
      await page
        .locator('[data-conversation-row]')
        .filter({ hasText: 'Welcome to Forward Email!' })
        .first()
        .click();

      const body = page.frameLocator('iframe.fe-email-iframe').first().locator('body');
      await expect(body).toContainText('Thanks for trying out Forward Email webmail.', {
        timeout: 10_000,
      });
      if (app.store) {
        await expect(body).toContainText(
          'To use your own account, sign out of the demo and sign in with your Forward Email address.',
        );
        await expect(body.locator('a')).toHaveCount(0);
      } else {
        await expect(body.locator('a[href="https://forwardemail.net"]')).toHaveCount(1);
      }
    });
  });
}
