import { remote } from 'webdriverio';
import { execFile } from 'node:child_process';
import net from 'node:net';

type RemoteOptions = Parameters<typeof remote>[0];

let current: WebdriverIO.Browser | undefined;

// The in-app (tauri-plugin-webdriver) server the app binds once tauri-webdriver
// spawns it. Only one app instance can hold it at a time, so a stale instance
// here is what stalls the next spec's newSession.
const IN_APP_WEBDRIVER_PORT = 4445;

/**
 * Windows-only safety net against native-dialog session poisoning.
 *
 * A spec that opens a native file/save dialog can't dismiss it through
 * WebDriver — `Escape` is delivered to the WebView, not the OS dialog — so on
 * Windows the app stays alive behind the modal with its in-app webdriver server
 * still bound to :4445. The next spec's `newBrowser` then fails with
 * "Plugin expected on port 4445" / "No window could be found", and every
 * subsequent spec cascades. Force-killing the app frees the port and tears down
 * the stuck dialog, so each spec gets a clean instance.
 *
 * Runs in teardown (closeBrowser) and, defensively, again right before the next
 * spec connects (newBrowser) — teardown alone has two holes that still poison
 * the next launch: taskkill returns before the OS releases :4445, and a spec
 * whose own beforeAll timed out never set `current`, so its closeBrowser was a
 * no-op and nothing was reclaimed. No-op on macOS/Linux: they dismiss the dialog
 * reliably, those CI rows don't exhibit the cascade, and a name-based kill
 * there could take out a developer's `tauri dev` instance during a local run.
 */
async function forceKillApp(): Promise<void> {
  if (process.platform !== 'win32') return;
  await new Promise<void>((resolve) => {
    try {
      // /F force, /T kill the process tree. The e2e build is the debug binary
      // `forwardemail-desktop.exe` (see support/platform.ts).
      execFile('taskkill', ['/F', '/T', '/IM', 'forwardemail-desktop.exe'], () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Resolves true when nothing is listening on the in-app webdriver port — i.e. a
 * prior app instance has fully exited and released it. A localhost connect
 * either completes or refuses promptly; on the unlikely timeout we treat the
 * port as free (no firewall drops loopback) so the wait can't wedge.
 */
function isPortFree(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (free: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(false)); // something is still listening
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true)); // ECONNREFUSED → free
  });
}

async function waitForPortFree(port: number, capMs = 6000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Best-effort: fall through after the cap. remote() then proceeds as it did
  // before this guard existed — no worse than the prior behaviour.
}

/** Reject after `ms` without disturbing the underlying promise. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Windows cold-start budget. On a fresh CI runner the first launch(es) of the
// just-built debug `forwardemail-desktop.exe` get scanned by Windows Defender,
// so the app can take ~20s+ to boot and bind :4445 (CI logs: first launch ~21s,
// subsequent warm launches ~2-10s). Session creation must simply WAIT for that
// in a SINGLE attempt — an earlier tight-cap retry killed the app mid-boot,
// which only restarted the scan and cascaded `IncompleteMessage` into the next
// spec. webdriverio's default 120s connectionRetryTimeout would mask a genuine
// hang, so cap it here and let the (raised) 60s beforeAll ceiling backstop it.
const WIN_SESSION_TIMEOUT_MS = 45_000;
// Once the in-app server answers, its native window can still take several
// seconds to register. Let webdriverio retry the same POST /session request so
// the already-running app can finish initialization; killing and relaunching on
// this response simply restarts the race. Six retries provide 15.5s of bounded
// exponential backoff inside the 45s session budget.
const WIN_SESSION_RETRY_COUNT = 6;

export async function newBrowser(opts: RemoteOptions): Promise<WebdriverIO.Browser> {
  // macOS/Linux dismiss native dialogs reliably and don't exhibit the port
  // cascade or the Defender cold-scan — keep the long-standing single,
  // generously-bounded attempt so a slower-but-healthy launch can't regress.
  if (process.platform !== 'win32') {
    current = await remote(opts);
    return current;
  }

  // Windows has two startup delays that must not trigger process churn:
  //  (1) Defender can delay the first :4445 bind, so the initial request keeps
  //      the existing generous timeout instead of killing a healthy cold boot.
  //  (2) The in-app server can answer before its native window is registered.
  //      Webdriverio retries that same request with exponential backoff while the
  //      existing process finishes initialization, rather than relaunching it.
  await forceKillApp();
  await waitForPortFree(IN_APP_WEBDRIVER_PORT, 3000);

  const winOpts: RemoteOptions = {
    connectionRetryTimeout: WIN_SESSION_TIMEOUT_MS,
    connectionRetryCount: WIN_SESSION_RETRY_COUNT,
    ...opts,
  };

  current = await withTimeout(
    remote(winOpts),
    WIN_SESSION_TIMEOUT_MS + 2000,
    `webdriver session creation exceeded ${WIN_SESSION_TIMEOUT_MS}ms (Windows cold-start)`,
  );
  return current;
}

export function currentBrowser(): WebdriverIO.Browser | undefined {
  return current;
}

export async function closeBrowser(): Promise<void> {
  if (!current) return;
  const browser = current;
  current = undefined;
  // Bound deleteSession: a stuck native modal can make it hang. Attach a catch
  // so the eventual (post-kill) rejection isn't unhandled, then force-kill as
  // the real cleanup.
  const deleted = browser.deleteSession().catch(() => {});
  await Promise.race([deleted, new Promise<void>((resolve) => setTimeout(resolve, 8000))]);
  await forceKillApp();
}
