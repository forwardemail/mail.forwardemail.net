import { expect, test } from '@playwright/test';

// Scoped to the login card: the hidden app-lock boot cover in index.html also
// carries the exact text "Forward Email" and strict mode counts hidden matches.
test('shows the login view by default', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.locator('#login-root').getByText('Forward Email', { exact: true }),
  ).toBeVisible();
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeEnabled();
});

test('redirects unauthenticated users from mailbox to login', async ({ page }) => {
  await page.goto('/mailbox');

  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.locator('#login-root').getByText('Forward Email', { exact: true }),
  ).toBeVisible();
});
