import { stopApp } from './browser.js';

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

// On the software-GL Linux runner a WebKitGTK page can stop answering for
// good, mid-spec as well as at a cold start: every script then times out,
// browser.url() included, so no reload reaches it. A failed test's retry ran
// its beforeEach against that page and timed out again, failing the spec twice
// over (linux-24, folders-and-messages, after opening a message tab). Only a
// new app instance gets a working page back, and a new session starts one.
//
// A healthy page answers a trivial script in milliseconds, even mid-boot (an
// unready one fails fast with "unsupported type"). The driver gives up on a
// script only after 30s and webdriverio retries it, so waiting for that error
// took minutes; a page silent for this long is taken as wedged.
const WEDGE_PROBE_MS = 20_000;

type Probe<T> = { wedged: true } | { wedged: false; value?: T; error?: unknown };

/**
 * Run a script in the page, giving up after WEDGE_PROBE_MS of silence. A page
 * that answers, even with an error other than a script timeout, is not
 * wedged. Use this instead of waitForExist and friends wherever a wedged page
 * must be noticed quickly: their findElements calls each wait out the
 * driver's 30s script timeout and are retried, so on a wedged page a 30s
 * waitForExist took about two and a half minutes (macos-x64).
 */
export async function probePage<T, A extends unknown[]>(
  browser: WebdriverIO.Browser,
  script: (...args: A) => T,
  ...args: A
): Promise<Probe<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = (
    browser.execute(script as never, ...(args as unknown as never[])) as Promise<T>
  ).then(
    (value): Probe<T> => ({ wedged: false, value }),
    (error: unknown): Probe<T> =>
      /script execution timed out/i.test(String((error as { message?: string })?.message || error))
        ? { wedged: true }
        : { wedged: false, error },
  );
  const silent = new Promise<Probe<T>>((resolve) => {
    timer = setTimeout(() => resolve({ wedged: true }), WEDGE_PROBE_MS);
  });
  const result = await Promise.race([answered, silent]);
  clearTimeout(timer);
  return result;
}

// A relaunch in progress. A beforeEach that overruns its hook timeout keeps
// running after vitest starts the retry, so the retry's first command could
// reach the session the relaunch was replacing and fail with "Session ... not
// found" (macos-x64, both failed specs). openApp waits for it instead.
let relaunching: Promise<void> | null = null;

/** Replace the app with a new instance, in a new session on the same browser. */
export async function relaunchApp(browser: WebdriverIO.Browser): Promise<void> {
  relaunching ??= (async () => {
    // (the wedged app goes first, see stopApp)
    await stopApp();
    await browser.reloadSession();
  })().finally(() => {
    relaunching = null;
  });
  await relaunching;
}

export async function relaunchIfWedged(browser: WebdriverIO.Browser): Promise<boolean> {
  const probe = await probePage(browser, () => true);
  if (!probe.wedged) return false;
  console.warn('[openApp] the page stopped answering scripts; relaunching the app');
  await relaunchApp(browser);
  return true;
}

// Sessions that have loaded the app. Only those are probed: a session that
// has not opened it yet has no page that could have wedged, and relaunching
// it would only restart a slow cold boot (Windows Defender scan).
const sessionsWithApp = new Set<string>();

/** The page stopped answering while the app was being opened. */
class PageWedgedError extends Error {
  constructor(step: string) {
    super(`the page stopped answering scripts (${step})`);
    this.name = 'PageWedgedError';
  }
}

const isScriptTimeout = (error: unknown) =>
  /script execution timed out/i.test(String((error as { message?: string })?.message || error));

// Loading the app runs a script too, so a wedged page never finishes it: the
// driver gives up after 30s and webdriverio retries. A load still pending
// after this long is taken as a wedge.
const LOAD_WEDGE_MS = 35_000;

async function loadApp(browser: WebdriverIO.Browser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loaded = browser.url(appUrl()).then(
    () => true,
    (error: unknown) => {
      if (isScriptTimeout(error)) return false;
      throw error;
    },
  );
  const silent = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), LOAD_WEDGE_MS);
  });
  const done = await Promise.race([loaded, silent]);
  clearTimeout(timer);
  if (!done) throw new PageWedgedError('loading the app');
}

export async function openApp(browser: WebdriverIO.Browser): Promise<void> {
  if (relaunching) await relaunching;
  if (sessionsWithApp.has(browser.sessionId)) await relaunchIfWedged(browser);
  // A page can also wedge while it loads, in a session that has never had a
  // working one (macos-x64, theme-toggle): it is replaced once here. Before,
  // the script timeouts went straight up to the hook, its retry opened the
  // same wedged page, and both attempts of the test ran out their hooks.
  let relaunched = false;
  let deadline = Date.now() + OPEN_APP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await loadApp(browser);
      await waitForFrontendReady(browser, Math.max(1_000, deadline - Date.now()));
      await ensureUsableViewport(browser);
      sessionsWithApp.add(browser.sessionId);
      return;
    } catch (error) {
      if (error instanceof PageWedgedError && !relaunched) {
        console.warn(`[openApp] ${error.message}; relaunching the app`);
        relaunched = true;
        await relaunchApp(browser);
        deadline = Date.now() + OPEN_APP_TIMEOUT_MS;
        continue;
      }
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
    // Probed, so a page that stops answering is noticed in WEDGE_PROBE_MS
    // rather than after the driver's retried 30s script timeouts.
    const probe = await probePage(
      browser,
      () => document.readyState === 'complete' && document.body?.children.length > 0,
    );
    if (probe.wedged) throw new PageWedgedError('waiting for the frontend');
    // (an unready page's "unsupported type" goes to openApp, which retries)
    if (probe.error) throw probe.error;
    if (probe.value === true) return;
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
