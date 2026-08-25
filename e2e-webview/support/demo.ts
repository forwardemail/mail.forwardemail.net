import { currentPath } from './state.js';
import { openApp } from './app.js';

export async function activateDemo(browser: WebdriverIO.Browser): Promise<void> {
  let tryDemo = await browser.$('[data-testid="try-demo-btn"]');
  // 30s, not 15s: on the slowest gating runners the login screen's cold-start
  // render (especially after a spec's clearStorage + double openApp reload,
  // with the WebView offscreen) has intermittently crossed 15s, flaking
  // activateDemo before the app even painted the button.
  try {
    await tryDemo.waitForExist({ timeout: 30_000 });
  } catch {
    // Two distinct failures land here and only one is a bug. On the
    // software-GL Linux runner, WebKitGTK occasionally wedges so hard on one
    // cold start that even WebDriver's findElements script times out (the
    // "Script execution timed out" warnings) - no selector timeout can see a
    // button on a page whose event loop is stuck. One relaunch un-wedges that
    // case. A genuinely missing button fails the second wait on a healthy
    // page, so the gate keeps its teeth. The diagnostics say which case it
    // was: a wedged page reports nothing, a healthy page missing the button
    // reports its actual path and paint state.
    const diag = await browser
      .execute(() => ({
        path: location.pathname,
        readyState: document.readyState,
        bodyChildren: document.body?.children.length ?? 0,
      }))
      .catch(() => 'page unresponsive (execute timed out)');
    console.warn(
      `[activateDemo] try-demo-btn absent after 30s; diagnostics: ${JSON.stringify(diag)}. Relaunching the app once.`,
    );
    await openApp(browser);
    tryDemo = await browser.$('[data-testid="try-demo-btn"]');
    await tryDemo.waitForExist({ timeout: 30_000 });
  }

  // Click via the native DOM rather than WDIO's actionability click.
  // On the macOS-arm64 CI runner the app window spawns very short
  // (~190px tall), leaving the Try Demo button below the viewport even
  // after scrollIntoView — WDIO's waitForClickable then times out with
  // "still not clickable after 15000ms" because it requires the element
  // to be in-viewport and unobscured. A direct element.click() fires the
  // Svelte onclick handler regardless of viewport position, which is all
  // we need to enter demo mode. element.click() is also immune to the
  // transient overlays (sync banners, etc.) that intercept pointer
  // events in WDIO's hit-testing.
  await tryDemo.scrollIntoView({ block: 'center' }).catch(() => {});
  const clicked = (await browser.execute((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.click();
    return true;
  }, '[data-testid="try-demo-btn"]')) as boolean;
  if (!clicked) {
    // Fall back to the standard click if the DOM query missed (e.g. the
    // testid changed) so the failure message points at the real problem.
    await tryDemo.waitForClickable({ timeout: 15_000 });
    await tryDemo.click();
  }

  await browser.waitUntil(async () => (await currentPath(browser)).startsWith('/mailbox'), {
    timeout: 30_000,
    timeoutMsg: 'expected navigation to /mailbox after Try Demo',
  });
  const shell = await browser.$('[data-testid="mailbox-shell"]');
  await shell.waitForDisplayed({ timeout: 30_000 });

  // Wait for demo data to actually render — not just the shell. Slower CI
  // runners (Linux Xvfb especially) take noticeably longer to paint the first
  // page, so individual specs that assert on folders/message rows immediately
  // after activateDemo were racing the seed and flaking with "expected 0 to be
  // greater than 0" or "folder-item … not existing". Centralising the readiness
  // gate here means every spec starts from a populated mailbox. The demo always
  // lands on INBOX with seeded folders + messages, so both selectors are
  // guaranteed to appear.
  await browser.waitUntil(
    async () => {
      // Count both in a single in-page execute rather than two browser.$$
      // findElements round-trips per poll. On the slow Linux WebKitGTK runner
      // each WebDriver round-trip is expensive, and polling them in a loop
      // compounded the latency that pushed this gate over its timeout.
      const counts = (await browser.execute(() => ({
        folders: document.querySelectorAll('[data-testid="folder-item"]').length,
        rows: document.querySelectorAll('[data-testid="message-row"]').length,
      }))) as { folders: number; rows: number };
      return counts.folders > 0 && counts.rows > 0;
    },
    {
      // Generous ceiling for the slowest CI runner (Linux Xvfb). waitUntil
      // resolves the moment the rows appear, so fast runners (Windows/macOS)
      // pay nothing for it.
      timeout: 60_000,
      timeoutMsg: 'demo data did not render (expected folder-item + message-row)',
    },
  );
}
