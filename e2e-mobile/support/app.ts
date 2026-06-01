const TAURI_BUNDLE_ID = 'net.forwardemail.mail';

/**
 * Which mobile platform this e2e run targets. Defaults to android so the
 * existing Android workflow is unchanged; the iOS workflow sets E2E_PLATFORM=ios.
 */
export function e2ePlatform(): 'android' | 'ios' {
  return process.env.E2E_PLATFORM === 'ios' ? 'ios' : 'android';
}

/**
 * Appium capabilities for the current platform. Android drives the System
 * WebView via UiAutomator2 + the debug APK; iOS drives WKWebView via XCUITest +
 * the simulator .app. The app path comes from the workflow (APK_PATH /
 * IOS_APP_PATH) after the Tauri mobile build step.
 */
export function mobileCapabilities(): WebdriverIO.Capabilities {
  if (e2ePlatform() === 'ios') {
    const app = process.env.IOS_APP_PATH;
    if (!app) throw new Error('IOS_APP_PATH env var is required (path to the simulator .app).');
    return {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:app': app,
      'appium:deviceName': process.env.IOS_DEVICE_NAME || 'iPhone 16',
      // Prefer a concrete UDID (the workflow boots a specific simulator) so
      // Appium attaches to the right device instead of guessing by name/version.
      ...(process.env.IOS_UDID ? { 'appium:udid': process.env.IOS_UDID } : {}),
      ...(process.env.IOS_PLATFORM_VERSION
        ? { 'appium:platformVersion': process.env.IOS_PLATFORM_VERSION }
        : {}),
      'appium:autoWebview': false,
      'appium:newCommandTimeout': 240,
      // CI runners are headless. The workflow pre-boots the simulator with
      // `simctl boot` (no UI), so without this XCUITest sees a "booted but UI
      // not visible" sim and hangs forever on `open -Fn Simulator.app` trying
      // to show the window. isHeadless tells it to run the sim windowless.
      'appium:isHeadless': true,
      // First session on a fresh runner builds WebDriverAgent from source,
      // which can take a couple of minutes — give it room before giving up.
      'appium:wdaLaunchTimeout': 240_000,
      'appium:wdaConnectionTimeout': 240_000,
    } as WebdriverIO.Capabilities;
  }
  const apk = process.env.APK_PATH;
  if (!apk) throw new Error('APK_PATH env var is required (path to the debug APK).');
  return {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:app': apk,
    'appium:autoGrantPermissions': true,
    'appium:autoWebview': false,
    'appium:newCommandTimeout': 240,
  } as WebdriverIO.Capabilities;
}

// On a freshly-launched Tauri app, getContexts() can return only ['NATIVE_APP']
// for several seconds while the WebView spins up. Poll instead of a fixed sleep.
// Context naming differs by platform: Android tags the WebView with the bundle
// id (WEBVIEW_net.forwardemail.mail); iOS (WKWebView) exposes an opaque
// WEBVIEW_<n>, so fall back to the first WEBVIEW_ context there.
export async function switchToTauriWebview(
  browser: WebdriverIO.Browser,
  timeoutMs = 30_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const contexts = (await browser.getContexts()) as Array<string | { id: string }>;
    const webviews = contexts
      .map((c) => (typeof c === 'string' ? c : c.id))
      .filter((c) => c.startsWith('WEBVIEW_'));
    const found = webviews.find((c) => c.includes(TAURI_BUNDLE_ID)) ?? webviews[0];
    if (found) {
      await browser.switchContext(found);
      return found;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No WebView context appeared within ${timeoutMs}ms (platform=${e2ePlatform()})`);
}

export async function waitForFrontendReady(
  browser: WebdriverIO.Browser,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = (await browser.execute(
      () => document.readyState === 'complete' && document.body?.children.length > 0,
    )) as boolean;
    if (ready) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`frontend did not finish loading inside the WebView (${timeoutMs}ms)`);
}

export async function isTauriWebview(browser: WebdriverIO.Browser): Promise<boolean> {
  return browser.execute(
    () =>
      typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      'undefined',
  ) as Promise<boolean>;
}
