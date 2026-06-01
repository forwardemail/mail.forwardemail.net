import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newBrowser, closeBrowser } from '../support/browser.js';
import {
  switchToTauriWebview,
  waitForFrontendReady,
  isTauriWebview,
  mobileCapabilities,
  e2ePlatform,
} from '../support/app.js';

describe(`${e2ePlatform()} app smoke`, () => {
  let browser: WebdriverIO.Browser;

  beforeAll(async () => {
    browser = await newBrowser({
      hostname: '127.0.0.1',
      port: 4723,
      path: '/',
      logLevel: 'warn',
      // The POST /session that creates the session also compiles WebDriverAgent
      // on the first iOS run (~4-5 min cold). The default 120s client timeout —
      // and even 300s — aborts mid-build, so give the HTTP request room to
      // outlast the whole WDA xcodebuild (must exceed appium:wdaLaunchTimeout).
      connectionRetryTimeout: 600_000,
      capabilities: mobileCapabilities(),
    });
    await switchToTauriWebview(browser);
    await waitForFrontendReady(browser);
  }, 660_000);

  afterAll(closeBrowser);

  it('runs inside the native WebView (Tauri-bridged)', async () => {
    expect(await isTauriWebview(browser)).toBe(true);
  });

  it('loads the frontend with a non-empty title', async () => {
    expect(await browser.getTitle()).toBeTruthy();
  });
});
