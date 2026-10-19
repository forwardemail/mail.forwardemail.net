import { expect, test } from '@playwright/test';
import { setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// Scrolling to the end of the list loads the next page from the server, until
// the folder runs out. The server pages 50 at a time.

const TOTAL = 180;
const subject = (n) => `Message ${String(n).padStart(4, '0')}`;

// Scroll the list to its end until the row shows up or the list stops growing
async function scrollUntil(page, n) {
  const target = row(page, subject(n));
  for (let i = 0; i < 40; i++) {
    if (await target.count()) return;
    await page.locator('[data-conversation-row]').last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
  }
}

for (const engine of ['db worker', 'main-thread db']) {
  test(`scrolling to the end loads every page (${engine})`, async ({ page }) => {
    test.setTimeout(120_000);
    // A database worker that cannot start leaves the app on its main-thread
    // engine, which is what a slow IndexedDB open falls back to.
    if (engine === 'main-thread db') await page.route(/db\.worker/, (route) => route.abort());
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    await installMailServer(page, {
      messages: Array.from({ length: TOTAL }, (_, i) => buildMessage(i + 1)),
    });
    await openMailbox(page, subject(1));

    for (const n of [60, 110, 160, TOTAL]) {
      await scrollUntil(page, n);
      await expect(row(page, subject(n))).toHaveCount(1);
    }
    await expect(page.locator('[data-conversation-row]')).toHaveCount(TOTAL);
  });
}
