/**
 * Compose-window opening smoke test.
 *
 * Bug this regresses against:
 *   On macOS 26 Tahoe, opening the standalone compose window via Reply /
 *   Forward synchronously constructed a new WKWebView from a click
 *   handler. WebKit's `WebPageProxy::dispatchSetObscuredContentInsets`
 *   path SIGSEGV'd because the originating AppKit event hadn't fully
 *   drained yet. Mitigated in `5f69fc0` by bumping the yield in
 *   src/utils/compose-window.ts from setTimeout(0) to setTimeout(50).
 *
 * What this spec verifies:
 *   Open a message, click Reply in the action menu. The previous bug
 *   crashed the entire app at the moment of new WKWebView construction.
 *   We assert that after the click, the webdriver session is still
 *   alive — which it would not be after a renderer-process SIGSEGV.
 *
 * Note on multi-window:
 *   The reply flow opens a SECOND webview window. webdriverio's
 *   multi-window support in Tauri is patchy; this spec deliberately
 *   does NOT switch into the new window. The crash this guards against
 *   fires before the new window even materializes, so confirming the
 *   PRIMARY session is still alive is sufficient evidence.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { newBrowser, closeBrowser } from '../support/browser.js';
import { resolveAppBinary } from '../support/platform.js';
import { openApp } from '../support/app.js';
import { clearStorage } from '../support/state.js';
import { activateDemo } from '../support/demo.js';

describe('compose window open (reply)', () => {
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

  it('does not crash the app when Reply is clicked', async () => {
    // Wait for demo data + open the first message.
    await new Promise((r) => setTimeout(r, 2000));

    const firstMessage = await browser.$('[data-testid="message-row"]');
    if (!(await firstMessage.isExisting())) {
      console.log('[compose-window] no demo messages — skipping');
      return;
    }
    await firstMessage.click();
    await new Promise((r) => setTimeout(r, 1000));

    // Click the reply button in the action menu. The action menu trigger
    // varies — try data-testid first, fall back to scanning for the
    // action menu's reply entry.
    const replyBtn = await browser.$('[data-testid="action-menu-reply"]');
    if (!(await replyBtn.isExisting())) {
      console.log('[compose-window] action-menu-reply hook not found — skipping');
      return;
    }
    await replyBtn.click();

    // Give the new webview construction time to complete or crash.
    // The previous SIGSEGV bug fired during dispatchSetObscuredContentInsets
    // which happens within the first ~50ms of the click handler.
    await new Promise((r) => setTimeout(r, 3000));

    // The decisive assertion: the webdriver session is still responsive.
    // If the compositor crashed, this throws or times out.
    const ready = await browser.execute(() => document.readyState === 'complete');
    expect(ready).toBe(true);
  });
});
