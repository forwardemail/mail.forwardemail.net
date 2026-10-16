import { expect, test } from '@playwright/test';
import { mockApi } from './mockApi.js';
import {
  buildMessage,
  installAccountServers,
  installMockSocket,
  row,
} from '../fixtures/state-helpers.js';

// Two accounts signed in to one tab. Signing out of one must leave the other
// signed in, showing its own mail, and sending its own credentials.

const ALICE = { email: 'alice@example.com', password: 'alice-Pa55word' };
const BOB = { email: 'bob@example.net', password: 'bob-Pa55word' };
const basic = ({ email, password }) =>
  `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;

const mailbox = (prefix, unread = []) =>
  Array.from({ length: 6 }, (_, i) => {
    const n = i + 1;
    return buildMessage(n, {
      id: `${prefix.toLowerCase()}-${n}`,
      subject: `${prefix} mail ${n}`,
      unread: unread.includes(n),
    });
  });

async function signInWithForm(page, { email, password }) {
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
}

const accountButton = (page) => page.getByTestId('mailbox-sidebar').getByRole('button').nth(1);

test.describe('Two accounts in one tab', () => {
  test.skip(({ isMobile }) => isMobile, 'Uses the desktop sidebar account menu');

  test('signing out of one account leaves the other signed in and working', async ({ page }) => {
    test.setTimeout(60_000);
    await mockApi(page);
    await installMockSocket(page);
    const servers = await installAccountServers(page, {
      [ALICE.email]: { password: ALICE.password, messages: mailbox('Alice', [2]) },
      [BOB.email]: { password: BOB.password, messages: mailbox('Bob') },
    });

    await page.goto('/');
    await signInWithForm(page, ALICE);
    await expect(row(page, 'Alice mail 1')).toBeVisible({ timeout: 15_000 });

    await accountButton(page).click();
    await page.getByRole('button', { name: 'Add account' }).click();
    await expect(page).toHaveURL(/add_account=true/);
    await signInWithForm(page, BOB);
    await expect(row(page, 'Bob mail 1')).toBeVisible({ timeout: 15_000 });
    await expect(row(page, 'Alice mail 1')).toHaveCount(0);
    await expect(accountButton(page)).toHaveText(BOB.email);

    await accountButton(page).click();
    await page.getByRole('button', { name: `Sign out ${BOB.email}` }).click();

    // Back on Alice's mailbox, not the sign-in screen.
    await expect(row(page, 'Alice mail 1')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/mailbox/);
    await expect(accountButton(page)).toHaveText(ALICE.email);
    await expect(row(page, 'Bob mail 1')).toHaveCount(0);
    const signedOutAt = servers[BOB.email].log.length;

    // Alice's account still works: opening her unread message reads it on her
    // server, with her credentials.
    await row(page, 'Alice mail 2').click();
    await expect(page.locator('.fe-reader').getByText('Alice mail 2').first()).toBeVisible();
    await expect.poll(() => servers[ALICE.email].get('alice-2').flags).toContain('\\Seen');
    const change = servers[ALICE.email].changesFor('alice-2');
    expect(change).toHaveLength(1);
    expect(change[0].auth).toBe(basic(ALICE));

    // And she is still signed in after a reload; Bob is gone from the menu.
    await page.goto('about:blank');
    await page.goto('/mailbox#INBOX');
    await expect(row(page, 'Alice mail 1')).toBeVisible({ timeout: 15_000 });
    await accountButton(page).click();
    await expect(page.getByRole('button', { name: `Sign out ${ALICE.email}` })).toBeVisible();
    await expect(page.getByRole('button', { name: BOB.email })).toHaveCount(0);

    // Nothing was sent as Bob after he signed out.
    expect(servers[BOB.email].log.slice(signedOutAt)).toEqual([]);
  });
});
