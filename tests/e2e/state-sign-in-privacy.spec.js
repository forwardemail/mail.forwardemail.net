import { expect, test } from '@playwright/test';
import { mockApi } from './mockApi.js';
import {
  ACCOUNT,
  buildMessage,
  installMailServer,
  installMockSocket,
  row,
} from '../fixtures/state-helpers.js';

// "Stay signed in" decides whether the alias password outlives the tab.
// Unchecked, it must only ever be in this tab's sessionStorage: nothing a
// browser restart keeps (localStorage, IndexedDB) may hold it, and another tab
// must not be signed in. Checked, a restart comes back signed in.

const PASSWORD = 'Corr3ct-Horse-Battery-77';
const BASIC = Buffer.from(`${ACCOUNT}:${PASSWORD}`).toString('base64');

async function mockBackend(page) {
  await mockApi(page);
  await installMockSocket(page);
  return installMailServer(page, {
    messages: Array.from({ length: 5 }, (_, i) => buildMessage(i + 1, { unread: i === 1 })),
  });
}

const loginCard = (page) => page.locator('#login-root');

async function signIn(page, { staySignedIn }) {
  await page.goto('/');
  await page.getByPlaceholder('you@example.com').fill(ACCOUNT);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  const stay = page.getByRole('checkbox', { name: 'Stay signed in' });
  if ((await stay.getAttribute('aria-checked')) !== String(staySignedIn)) await stay.click();
  await expect(stay).toHaveAttribute('aria-checked', String(staySignedIn));
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/mailbox/);
  await expect(row(page, 'Message 0001')).toBeVisible({ timeout: 15_000 });
}

// Every place in the origin's storage that holds the password, in plain text
// or inside the Basic auth value built from it.
async function wherePasswordIs(page) {
  return page.evaluate(
    async ({ password, basic }) => {
      const holds = (value) =>
        typeof value === 'string' && (value.includes(password) || value.includes(basic));
      const found = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (holds(localStorage.getItem(key))) found.push(`localStorage:${key}`);
      }
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (holds(sessionStorage.getItem(key))) found.push(`sessionStorage:${key}`);
      }
      for (const info of await indexedDB.databases()) {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(info.name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        for (const store of db.objectStoreNames) {
          const rows = await new Promise((resolve) => {
            const req = db.transaction(store, 'readonly').objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve([]);
          });
          if (rows.some((r) => holds(JSON.stringify(r))))
            found.push(`indexedDB:${info.name}/${store}`);
        }
        db.close();
      }
      return found;
    },
    { password: PASSWORD, basic: BASIC },
  );
}

// What a browser restart keeps: cookies, localStorage and IndexedDB, but not
// sessionStorage. A new context built from that state is the restarted browser.
async function restartBrowser(browser, page) {
  const state = await page.context().storageState({ indexedDB: true });
  const context = await browser.newContext({ storageState: state });
  const restarted = await context.newPage();
  await mockBackend(restarted);
  return { context, page: restarted };
}

test.describe('Sign-in privacy', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop only');

  test('without "Stay signed in" the password stays in this tab only', async ({
    page,
    browser,
  }) => {
    const server = await mockBackend(page);
    await signIn(page, { staySignedIn: false });

    // The sign-in check went to the server with these credentials.
    expect(server.folderLists()[0]?.auth).toBe(`Basic ${BASIC}`);

    const found = await wherePasswordIs(page);
    expect(found.some((place) => place.startsWith('sessionStorage:'))).toBe(true);
    expect(found.filter((place) => !place.startsWith('sessionStorage:'))).toEqual([]);

    // Another tab in the same browser is not signed in.
    const otherTab = await page.context().newPage();
    await mockBackend(otherTab);
    await otherTab.goto('/mailbox');
    await expect(otherTab).toHaveURL(/\/$/);
    await expect(loginCard(otherTab).getByPlaceholder('you@example.com')).toBeVisible();
    await otherTab.close();

    // Nor is the browser after a restart.
    const restarted = await restartBrowser(browser, page);
    try {
      await restarted.page.goto('/mailbox');
      await expect(restarted.page).toHaveURL(/\/$/);
      await expect(loginCard(restarted.page).getByPlaceholder('you@example.com')).toBeVisible();
      expect(await wherePasswordIs(restarted.page)).toEqual([]);
    } finally {
      await restarted.context.close();
    }

    // A browser that shares nothing at all is at the sign-in screen too.
    const fresh = await browser.newContext();
    try {
      const freshPage = await fresh.newPage();
      await mockBackend(freshPage);
      await freshPage.goto('/mailbox');
      await expect(freshPage).toHaveURL(/\/$/);
      await expect(loginCard(freshPage).getByPlaceholder('you@example.com')).toBeVisible();
    } finally {
      await fresh.close();
    }

    // This tab is still signed in and working.
    await page.reload();
    await expect(row(page, 'Message 0001')).toBeVisible({ timeout: 15_000 });
  });

  test('with "Stay signed in" a restart comes back signed in', async ({ page, browser }) => {
    await mockBackend(page);
    await signIn(page, { staySignedIn: true });

    // The same search that finds nothing above does find the saved password,
    // so an empty result there means something.
    const found = await wherePasswordIs(page);
    expect(found.some((place) => place.startsWith('localStorage:'))).toBe(true);

    const restarted = await restartBrowser(browser, page);
    try {
      await restarted.page.goto('/mailbox');
      await expect(row(restarted.page, 'Message 0001')).toBeVisible({ timeout: 15_000 });
      await expect(restarted.page).toHaveURL(/\/mailbox/);
    } finally {
      await restarted.context.close();
    }
  });
});
