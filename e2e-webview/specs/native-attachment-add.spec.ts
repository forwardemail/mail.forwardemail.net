/**
 * Native attachment-picker smoke test.
 *
 * Bug this regresses against:
 *   On macOS 26 Tahoe (ARM + Intel), the `rfd` 0.16 + objc2-app-kit 0.3.2
 *   binding for `+[NSOpenPanel openPanel]` asserts a non-nullable return.
 *   Tahoe started returning nil under some activation states, and the
 *   `none_fail` retain assertion panicked Rust, which `panic = "abort"`
 *   turned into a SIGABRT that took the entire app down — see commit
 *   `ca64da0` and the docs/cross-platform-webview-gotchas.md notes on
 *   `pick_files_macos`.
 *
 * What this spec verifies:
 *   Click the Add Attachment button in the compose modal. If the click
 *   crashes the underlying webview process (the previous Tahoe bug class),
 *   every subsequent webdriver call throws and the test fails. If the
 *   native picker opens, we dismiss it with Escape and assert the compose
 *   modal is still alive. Specifically catches the
 *   pick_files_macos → NSOpenPanel return path.
 *
 * Platform scope:
 *   Runs on every OS in the matrix. The crash class is macOS-specific, but
 *   on Windows/Linux this exercises the corresponding native picker path
 *   and is a useful smoke check there too.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { newBrowser, closeBrowser } from '../support/browser.js';
import { resolveAppBinary } from '../support/platform.js';
import { openApp } from '../support/app.js';
import { clearStorage } from '../support/state.js';
import { activateDemo } from '../support/demo.js';

describe('native attachment picker', () => {
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

  it('does not crash the app when Add Attachment is clicked', async () => {
    // Open compose first.
    const composeBtn = await browser.$('[data-testid="compose-button"]');
    await composeBtn.waitForClickable({ timeout: 15_000 });
    await composeBtn.click();

    const modal = await browser.$('[data-testid="compose-modal"]');
    await modal.waitForDisplayed({ timeout: 10_000 });

    // Click the attachment button. The previous crash bug fired here.
    const addBtn = await browser.$('[data-testid="compose-add-attachment"]');
    await addBtn.waitForClickable({ timeout: 5_000 });
    await addBtn.click();

    // Give the native dialog a beat to either appear or crash the app.
    await new Promise((r) => setTimeout(r, 1500));

    // Dismiss the picker. Escape works on macOS + Windows + Linux GTK.
    // If the picker didn't open (e.g. headless CI suppressed it), this
    // is a no-op that the focused element ignores.
    await browser.keys(['Escape']);
    await new Promise((r) => setTimeout(r, 500));

    // The decisive assertion: the webdriver session is still alive AND
    // the compose modal is still in the DOM. Either condition fails if
    // the underlying process died from a native crash.
    const stillThere = await browser.$('[data-testid="compose-modal"]');
    expect(await stillThere.isDisplayed()).toBe(true);
  });
});
