import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { newBrowser, closeBrowser } from '../support/browser.js';
import { resolveAppBinary } from '../support/platform.js';
import { openApp } from '../support/app.js';
import { clearStorage } from '../support/state.js';
import { activateDemo } from '../support/demo.js';

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
  }, 30_000);

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

    // Toggle the first row's checkbox to enter selection mode.
    const rows = await browser.$$('[data-testid="message-row"]');
    const checkbox = await rows[0].$('[data-slot="checkbox"]');
    await checkbox.waitForClickable({ timeout: 10_000 });
    await checkbox.click();

    // Selection toolbar exposes the Delete button.
    const del = await browser.$('[aria-label="Delete selected"]');
    await del.waitForClickable({ timeout: 10_000 });
    await del.click();

    // Confirm the destructive action.
    const confirmBtn = await browser.$('[data-testid="confirm-dialog-confirm"]');
    await confirmBtn.waitForClickable({ timeout: 10_000 });
    await confirmBtn.click();

    // Demo interceptor blocks MessageDelete and surfaces the toast. The
    // generic [data-testid="toast-message"] selector also matches transient
    // status toasts ("search index built", "syncing", etc.), and on faster
    // CI runners those can land in the slot before the demo toast and trip
    // the assertion. Poll for the actual demo-blocked text instead of
    // reading whichever toast happens to be on screen first.
    let toastText = '';
    await browser.waitUntil(
      async () => {
        const toasts = await browser.$$('[data-testid="toast-message"]');
        const len = await toasts.length;
        for (let i = 0; i < len; i++) {
          const t = (await toasts[i].getText()).toLowerCase();
          if (t.includes('demo')) {
            toastText = t;
            return true;
          }
        }
        return false;
      },
      {
        timeout: 10_000,
        timeoutMsg: 'expected a toast containing "demo" after the blocked delete',
      },
    );
    expect(toastText).toContain('demo');
  });
});
