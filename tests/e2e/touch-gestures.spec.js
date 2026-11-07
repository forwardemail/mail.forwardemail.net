import { expect, test } from '@playwright/test';
import {
  isMobileProject,
  navigateToMailbox,
  setupAuthenticatedMailbox,
} from '../fixtures/mailbox-helpers.js';

// Swipe a row to archive or delete it, pull the list to refresh, and swipe
// in an open message to the next one. These were set by the phone width
// alone, so a tablet, or a phone turned sideways, had none of them. And a
// sideways drag on a row was left to the browser, which Chrome took for a
// swipe back to the page before.

const touchDevice = (width, height) => ({
  viewport: { width, height },
  hasTouch: true,
  isMobile: true,
});

// A real touch, through Chromium's input pipeline, from one point to another.
async function drag(page, from, to, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await send('touchStart', [from]);
  for (let i = 1; i <= steps; i += 1) {
    await send('touchMove', [
      {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      },
    ]);
  }
  await send('touchEnd', []);
  await cdp.detach();
}

/** A sideways swipe across the middle of an element. */
async function swipeAcross(page, locator, direction) {
  const box = await locator.boundingBox();
  const y = box.y + box.height / 2;
  const start = box.x + box.width * (direction === 'right' ? 0.35 : 0.65);
  const end = start + (direction === 'right' ? 220 : -220);
  await drag(page, { x: start, y }, { x: end, y });
}

const rowFor = (page, subject) =>
  page.locator('[data-conversation-row]').filter({ hasText: subject });

const mutation = (page, id) =>
  page.waitForRequest(
    (request) => request.method() !== 'GET' && request.url().includes(`/v1/messages/${id}`),
  );

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo), 'Sets its own touch devices');
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await setupAuthenticatedMailbox(page);
  await navigateToMailbox(page);
  await expect(page.locator('[data-conversation-row]').first()).toBeVisible();
});

for (const [name, width, height] of [
  ['tablet in portrait', 820, 1180],
  ['tablet in landscape', 1180, 820],
  ['phone turned sideways', 915, 412],
]) {
  test.describe(name, () => {
    test.use(touchDevice(width, height));

    test('swiping a row right archives it', async ({ page }) => {
      const row = rowFor(page, 'Welcome to Webmail');
      const archived = mutation(page, 'msg-1');
      await swipeAcross(page, row, 'right');

      expect((await archived).postDataJSON()).toMatchObject({ folder: 'Archive' });
      await expect(row).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe('/mailbox');
    });

    test('swiping a row left deletes it', async ({ page }) => {
      const row = rowFor(page, 'Your calendar invite');
      const deleted = mutation(page, 'msg-2');
      await swipeAcross(page, row, 'left');

      await deleted;
      await expect(row).toHaveCount(0);
    });

    test('pulling the list down refreshes it', async ({ page }) => {
      const list = await page.locator('.fe-message-list-wrapper').boundingBox();
      const x = list.x + list.width / 2;
      await drag(page, { x, y: list.y + 20 }, { x, y: list.y + 320 }, 20);

      await expect(page.getByText('Inbox refreshed')).toBeVisible();
    });
  });
}

for (const [name, width, height] of [
  ['tablet in portrait', 820, 1180],
  ['tablet in landscape', 1180, 820],
]) {
  test.describe(`${name}, reading`, () => {
    test.use(touchDevice(width, height));

    /** Opens a message and swipes across the reader, level with its subject. */
    async function openAndSwipe(page, subject, direction) {
      await rowFor(page, subject).tap();
      const reader = page.getByTestId('reader-pane');
      const heading = reader.getByText(subject, { exact: true }).first();
      await expect(heading).toBeVisible();
      // (the reader slides in where it covers the whole screen)
      await reader.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const pane = await reader.boundingBox();
      const y = (await heading.boundingBox()).y + 8;
      const [from, to] = direction === 'left' ? [0.8, 0.2] : [0.2, 0.8];
      await drag(page, { x: pane.x + pane.width * from, y }, { x: pane.x + pane.width * to, y });
      return reader;
    }

    test('swiping left in a message opens the next one', async ({ page }) => {
      const reader = await openAndSwipe(page, 'Welcome to Webmail', 'left');

      await expect(page).toHaveURL(/#INBOX\/msg-2$/);
      await expect(reader.getByText('Your calendar invite', { exact: true }).first()).toBeVisible();
    });

    test('swiping right in a message opens the one before', async ({ page }) => {
      const reader = await openAndSwipe(page, 'Your calendar invite', 'right');

      await expect(page).toHaveURL(/\/mailbox#INBOX\/msg-1$/);
      await expect(reader.getByText('Welcome to Webmail', { exact: true }).first()).toBeVisible();
    });
  });
}
