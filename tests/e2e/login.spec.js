import { expect, test } from '@playwright/test';

test('shows the login view by default', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Webmail', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeEnabled();
});

test('redirects unauthenticated users from mailbox to login', async ({ page }) => {
  await page.goto('/mailbox');

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('Webmail', { exact: true })).toBeVisible();
});
