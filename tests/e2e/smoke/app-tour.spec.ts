import { expect, test } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  isMobileProject,
} from '../../fixtures/mailbox-helpers.js';

/**
 * Walk every main screen with a signed-in session and fail on any uncaught
 * exception. Runs on every Playwright project, including the WebKit/iPhone
 * one in CI, which is the closest the browser suite gets to the iOS app's
 * WKWebView.
 *
 * Only uncaught exceptions (pageerror) count. Console errors are expected
 * here: the mock backend answers some endpoints with empty bodies.
 */

const collectPageErrors = (page) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));
  return errors;
};

async function openFirstMessage(page) {
  const row = page.locator('[data-conversation-row]').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await page.waitForTimeout(800);
}

async function visit(page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1_200);
}

test.describe('smoke: app tour', () => {
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
  });

  test('mailbox, reader, compose, settings, calendar and contacts raise no errors', async ({
    page,
    browserName,
  }, testInfo) => {
    // The message list is fetched by the sync Web Worker, and Playwright can
    // only mock worker requests in Chromium; under WebKit the list never
    // leaves its loading state against the mock API.
    test.skip(browserName === 'webkit', 'worker requests cannot be mocked in WebKit');
    const errors = collectPageErrors(page);

    await navigateToMailbox(page);
    await openFirstMessage(page);

    // Compose opens and closes cleanly.
    if (isMobileProject(testInfo)) {
      await page.goto('/mailbox#INBOX');
      await page.waitForTimeout(600);
      await page.locator('.fe-mobile-tabbar').getByLabel('Compose').click();
    } else {
      await page.keyboard.press('Escape');
      await page
        .getByRole('button', { name: /compose/i })
        .first()
        .click();
    }
    await expect(page.getByPlaceholder('Subject').first()).toBeVisible({ timeout: 5_000 });
    await page.getByPlaceholder('Subject').first().fill('Tour');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // Other folders, then the remaining top-level screens.
    await visit(page, '/mailbox#Sent');
    await visit(page, '/mailbox#Trash');
    for (const section of [
      'general',
      'appearance',
      'privacy',
      'folders',
      'filters',
      'calendar',
      'search',
      'advanced',
      'shortcuts',
      'help',
    ]) {
      await visit(page, `/mailbox/settings#${section}`);
    }
    await visit(page, '/calendar');
    await visit(page, '/contacts');
    await visit(page, '/mailbox#INBOX');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('hand-edited links with broken escapes do not break routing', async ({ page }) => {
    const errors = collectPageErrors(page);

    await navigateToMailbox(page);
    await page.evaluate(() => {
      window.location.hash = 'INBOX%E0%A4%A/abc';
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.location.hash = 'search=%E0%A4%A';
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.location.hash = 'compose?mailto=mailto%3Aa%40b.com%E0%A4%A';
    });
    await page.waitForTimeout(800);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
