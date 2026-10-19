import { test, expect } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  openComposeFromSidebar,
} from '../fixtures/mailbox-helpers.js';

// Links in the compose editor were painted with the button blue, which is
// hard to read on the dark theme. Paste a link through the real editor and
// check its contrast against what is actually behind it.

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/\/v1\/ws/, () => {});
  await page.addInitScript(() => {
    try {
      localStorage.setItem('webmail_theme', 'dark');
    } catch {
      // sandboxed frame
    }
  });
  await setupAuthenticatedMailbox(page);
  await navigateToMailbox(page);
});

test('compose links stay readable in dark mode', async ({ page }) => {
  await openComposeFromSidebar(page);
  const editor = page.locator('.rich-editor .ProseMirror').first();
  await editor.waitFor({ timeout: 10_000 });
  await editor.click();

  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>See <a href="https://example.com/docs">the docs</a></p>');
    data.setData('text/plain', 'See the docs');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });

  const link = editor.locator('a', { hasText: 'the docs' });
  await expect(link).toBeVisible();

  const ratio = await link.evaluate((el) => {
    const parse = (value) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a };
    };
    const luminance = ({ r, g, b }) => {
      const channel = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    let node = el.parentElement;
    let bg = null;
    while (node) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color.a > 0) {
        bg = color;
        break;
      }
      node = node.parentElement;
    }
    bg = bg || parse(getComputedStyle(document.body).backgroundColor);
    const fg = luminance(parse(getComputedStyle(el).color));
    const back = luminance(bg);
    return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
  });

  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
