import { expect, test } from '@playwright/test';
import {
  isMobileProject,
  navigateToMailbox,
  setupAuthenticatedMailbox,
} from '../fixtures/mailbox-helpers.js';

// On iOS the app sometimes went blank and reloaded, or closed, while checking
// messages or writing one. WKWebView renders in a separate process; when that
// process dies (a WebKit crash, or iOS ending it for memory) the app reloads
// the page. WebKit's compositor has crashed on nodes removed while it was
// laying out, and on render layers made and dropped in quick succession; iOS
// ends the process when it holds too much image memory. These tests pin what
// the app does on a phone so that none of that happens on a tap: a check or
// a tap leaves the list's nodes and layers alone, the keyboard does not
// re-lay out the page between fields, and an attached photo is held as a
// small preview.

test.beforeEach(({ page }, testInfo) => {
  void page;
  test.skip(!isMobileProject(testInfo), 'Phone layout');
});

async function openInbox(page) {
  await setupAuthenticatedMailbox(page);
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await navigateToMailbox(page);
  await expect(page.locator('[data-conversation-row]').first()).toBeVisible();
}

/** Count element nodes added to or removed from the list from now on. */
async function watchListNodes(page) {
  await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="message-list-pane"]');
    window.__listChanges = [];
    window.__listObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            window.__listChanges.push(`${node.tagName}.${node.className}`);
          }
        }
      }
    });
    window.__listObserver.observe(pane, { childList: true, subtree: true });
  });
}

const listChanges = (page) =>
  page.evaluate(() => {
    window.__listObserver.takeRecords();
    return window.__listChanges;
  });

/** A finger down on an element, held: no touchend yet. */
async function touchDown(page, locator) {
  const box = await locator.boundingBox();
  const client = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  return async () => {
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await client.detach();
  };
}

test('checking and unchecking a message adds and removes nothing in the list', async ({ page }) => {
  await openInbox(page);
  // the bulk-action bar
  const clearSelection = page.getByRole('button', { name: 'Clear selection' });
  await expect(clearSelection).toBeHidden();
  await watchListNodes(page);

  const row = page.locator('[data-conversation-row]').first();
  await row.getByRole('button', { name: 'Select', exact: true }).tap();
  await expect(clearSelection).toBeVisible();

  await row.getByRole('button', { name: 'Deselect', exact: true }).tap();
  await expect(clearSelection).toBeHidden();

  expect(await listChanges(page)).toEqual([]);
});

test('a finger on a row gives it no render layer until it swipes', async ({ page }) => {
  await openInbox(page);
  const row = page.locator('[data-conversation-row]').first();
  const rows = page.locator('[data-conversation-row]');

  // Idle rows carry no transform of their own.
  const styled = await rows.evaluateAll(
    (els) =>
      els.filter((el) => /transform|will-change/.test(el.getAttribute('style') || '')).length,
  );
  expect(styled).toBe(0);

  // On the avatar (the check) and on the row itself.
  for (const target of [row.getByRole('button', { name: 'Select', exact: true }), row]) {
    const lift = await touchDown(page, target);
    await page.waitForTimeout(100);
    const style = (await row.getAttribute('style')) || '';
    await lift();
    expect(style).not.toMatch(/will-change|transform/);
    await page.goto('/mailbox#INBOX');
    await expect(rows.first()).toBeVisible();
  }
});

test.describe('Writing a message on a phone', () => {
  async function openCompose(page) {
    await page.locator('.fe-mobile-tabbar').getByLabel('Compose').click();
    const compose = page.getByTestId('compose-modal');
    await expect(compose).toBeVisible();
    return compose;
  }

  test('the keyboard state holds from the To field to the message body', async ({ page }) => {
    await openInbox(page);
    const compose = await openCompose(page);
    await compose.locator('input[placeholder="To"]').first().tap();
    await expect(page.locator('body')).toHaveClass(/keyboard-open/);
    await page.evaluate(() => {
      window.__keyboardDrops = 0;
      new MutationObserver(() => {
        if (!document.body.classList.contains('keyboard-open')) window.__keyboardDrops++;
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    });

    await compose.locator('.ProseMirror').first().tap();
    await expect(page.locator('body')).toHaveClass(/keyboard-open/);
    await compose.getByPlaceholder('Subject').first().tap();
    await expect(page.locator('body')).toHaveClass(/keyboard-open/);
    await compose.locator('.ProseMirror').first().tap();
    await expect(page.locator('body')).toHaveClass(/keyboard-open/);

    // Never dropped while moving between fields: each drop and re-add laid
    // out the whole page again while the keyboard was moving.
    expect(await page.evaluate(() => window.__keyboardDrops)).toBe(0);
  });

  test('closing compose lets go of the field and the keyboard first', async ({ page }) => {
    await openInbox(page);
    const compose = await openCompose(page);
    await page.evaluate(() => {
      window.__blurredWhileInPage = null;
      document.addEventListener(
        'focusout',
        (event) => {
          if (event.target?.isContentEditable)
            window.__blurredWhileInPage = event.target.isConnected;
        },
        true,
      );
    });

    await compose.locator('.ProseMirror').first().tap();
    await expect(page.locator('body')).toHaveClass(/keyboard-open/);
    await compose.locator('header button').first().tap();
    await expect(compose).toBeHidden();

    // The editor lost focus while it was still in the page, and the page is
    // no longer held in place for a keyboard.
    expect(await page.evaluate(() => window.__blurredWhileInPage)).toBe(true);
    await expect(page.locator('body')).not.toHaveClass(/keyboard-open/);
  });

  test('an attached photo is shown from a small preview', async ({ page }) => {
    await openInbox(page);
    const compose = await openCompose(page);

    // A 12-megapixel photo.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 4000;
      canvas.height = 3000;
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 4000, 3000);
      gradient.addColorStop(0, '#2a6');
      gradient.addColorStop(1, '#26a');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 4000, 3000);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      const file = new File([blob], 'holiday.jpg', { type: 'image/jpeg' });
      const input = document.querySelector('[data-testid="compose-modal"] input.attach-input');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const preview = compose.locator('img[alt="holiday.jpg"]');
    await expect(preview).toBeVisible({ timeout: 10_000 });
    const image = await preview.evaluate(async (img) => {
      await img.decode();
      return { src: img.src.slice(0, 5), width: img.naturalWidth, height: img.naturalHeight };
    });
    expect(image.src).toBe('blob:');
    expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(96);
  });
});
