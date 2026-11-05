/**
 * Whether this webview can run the email frame with an opaque origin.
 *
 * The email body renders in a sandboxed srcdoc iframe. Without
 * allow-same-origin its document has an opaque origin, so script that got past
 * the sanitizer and the frame CSP could not reach the app or its native
 * bridge. Recent engines (WebView2, WebKitGTK on Ubuntu 24.04, WKWebView on
 * macOS 26) run the frame's runtime that way. Older WebKit does not: on macOS
 * 15 and Ubuntu 22.04 the runtime never reports in, so the frame keeps a
 * default height and links in it do nothing.
 *
 * So the engine is asked once per session. A hidden opaque-origin frame loads
 * the same runtime the email frame uses and must say it is ready. If it does,
 * email frames are opaque. If it does not within the time allowed, they keep
 * allow-same-origin as before, and the sanitizer and frame CSP remain the
 * boundary on that engine. The probe document is the app's own and holds no
 * email content, so nothing an email contains can sway the answer.
 *
 * Only a yes is stored for the session. A main thread busy at launch holds the
 * probe frame's runtime back as well, so running out of time can also mean
 * the engine was slow to answer: the probe keeps listening for a while and
 * takes a late yes, and a no lasts only until the app is next loaded.
 */
import { buildIframeSrcdoc } from './iframe-srcdoc';

const SESSION_KEY = 'fe_opaque_frame_support';
const PROBE_TIMEOUT_MS = 3000;
// How long a probe that ran out of time still waits for a late ready
const LATE_READY_MS = 30000;

let pending: Promise<boolean> | null = null;
let known: boolean | null = null;

function readSession(): boolean | null {
  try {
    // A stored "0" came from a probe that ran out of time; it is asked again
    return sessionStorage.getItem(SESSION_KEY) === '1' ? true : null;
  } catch {
    return null;
  }
}

function rememberSupported(): void {
  known = true;
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // the probe just runs again next time
  }
}

/** The answer if already known this session, else null. */
export function knownOpaqueFrameSupport(): boolean | null {
  if (known === null) known = readSession();
  return known;
}

function runProbe(timeoutMs: number, onLateReady: () => void): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || !document.body) {
      resolve(false);
      return;
    }
    const token = `probe-${Math.random().toString(36).slice(2)}`;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText =
      'position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0;visibility:hidden';

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const stop = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { type?: string; payload?: { token?: string } } | null;
      if (data?.type !== 'ready' || data.payload?.token !== token) return;
      stop();
      if (timedOut) onLateReady();
      else resolve(true);
    };

    window.addEventListener('message', onMessage);
    timer = setTimeout(() => {
      timedOut = true;
      resolve(false);
      timer = setTimeout(stop, LATE_READY_MS);
    }, timeoutMs);
    frame.srcdoc = buildIframeSrcdoc('<p></p>', false, false, token);
    document.body.appendChild(frame);
  });
}

/** Ask the engine once per session; later calls share the answer. */
export function probeOpaqueFrameSupport(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const cached = knownOpaqueFrameSupport();
  if (cached !== null) return Promise.resolve(cached);
  if (!pending) {
    pending = runProbe(timeoutMs, rememberSupported).then((supported) => {
      if (supported) {
        rememberSupported();
      } else {
        // Not stored, so the next load asks again
        known = false;
        console.warn(
          '[frame-isolation] the email frame runtime did not report in with an opaque origin; using allow-same-origin',
        );
      }
      return supported;
    });
  }
  return pending;
}

/** Test seam. */
export function resetFrameIsolationProbeForTests(): void {
  pending = null;
  known = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // nothing stored
  }
}
