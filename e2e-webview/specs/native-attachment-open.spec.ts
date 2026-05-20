/**
 * Attachment download/open smoke test.
 *
 * Bug this regresses against:
 *   In 0.10.15, downloading or opening an attachment crashed the app via
 *   an out-of-memory abort (kernel triage `mach_vm_allocate_kernel failed`).
 *   Root cause: bufferToDataUrl built a giant base64 data URL of the entire
 *   attachment, then cacheAttachmentBlob stored that string in IndexedDB,
 *   tripling memory for the duration of the operation. Fixed in `5f69fc0`
 *   by adding a 50 MB size guard + the contentToBytes / triggerDownloadBytes
 *   chunked-write helpers in src/stores/mailService.ts.
 *
 * What this spec verifies:
 *   Open the demo mailbox, find a message that has an attachment in the
 *   list view, click the attachment row. The previous bug crashed the
 *   webview / Rust process immediately. We assert the click completes
 *   and the message detail view is still rendered after a short delay.
 *
 * Notes on the demo data dependency:
 *   This spec relies on the demo mode (activateDemo) seeding at least
 *   one message with an attachment. If the demo data changes, the spec
 *   will skip rather than fail — the goal is "no native crash on
 *   attachment click", not "specific attachment is present".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { newBrowser, closeBrowser } from '../support/browser.js';
import { resolveAppBinary } from '../support/platform.js';
import { openApp } from '../support/app.js';
import { clearStorage } from '../support/state.js';
import { activateDemo } from '../support/demo.js';

describe('attachment download/open', () => {
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

  it('does not crash when clicking an attachment row', async () => {
    // Demo data may or may not contain attachments — give the mailbox a
    // moment to load, then look for any attachment row in the message
    // detail. If none exist in the seeded data, skip rather than fail.
    await new Promise((r) => setTimeout(r, 2000));

    // Click the first message row to open it.
    const firstMessage = await browser.$('[data-testid="message-row"]');
    const hasMessage = await firstMessage.isExisting();
    if (!hasMessage) {
      console.log('[attachment-open] no demo messages — skipping');
      return;
    }
    await firstMessage.click();
    await new Promise((r) => setTimeout(r, 1000));

    // Look for an attachment row in the opened message. We may iterate
    // through messages to find one with attachments.
    let attachment = await browser.$('[data-testid="attachment-row"]');
    let attachmentExists = await attachment.isExisting();

    if (!attachmentExists) {
      // Try one more message — a few demo messages have attachments.
      const allRows = await browser.$$('[data-testid="message-row"]');
      const count = await allRows.length;
      for (let i = 1; i < Math.min(count, 5); i++) {
        await allRows[i].click();
        await new Promise((r) => setTimeout(r, 800));
        attachment = await browser.$('[data-testid="attachment-row"]');
        if (await attachment.isExisting()) {
          attachmentExists = true;
          break;
        }
      }
    }

    if (!attachmentExists) {
      console.log('[attachment-open] no attachments found in demo data — skipping');
      return;
    }

    // Click the attachment. Previous bug crashed here on OOM.
    await attachment.click();
    await new Promise((r) => setTimeout(r, 2000));

    // The decisive assertion: the webdriver session is alive and the app
    // is still rendering. If the renderer crashed, this throws.
    const ready = await browser.execute(() => document.readyState === 'complete');
    expect(ready).toBe(true);
  });
});
