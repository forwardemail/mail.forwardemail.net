/**
 * Link preview status bar (desktop app only).
 *
 * The bar is gated on the Tauri desktop flag, so this spec stubs the Tauri
 * globals the platform module reads and runs the real app in Chromium. It
 * covers the two desktop layouts because the bar lives in the reader
 * component but paints at the bottom-left of the window, where the folder
 * sidebar sits: in the classic layout the reader's column clipped and
 * out-stacked it until the bar was hoisted to document.body. The hit-test
 * at the bar's own position is the assertion that matters; a bar that
 * exists but paints under the sidebar fails it.
 */
import { test, expect } from '@playwright/test';
import {
  setupAuthenticatedMailbox,
  navigateToMailbox,
  selectMessageBySubject,
  isMobileProject,
} from '../fixtures/mailbox-helpers.js';

test.beforeEach(({ page }, testInfo) => {
  // Playwright requires a destructured fixture parameter here.
  void page;
  test.skip(isMobileProject(testInfo), 'Desktop app only');
});

const LINK_BODY = {
  html:
    '<p>Hello <a href="https://docs.example.com/review/dashboard">https://paypal.com/login</a> world</p>' +
    '<p style="height:900px">tall filler</p>',
  attachments: [],
};

for (const layout of ['full', 'classic']) {
  test(`link preview bar paints above the sidebar in ${layout} layout`, async ({ page }) => {
    await page.addInitScript((mode) => {
      window.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: 'macos' };
      window.__TAURI_INTERNALS__ = {
        invoke: async () => null,
        transformCallback: () => 0,
        unregisterCallback() {},
        convertFileSrc: (p) => p,
        postMessage() {},
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { label: 'main', windowLabel: 'main' },
          windows: [{ label: 'main' }],
          webviews: [{ label: 'main', windowLabel: 'main' }],
        },
        plugins: {},
      };
      localStorage.setItem('webmail_theme', 'dark');
      localStorage.setItem('webmail_layout_mode', mode);
      localStorage.setItem('webmail_layout_mode_test@example.com', mode);
    }, layout);
    await setupAuthenticatedMailbox(page);
    await page.route(/\/v1\/messages\/msg-1(\?.*)?$/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(LINK_BODY),
          })
        : route.continue(),
    );
    await navigateToMailbox(page);
    await selectMessageBySubject(page, 'Welcome to Webmail');

    const frame = page.frameLocator('iframe.fe-email-iframe').first();
    const link = frame.locator('a').first();
    await link.waitFor({ timeout: 10_000 });
    await link.hover();

    const bar = page.getByTestId('link-preview');
    await expect(bar).toBeVisible({ timeout: 5_000 });
    const info = await bar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      el.style.pointerEvents = 'auto';
      const top = document.elementFromPoint(r.left + 8, r.top + r.height / 2);
      el.style.pointerEvents = '';
      const aside = document.querySelector('aside.fe-folders');
      const a = aside ? aside.getBoundingClientRect() : null;
      return {
        parent: el.parentElement && el.parentElement.tagName,
        rect: { l: r.left, t: r.top, w: r.width, h: r.height },
        aside: a && { l: a.left, t: a.top, w: a.width, h: a.height, cls: aside.className },
        topEl: top ? `${top.tagName}.${top.className}` : null,
        topIsBar: top === el || el.contains(top),
        z: getComputedStyle(el).zIndex,
        shell: document.querySelector('.fe-mailbox-shell')?.className,
        vh: innerHeight,
        vw: innerWidth,
      };
    });
    expect(info.parent, 'bar is hoisted out of the reader column').toBe('BODY');
    expect(info.topIsBar, `bar paints above the sidebar (hit: ${info.topEl})`).toBe(true);
    expect(info.rect.l).toBe(0);
    expect(info.rect.t + info.rect.h).toBeCloseTo(info.vh, 0);
    // The mismatch warning: text names paypal.com, href goes to docs.example.com.
    await expect(bar).toHaveClass(/fe-link-preview-warn/);
    await expect(bar).toContainText('docs.example.com');
  });
}
