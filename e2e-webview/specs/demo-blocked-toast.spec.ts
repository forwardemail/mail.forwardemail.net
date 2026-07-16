import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { newBrowser, closeBrowser } from '../support/browser.js';
import { resolveAppBinary } from '../support/platform.js';
import { openApp } from '../support/app.js';
import { clearStorage } from '../support/state.js';
import { activateDemo } from '../support/demo.js';
import { nativeClick, enterSelectionMode } from '../support/interact.js';

describe('demo write actions are blocked with a toast', () => {
  let browser: WebdriverIO.Browser;

  beforeAll(async () => {
    browser = await newBrowser({
      hostname: '127.0.0.1',
      port: 4444,
      logLevel: 'warn',
      capabilities: {
        'tauri:options': { application: resolveAppBinary() },
      } as WebdriverIO.Capabilities,
    });
  }, 60_000);

  afterAll(closeBrowser);

  beforeEach(async () => {
    await openApp(browser);
    await clearStorage(browser);
    await openApp(browser);
    await activateDemo(browser);
  });

  async function $$count(selector: string): Promise<number> {
    const els = await browser.$$(selector);
    return els.length;
  }

  it('shows the demo-blocked toast when deleting a selected conversation', async () => {
    await browser.waitUntil(async () => (await $$count('[data-testid="message-row"]')) > 0, {
      timeout: 15_000,
      timeoutMsg: 'no message rows rendered after demo activation',
    });

    // Card view hides per-row checkboxes until selection mode is active, so
    // enter selection mode first, then select the first row's checkbox.
    const rows = await browser.$$('[data-testid="message-row"]');
    await enterSelectionMode(browser);
    const checkbox = await rows[0].$('[data-slot="checkbox"]');
    await nativeClick(browser, checkbox);

    // Wait for the selection toolbar (the Delete button only exists in
    // selection mode) before clicking — firing blind raced the selection
    // state settling on the slow macos-x64 runner.
    const del = await browser.$('[aria-label="Delete selected"]');
    await del.waitForDisplayed({ timeout: 15_000 });
    await nativeClick(browser, del);

    // Wait for the confirm dialog to mount before confirming.
    const confirmBtn = await browser.$('[data-testid="confirm-dialog-confirm"]');
    await confirmBtn.waitForDisplayed({ timeout: 15_000 });

    // macOS WebDriver can invalidate an element handle while Svelte replaces
    // the dialog subtree. Resolve and click the live button inside the renderer
    // on every poll instead of reusing the original WebDriver element. Read the
    // toast text in the same renderer call so a detach between element lookup
    // and getText() cannot hide the 15-second demo warning.
    let toastText = '';
    await browser.waitUntil(
      async () => {
        const toastTexts = await browser.execute(() => {
          const confirm = document.querySelector<HTMLButtonElement>(
            '[data-testid="confirm-dialog-confirm"]',
          );
          confirm?.click();

          return Array.from(document.querySelectorAll('[data-testid="toast-message"]')).map(
            (toast) => toast.textContent?.trim().toLowerCase() || '',
          );
        });
        const match = toastTexts.find((text) => text.includes('demo'));
        if (!match) return false;
        toastText = match;
        return true;
      },
      {
        timeout: 20_000,
        timeoutMsg: 'expected a toast containing "demo" after the blocked delete',
      },
    );
    expect(toastText).toContain('demo');
  });
});
