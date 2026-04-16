import { expect, test } from '@playwright/test';

/**
 * Cross-platform smoke test: the app loads and shows the login screen.
 * Runs on every Playwright project (chromium/firefox/webkit + mobile + Tauri).
 * Any regression here is a red-alert blocker across platforms.
 */
test.describe('smoke: login loads', () => {
  test('renders the login view', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Webmail', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeEnabled();
  });

  test('unauthenticated /mailbox redirects to login', async ({ page }) => {
    await page.goto('/mailbox');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Webmail', { exact: true })).toBeVisible();
  });

  test('no console errors at boot', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Filter out known-benign boot-time noise:
    //  - favicon / manifest / SW misses (preview server doesn't serve all PWA assets)
    //  - 403 / 401 responses (no auth in smoke tests — API rejection is expected)
    const signal = errors.filter(
      (e) => !/favicon|sw.*not.*found|manifest|status of 40[13]/i.test(e),
    );
    expect(signal, signal.join('\n')).toEqual([]);
  });
});
