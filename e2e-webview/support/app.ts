// Tauri 2 serves the embedded frontend over a custom scheme. On Windows the
// default is http://tauri.localhost (https only when app.windows.useHttpsScheme
// is set in tauri.conf.json — we don't); macOS/Linux use tauri://localhost.
// Hitting https://tauri.localhost on Windows yields ERR_CONNECTION_REFUSED.
export function appUrl(): string {
  return process.platform === 'win32' ? 'http://tauri.localhost' : 'tauri://localhost';
}

export async function openApp(browser: WebdriverIO.Browser): Promise<void> {
  await browser.url(appUrl());
  await waitForFrontendReady(browser);
  await ensureUsableViewport(browser);
}

/**
 * Guarantee the app window is large enough for the login form (Try Demo
 * sits below the password + Stay-signed-in checkbox). Observed on the
 * macOS-arm64 CI runner: the spawned window was ~1024×190 px tall, which
 * left the demo button outside the viewport and `waitForClickable` timed
 * out even with scrollIntoView. The Tauri window-state plugin may also
 * restore a tiny saved size across spec runs.
 *
 * Tries WebDriver setWindowRect first (works on every desktop driver
 * including tauri-webdriver). Failures are non-fatal — the assertion
 * that follows still surfaces the underlying issue clearly.
 */
async function ensureUsableViewport(browser: WebdriverIO.Browser): Promise<void> {
  const MIN_W = 1280;
  const MIN_H = 800;
  try {
    const size = (await browser.execute(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }))) as { w: number; h: number };
    if (size.w >= MIN_W && size.h >= MIN_H) return;
    await browser.setWindowSize(MIN_W, MIN_H);
  } catch {
    // Driver may not support setWindowSize — let the test continue and
    // fail loudly on the real assertion rather than swallowing this here.
  }
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
  throw new Error(`frontend did not finish loading within ${timeoutMs}ms`);
}

export async function isTauriWebview(browser: WebdriverIO.Browser): Promise<boolean> {
  return browser.execute(
    () =>
      typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      'undefined',
  ) as Promise<boolean>;
}
