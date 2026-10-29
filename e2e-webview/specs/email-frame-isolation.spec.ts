import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { newBrowser, closeBrowser } from '../support/browser.js';
import { resolveAppBinary } from '../support/platform.js';
import { openApp } from '../support/app.js';
import { clearStorage } from '../support/state.js';
import { activateDemo } from '../support/demo.js';

// The email body renders in a sandboxed srcdoc frame. On desktop it must get
// an opaque origin (no allow-same-origin), and its runtime must still reach
// the app by postMessage: the frame reports ready and a height.
describe('email frame isolation', () => {
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

  async function openFirstMessage(): Promise<void> {
    await browser.waitUntil(
      async () => (await browser.$$('[data-testid="message-row"]')).length > 0,
      { timeout: 15_000, timeoutMsg: 'no message rows rendered after demo activation' },
    );
    const rows = await browser.$$('[data-testid="message-row"]');
    await rows[0].click();
  }

  it('renders the email in an opaque-origin frame whose runtime still reports in', async () => {
    await openFirstMessage();

    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Array.from(document.querySelectorAll('iframe.fe-email-iframe')).some(
            (f) => f.getAttribute('data-frame-ready') === 'true',
          ),
        ),
      {
        timeout: 15_000,
        timeoutMsg: 'the email frame runtime never posted ready to the app',
      },
    );

    const frame = await browser.execute(() => {
      const f = Array.from(document.querySelectorAll('iframe.fe-email-iframe')).find(
        (el) => el.getAttribute('data-frame-ready') === 'true',
      ) as HTMLIFrameElement;
      let documentReachable = false;
      try {
        documentReachable = f.contentDocument !== null;
      } catch {
        documentReachable = false;
      }
      return {
        sandbox: f.getAttribute('sandbox') || '',
        documentReachable,
        height: f.getBoundingClientRect().height,
      };
    });

    expect(frame.sandbox.split(/\s+/)).toContain('allow-scripts');
    expect(frame.sandbox.split(/\s+/)).not.toContain('allow-same-origin');
    expect(frame.documentReachable).toBe(false);
    expect(frame.height).toBeGreaterThan(50);
  });
});
