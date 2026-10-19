import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// Archiving must look like an offline app: the row leaves once and does not
// come back, even while the server's list still reports the message in the
// inbox (its indexer lags the move by 10-30 seconds in production).

function seedMessages() {
  return Array.from({ length: 8 }, (_, i) => {
    const n = i + 1;
    return buildMessage(n, { unread: n >= 2 && n <= 4 });
  });
}

// Records each time a row with this subject appears or disappears, from now
// on. A row that leaves and comes back shows up as true, false, true.
async function watchRow(page, subject) {
  await page.evaluate((text) => {
    const seen = [];
    const check = () => {
      const present = [...document.querySelectorAll('[data-conversation-row]')].some((el) =>
        el.textContent.includes(text),
      );
      if (seen[seen.length - 1] !== present) seen.push(present);
    };
    check();
    new MutationObserver(check).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__rowSeen = seen;
  }, subject);
}

const rowHistory = (page) => page.evaluate(() => window.__rowSeen);

async function contextAction(page, subject, name) {
  await row(page, subject).click({ button: 'right' });
  await page.locator('[data-context-menu]').getByRole('button', { name, exact: true }).click();
}

async function openFolder(page, path) {
  await page.locator(`[data-testid="folder-item"][data-folder-path="${path}"] > button`).click();
}

test.describe('Archive keeps the list steady', () => {
  let server;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Uses the desktop row context menu');
    test.setTimeout(60_000);
    // Side-by-side reader, so the list stays on screen while a message is open
    await page.addInitScript(() => {
      localStorage.setItem('webmail_layout_mode', 'classic');
      localStorage.setItem('webmail_layout_mode_test@example.com', 'classic');
    });
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    server = await installMailServer(page, { messages: seedMessages(), indexLag: 30_000 });
    await openMailbox(page, 'Message 0001');
  });

  test('an archived row does not come back while the server still lists it', async ({ page }) => {
    await watchRow(page, 'Message 0006');
    await contextAction(page, 'Message 0006', 'Archive');
    await expect(row(page, 'Message 0006')).toHaveCount(0);
    await expect.poll(() => server.get('msg-6').folder_path).toBe('Archive');

    // A reload of the inbox inside the lag window, while its list still has it
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForTimeout(1500);
    expect(await rowHistory(page)).toEqual([true, false]);

    // In Archive it shows, and stays, though the server's Archive list does
    // not have it yet
    await openFolder(page, 'Archive');
    await expect(row(page, 'Message 0006')).toBeVisible();
    await watchRow(page, 'Message 0006');
    await page.waitForTimeout(1500);
    expect(await rowHistory(page)).toEqual([true]);

    // And back in the inbox it is still gone
    await openFolder(page, 'INBOX');
    await expect(row(page, 'Message 0001')).toBeVisible();
    await watchRow(page, 'Message 0006');
    await page.waitForTimeout(1500);
    expect(await rowHistory(page)).toEqual([false]);
  });

  test('archiving the open message keeps it gone when the next one is unread', async ({ page }) => {
    // Opening the neighbour marks it read, which wrote the list back with the
    // archived row still in it.
    await row(page, 'Message 0005').click();
    await watchRow(page, 'Message 0005');
    await page.keyboard.press('e');
    await expect(row(page, 'Message 0005')).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(await rowHistory(page)).toEqual([true, false]);
    // The reader moved on to a neighbour, not to the top of the list
    await expect(page.locator('[data-conversation-row][aria-selected="true"]')).toHaveCount(1);
  });
});
