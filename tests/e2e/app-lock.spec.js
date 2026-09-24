import { expect, test } from '@playwright/test';
import { setupAuthenticatedMailbox, navigateToMailbox } from '../fixtures/mailbox-helpers.js';

// App Lock end to end: set a PIN, lock, unlock with the keypad. Covers the
// regressions behind "the PIN pad is glitchy" and "Search index failed to
// build right after unlocking".

const PIN = '135790';

async function enableAppLock(page) {
  await page.goto('/mailbox/settings#privacy');
  await page.getByRole('button', { name: 'Enable App Lock' }).click();
  await page.getByPlaceholder(/Enter \d-digit PIN/).fill(PIN);
  await page.getByPlaceholder('Confirm PIN').fill(PIN);
  await page.getByRole('button', { name: 'Set PIN & Enable' }).click();
  // The vault derives its key once (Argon2id, a few seconds).
  await expect(page.getByText('App lock enabled successfully')).toBeVisible({ timeout: 30_000 });
}

async function lockNow(page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fe:lock-app')));
  await expect(page.getByText('Enter your PIN to unlock')).toBeVisible();
}

async function typePin(page, pin) {
  const pad = page.getByRole('group', { name: 'PIN keypad' });
  for (const digit of pin) {
    await pad.getByRole('button', { name: digit, exact: true }).click();
  }
}

test.describe('App Lock', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedMailbox(page);
    await navigateToMailbox(page);
  });

  test('locks, rejects a wrong PIN, and unlocks cleanly with the keypad', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack || error.message));

    await enableAppLock(page);
    await page.goto('/mailbox#INBOX');
    await expect(page.locator('[data-conversation-row]').first()).toBeVisible({
      timeout: 15_000,
    });

    await lockNow(page);

    // The app behind the lock cannot be reached.
    await expect(page.locator('#mailbox-root')).toHaveAttribute('inert', '');

    await typePin(page, '246802');
    await expect(page.locator('#app-lock-overlay').getByRole('alert')).toContainText(
      'Incorrect PIN',
      {
        timeout: 30_000,
      },
    );

    await typePin(page, PIN);
    await expect(page.getByText('Enter your PIN to unlock')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('#mailbox-root')).not.toHaveAttribute('inert', '');
    await expect(page.locator('[data-conversation-row]').first()).toBeVisible();

    // Give the post-unlock work (reload, search resume) time to settle.
    await page.waitForTimeout(3_000);
    await expect(page.getByText('Search index build failed')).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
