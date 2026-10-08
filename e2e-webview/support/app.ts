// Tauri 2 serves the embedded frontend over a custom scheme. On Windows the
// default is http://tauri.localhost (https only when app.windows.useHttpsScheme
// is set in tauri.conf.json — we don't); macOS/Linux use tauri://localhost.
// Hitting https://tauri.localhost on Windows yields ERR_CONNECTION_REFUSED.
export function appUrl(): string {
  return process.platform === 'win32' ? 'http://tauri.localhost' : 'tauri://localhost';
}

// A webview that has only just been created can answer every script with
// "JavaScript execution returned a result of an unsupported type" until its
// first page is in; browser.url() itself runs a script. On the macOS runner a
// spec failed on its very first command that way, and its retry right after.
// Keep asking until the frontend answers, up to this long.
const OPEN_APP_TIMEOUT_MS = 45_000;

export async function openApp(browser: WebdriverIO.Browser): Promise<void> {
  const deadline = Date.now() + OPEN_APP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await browser.url(appUrl());
      await waitForFrontendReady(browser, Math.max(1_000, deadline - Date.now()));
      await ensureUsableViewport(browser);
      return;
    } catch (error) {
      if (!isScriptUnavailable(error)) throw error;
      lastError = error;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw lastError;
}

function isScriptUnavailable(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || error);
  return /unsupported type|JavaScript exception occurred/i.test(message);
}

/**
 * Guarantee the app window is large enough for the login form (Try Demo
 * sits below the password + Stay-signed-in checkbox). Observed on the
 * macOS-arm64 CI runner: the spawned window was ~1024×190 px tall, which
 * left the demo button outside the viewport and `waitForClickable` timed
 * out even with scrollIntoView. The tauri-plugin-window-state plugin
 * restores a saved size across spec runs and tauri-webdriver does not
 * implement W3C setWindowRect, so we have to resize via the Tauri
 * JS bridge (which targets the native window directly).
 */
async function ensureUsableViewport(browser: WebdriverIO.Browser): Promise<void> {
  const MIN_W = 1280;
  const MIN_H = 800;
  try {
    type ResizeResult = {
      ok: boolean;
      resized?: boolean;
      w?: number;
      h?: number;
      reason?: string;
    };
    const result = (await browser.executeAsync(
      // The async-execute callback receives (minW, minH, done). Returning
      // before `done()` would lose the result; the trailing argument is
      // injected by WebDriverIO regardless of how many params we declare.
      function (minW, minH, done) {
        try {
          var iw = window.innerWidth || 0;
          var ih = window.innerHeight || 0;
          if (iw >= minW && ih >= minH) {
            done({ ok: true, resized: false, w: iw, h: ih });
            return;
          }
          // Dynamic import keeps the call cheap when the bridge isn't
          // present (e.g. tests running against a plain browser).
          import('@tauri-apps/api/window')
            .then(function (mod) {
              var Logical = mod.LogicalSize;
              var current = mod.getCurrentWindow && mod.getCurrentWindow();
              if (!current || !Logical) {
                done({ ok: false, reason: 'no-tauri-window-api' });
                return;
              }
              current
                .setSize(new Logical(minW, minH))
                .then(function () {
                  done({ ok: true, resized: true, w: minW, h: minH });
                })
                .catch(function (err) {
                  done({ ok: false, reason: String((err && err.message) || err) });
                });
            })
            .catch(function (err) {
              done({ ok: false, reason: String((err && err.message) || err) });
            });
        } catch (err) {
          done({
            ok: false,
            reason: String((err as { message?: string })?.message || err),
          });
        }
      },
      MIN_W,
      MIN_H,
    )) as ResizeResult;
    if (result?.resized) {
      // Tauri's setSize resolves before the OS finishes the resize.
      // Give the WebView a tick to reflect the new innerWidth/innerHeight
      // so the next selector check sees the larger viewport.
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch {
    // Best-effort — let the test continue and fail loudly on the real
    // assertion rather than swallowing this here.
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
