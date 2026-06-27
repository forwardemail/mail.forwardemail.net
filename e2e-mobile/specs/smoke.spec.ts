import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newBrowser, closeBrowser } from '../support/browser.js';
import {
  switchToTauriWebview,
  waitForFrontendReady,
  isTauriWebview,
  waitForTauriWebviewContext,
  appActivityInForeground,
  mobileCapabilities,
  e2ePlatform,
} from '../support/app.js';

const platform = e2ePlatform();

describe(`${platform} app smoke`, () => {
  let browser: WebdriverIO.Browser;
  let webviewContext = '';

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
    if (platform === 'ios') {
      // The iOS simulator has a real GPU, so the WKWebView context switch is
      // reliable — iOS runs the full in-WebView assertions.
      await switchToTauriWebview(browser);
      await waitForFrontendReady(browser);
    } else {
      // Android: NATIVE-ONLY. Switching into the WebView context (setContext via
      // chromedriver) reliably takes the software-GL CI emulator offline (WebView
      // GPU-rasterization storm — see the e2e-mobile notes), so we verify the app
      // + WebView launched from the native side and never attach chromedriver.
      webviewContext = await waitForTauriWebviewContext(browser);
    }
  }, 660_000);

  afterAll(closeBrowser);

  if (platform === 'ios') {
    it('runs inside the native WebView (Tauri-bridged)', async () => {
      expect(await isTauriWebview(browser)).toBe(true);
    });

    it('loads the frontend with a non-empty title', async () => {
      expect(await browser.getTitle()).toBeTruthy();
    });
  } else {
    it('launches the app and spins up the Tauri WebView (native-only)', () => {
      // A WebView context carrying the app bundle id proves the app process
      // launched AND its WebView came up — established without switching in
      // (which crashes the emulator). This is the weaker, emulator-safe
      // guarantee chosen for 1.0; the full in-WebView assertions run on iOS.
      expect(webviewContext).toContain('net.forwardemail.mail');
    });

    it('keeps the Tauri app activity in the foreground (native-only)', async () => {
      // Read the foreground app from the window manager (dumpsys, pure adb) — we
      // never search the native hierarchy for the WebView node, because that
      // traversal recurses into the WebView's web-content a11y subtree and
      // crashes UiAutomator2 on the software-GL emulator (see app.ts). Together
      // with the bundle-id WebView context above, this proves the app launched,
      // brought up a WebView, AND is the foreground activity.
      expect(await appActivityInForeground(browser)).toBe(true);
    });
  }
});
