import { expect, test } from '@playwright/test';
import {
  goBackToList,
  isMobileProject,
  setupAuthenticatedMailbox,
} from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// A message read once is served from the body cache when it is opened again.
// When that cache is skipped, every reopen downloads the raw message and
// renders it from scratch, which on a real mailbox takes a second or more.

const reader = (page) => page.locator('.fe-reader');

async function openRow(page, subject) {
  await row(page, subject).click();
  await expect(reader(page).getByText(subject).first()).toBeVisible();
}

test.describe('Reader body cache', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop reader layout');
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    await installMailServer(page, {
      messages: [buildMessage(1), buildMessage(2, { subject: 'Quarterly report' })],
    });
  });

  test('reopening a message just read does not download it again', async ({ page }) => {
    const detailFetches = new Map();
    page.on('request', (req) => {
      if (req.method() !== 'GET') return;
      const id = new URL(req.url()).pathname.match(/^\/v1\/messages\/([^/]+)$/)?.[1];
      if (id) detailFetches.set(id, (detailFetches.get(id) || 0) + 1);
    });

    await openMailbox(page, 'Message 0001');
    await openRow(page, 'Message 0001');
    await goBackToList(page);
    await openRow(page, 'Quarterly report');
    await goBackToList(page);

    // The body is cached after it is shown; wait for that write rather than
    // reopening before it can have landed.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise((resolve) => {
              const open = indexedDB.open('webmail-cache-v1');
              open.onerror = () => resolve(-1);
              open.onsuccess = () => {
                const req = open.result
                  .transaction('messageBodies', 'readonly')
                  .objectStore('messageBodies')
                  .count();
                req.onsuccess = () => {
                  open.result.close();
                  resolve(req.result);
                };
                req.onerror = () => resolve(-1);
              };
            }),
        ),
      )
      .toBeGreaterThanOrEqual(2);

    const before = detailFetches.get('msg-1') || 0;
    expect(before).toBeGreaterThan(0);
    await openRow(page, 'Message 0001');
    // Long enough for a cache miss to have gone to the network.
    await page.waitForTimeout(750);
    expect(detailFetches.get('msg-1') || 0).toBe(before);
  });
});
