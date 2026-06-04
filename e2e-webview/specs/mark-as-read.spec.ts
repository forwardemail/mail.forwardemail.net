import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { newBrowser, closeBrowser } from '../support/browser.js';
import { resolveAppBinary } from '../support/platform.js';
import { openApp } from '../support/app.js';
import { clearStorage } from '../support/state.js';
import { activateDemo } from '../support/demo.js';
import { nativeClick, enterSelectionMode } from '../support/interact.js';

describe('mark as read (optimistic update)', () => {
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

  it('demo data includes at least one unread row', async () => {
    await browser.waitUntil(async () => (await $$count('[data-testid="message-row"]')) > 0, {
      timeout: 15_000,
    });
    expect(await $$count('[data-testid="message-row"][data-unread="true"]')).toBeGreaterThan(0);
  });

  it('flips data-unread to "false" for the selected row after bulk mark-as-read', async () => {
    await browser.waitUntil(
      async () => (await $$count('[data-testid="message-row"][data-unread="true"]')) > 0,
      { timeout: 15_000, timeoutMsg: 'expected at least one unread row in demo data' },
    );

    const unreadRows = await browser.$$('[data-testid="message-row"][data-unread="true"]');
    const target = unreadRows[0];
    const messageId = await target.getAttribute('data-message-id');
    expect(messageId).toBeTruthy();

    // Card view hides per-row checkboxes until selection mode is active.
    await enterSelectionMode(browser);
    const checkbox = await target.$('[data-slot="checkbox"]');
    await nativeClick(browser, checkbox);

    const markRead = await browser.$('[aria-label="Mark selected as read"]');
    await nativeClick(browser, markRead);

    // Optimistic store update + re-render should flip data-unread on this row.
    const selector = `[data-testid="message-row"][data-message-id="${messageId}"]`;
    await browser.waitUntil(
      async () => {
        const row = await browser.$(selector);
        return (await row.getAttribute('data-unread')) === 'false';
      },
      {
        timeout: 10_000,
        timeoutMsg: `row ${messageId} did not flip to data-unread="false" after mark-as-read`,
      },
    );
  });

  it('decreases the total unread row count by one after marking one', async () => {
    await browser.waitUntil(
      async () => (await $$count('[data-testid="message-row"][data-unread="true"]')) > 0,
      { timeout: 15_000 },
    );
    const before = await $$count('[data-testid="message-row"][data-unread="true"]');

    const unreadRows = await browser.$$('[data-testid="message-row"][data-unread="true"]');
    // Card view hides per-row checkboxes until selection mode is active.
    await enterSelectionMode(browser);
    const checkbox = await unreadRows[0].$('[data-slot="checkbox"]');
    await nativeClick(browser, checkbox);
    const markRead = await browser.$('[aria-label="Mark selected as read"]');
    await nativeClick(browser, markRead);

    await browser.waitUntil(
      async () => (await $$count('[data-testid="message-row"][data-unread="true"]')) === before - 1,
      {
        timeout: 10_000,
        timeoutMsg: `expected unread count to drop from ${before} to ${before - 1}`,
      },
    );
  });
});
