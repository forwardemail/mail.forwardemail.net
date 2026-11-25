import { expect, test } from '@playwright/test';
import { isMobileProject, setupAuthenticatedMailbox } from '../fixtures/mailbox-helpers.js';
import {
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
  row,
} from '../fixtures/state-helpers.js';

// Desktop mailbox chrome: where the row context menu opens, the reader
// toolbar's tooltips against the pinned subject header, the hand pointer on
// links in a message, and the list/reader divider keeping its place.

const LINK_BODY =
  '<p>Read <a href="https://example.org/a"><span>the notes</span></a> first.</p>' +
  '<p style="height:1400px">filler</p>';

async function useLayout(page, mode) {
  await page.addInitScript((layout) => {
    try {
      localStorage.setItem('webmail_layout_mode', layout);
      localStorage.setItem('webmail_layout_mode_test@example.com', layout);
    } catch {
      // sandboxed frame
    }
  }, mode);
}

test.describe('Mailbox menus and layout', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop layout');
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    await installMailServer(page, {
      // Enough rows to fill the list down to the bottom of the window.
      messages: Array.from({ length: 40 }, (_, i) => buildMessage(i + 1)),
    });
    await page.route(/\/v1\/messages\/msg-1(\?.*)?$/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ...buildMessage(1), html: LINK_BODY, attachments: [] }),
          })
        : route.fallback(),
    );
  });

  const menu = (page) => page.locator('[data-context-menu]');

  // Right-clicks the list at a height in the window and returns where the
  // menu opened.
  async function openMenuAt(page, y) {
    const listBox = await row(page, 'Message 0001').boundingBox();
    // Near the left edge of the row, clear of anything floating over the
    // middle of the window.
    const x = listBox.x + 40;
    await page.mouse.click(x, y, { button: 'right' });
    await expect(menu(page)).toBeVisible();
    return { x, y, box: await menu(page).boundingBox() };
  }

  test('the row menu opens at the pointer near the top of the list', async ({ page }) => {
    await useLayout(page, 'classic');
    await openMailbox(page, 'Message 0001');
    const first = await row(page, 'Message 0001').boundingBox();
    const { x, y, box } = await openMenuAt(page, first.y + first.height / 2);
    expect(Math.abs(box.y - y)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.x - x)).toBeLessThanOrEqual(1);
  });

  test('the row menu opens upward from the pointer near the bottom of the window', async ({
    page,
  }) => {
    await useLayout(page, 'classic');
    await openMailbox(page, 'Message 0001');
    const height = page.viewportSize().height;
    const { y, box } = await openMenuAt(page, height - 30);
    // Its bottom edge is at the pointer, not a menu's height above it.
    expect(Math.abs(box.y + box.height - y)).toBeLessThanOrEqual(1);
    expect(box.y).toBeGreaterThanOrEqual(0);
  });

  test('the row menu stays on screen in a window shorter than the menu needs', async ({ page }) => {
    await useLayout(page, 'classic');
    await page.setViewportSize({ width: 1280, height: 420 });
    await openMailbox(page, 'Message 0001');
    // Neither below nor above the pointer has room for the whole menu here.
    const { box } = await openMenuAt(page, 210);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(420);
  });

  test('a reader toolbar tooltip shows over the subject header', async ({ page }) => {
    await useLayout(page, 'full');
    await openMailbox(page, 'Message 0001');
    await row(page, 'Message 0001').click();
    const reader = page.locator('.fe-reader');
    const archive = reader.locator('.fe-reader-toolbar').getByRole('button', { name: 'Archive' });
    await expect(archive).toBeVisible();
    const button = await archive.boundingBox();
    // A strip of the page across the lower half of where the tooltip draws,
    // which is over the subject header. A tooltip under the header leaves
    // the strip as it was (its top edge can still peek out above the header).
    const clip = {
      x: button.x + button.width / 2 - 6,
      y: button.y + button.height + 26,
      width: 12,
      height: 6,
    };
    await page.mouse.move(5, 5);
    const before = await page.screenshot({ clip });
    await archive.hover();
    await expect
      .poll(async () => (await page.screenshot({ clip })).equals(before), { timeout: 3000 })
      .toBe(false);
  });

  test('a link in a message shows the hand pointer, on the element inside it too', async ({
    page,
  }) => {
    await useLayout(page, 'classic');
    await openMailbox(page, 'Message 0001');
    await row(page, 'Message 0001').click();
    const inner = page.frameLocator('iframe.fe-email-iframe').first().locator('a span');
    await inner.waitFor({ timeout: 10_000 });
    expect(await inner.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  });

  test('the list and reader divider keeps its place across a reload', async ({ page }) => {
    await useLayout(page, 'classic');
    await openMailbox(page, 'Message 0001');
    const list = page.locator('.fe-messages');
    const handle = page.locator('.fe-vertical-resizer');
    const startWidth = (await list.boundingBox()).width;
    const grip = await handle.boundingBox();
    const gripY = grip.y + grip.height / 2;
    await page.mouse.move(grip.x + grip.width / 2, gripY);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 160, gripY, { steps: 5 });
    await page.mouse.up();
    const dragged = (await list.boundingBox()).width;
    expect(dragged).toBeGreaterThan(startWidth + 100);

    await page.reload();
    await expect(row(page, 'Message 0001')).toBeVisible({ timeout: 15_000 });
    expect(Math.abs((await list.boundingBox()).width - dragged)).toBeLessThanOrEqual(2);
  });
});
