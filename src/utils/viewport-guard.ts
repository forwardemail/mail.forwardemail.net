/**
 * Viewport guard for the mobile apps.
 *
 * On iOS, WKWebView can hand a page the wrong layout viewport: after the
 * WebContent process is killed and the page reloaded (memory pressure, often
 * while switching accounts), and occasionally after returning from the
 * background. window.innerWidth then reports a desktop-sized width on a phone,
 * so the app renders its desktop layout — search box, toolbar and folder count
 * in the header, desktop-sized list — until it is force-quit.
 *
 * The native side (SceneDelegate.swift) repairs this by cycling the webview
 * frame. This is the page's own half of the fix, for the cases the native side
 * misses and for Android:
 *
 *   - detect it: a portrait phone whose layout viewport is wider than its
 *     screen;
 *   - repair it: re-apply the viewport <meta>, which makes WebKit and Chromium
 *     recompute the layout viewport, then announce a resize so width-driven
 *     layout code re-measures;
 *   - and give layout code a width it can trust meanwhile (getLayoutWidth).
 *
 * Nothing here runs outside the mobile apps.
 */
import { isTauriMobile } from './platform.js';
import { warn } from './logger';

type Listener = (width: number) => void;

const listeners = new Set<Listener>();
let installed = false;
let repairing = false;
let lastWidth = 0;
// Set while the guard announces its own resize, so its resize listener does
// not treat that as a new event and repair again.
let announcing = false;
// Repair attempts in the current window. When the meta toggle does not fix
// the viewport (only the native frame cycle can), trying again on every
// event would loop; a few attempts, then wait for the window to pass.
const REPAIR_WINDOW_MS = 10_000;
const MAX_REPAIRS_PER_WINDOW = 3;
let repairWindowStart = 0;
let repairsInWindow = 0;

const hasWindow = () => typeof window !== 'undefined';

function isPortrait(): boolean {
  try {
    if (window.matchMedia) return window.matchMedia('(orientation: portrait)').matches;
  } catch {
    /* fall through */
  }
  return window.innerHeight >= window.innerWidth;
}

/**
 * The shorter side of the device screen in CSS pixels, which is the portrait
 * width on a phone. iOS reports screen.width in portrait terms regardless of
 * orientation; Android swaps it, so take the shorter side either way.
 */
function screenShortSide(): number {
  const w = Number(window.screen?.width) || 0;
  const h = Number(window.screen?.height) || 0;
  if (!w || !h) return 0;
  return Math.min(w, h);
}

/**
 * True when the page's layout viewport is wider than the device screen while
 * held upright: the state that renders the desktop layout on a phone.
 */
export function isViewportBroken(): boolean {
  if (!hasWindow() || !isTauriMobile) return false;
  const shortSide = screenShortSide();
  if (!shortSide || !isPortrait()) return false;
  // 15% slack for safe-area and rounding differences between engines
  return window.innerWidth > shortSide * 1.15;
}

/**
 * The width layout code should use. Equal to window.innerWidth except on a
 * portrait phone whose layout viewport is broken, where the screen width is
 * the truth and the reported width is not.
 */
export function getLayoutWidth(): number {
  if (!hasWindow()) return 1200;
  const width = window.innerWidth;
  if (isViewportBroken()) return Math.min(width, screenShortSide());
  return width;
}

function notify(): void {
  const width = getLayoutWidth();
  if (width === lastWidth) return;
  lastWidth = width;
  for (const listener of listeners) {
    try {
      listener(width);
    } catch (err) {
      warn('[viewport-guard] listener failed', err);
    }
  }
}

/**
 * Re-apply the viewport <meta>. Changing its content makes the engine
 * recompute the layout viewport; the original content is restored on the next
 * frame, so the page ends up exactly as authored.
 */
export function repairViewport(reason = 'check'): boolean {
  if (!hasWindow() || !isTauriMobile || repairing || announcing) return false;
  if (!isViewportBroken()) return false;

  const now = Date.now();
  if (now - repairWindowStart > REPAIR_WINDOW_MS) {
    repairWindowStart = now;
    repairsInWindow = 0;
  }
  if (repairsInWindow >= MAX_REPAIRS_PER_WINDOW) return false;
  repairsInWindow++;

  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return false;
  const content = meta.getAttribute('content') || '';

  repairing = true;
  warn('[viewport-guard] layout viewport wider than the screen, repairing', {
    reason,
    innerWidth: window.innerWidth,
    screen: screenShortSide(),
  });

  try {
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0');
  } catch {
    repairing = false;
    return false;
  }

  const restore = () => {
    try {
      meta.setAttribute('content', content);
    } finally {
      repairing = false;
      // width-driven code listens for resize; announce the corrected size
      announcing = true;
      try {
        window.dispatchEvent(new Event('resize'));
      } catch {
        /* ignore */
      } finally {
        announcing = false;
      }
      notify();
    }
  };

  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => restore());
  else setTimeout(restore, 16);
  return true;
}

/**
 * Subscribe to layout width changes (including a repaired viewport).
 * Returns an unsubscribe function.
 */
export function onLayoutWidthChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Check now and whenever the viewport can have been reset: resizes, rotation,
 * returning to the foreground, and a page restored from the back/forward
 * cache. Idempotent.
 */
export function installViewportGuard(): void {
  if (!hasWindow() || !isTauriMobile || installed) return;
  installed = true;
  lastWidth = getLayoutWidth();

  const check = (reason: string) => () => {
    if (announcing) return;
    repairViewport(reason);
    notify();
  };

  window.addEventListener('resize', check('resize'), { passive: true });
  window.addEventListener('orientationchange', check('orientation'));
  window.addEventListener('pageshow', check('pageshow'));
  // dispatched by the iOS side (SceneDelegate.swift); Android is covered by
  // visibilitychange below
  window.addEventListener('fe:app-foreground', check('foreground'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check('visible')();
  });
  window.visualViewport?.addEventListener?.('resize', check('visual-viewport'), {
    passive: true,
  });

  // A reload can lay the page out before the native frame settles; look
  // again shortly after start as well as now.
  check('start')();
  setTimeout(check('start+500'), 500);
  setTimeout(check('start+2000'), 2000);
}

/** Test helper: forget installed state and listeners. */
export function __resetViewportGuardForTests(): void {
  listeners.clear();
  installed = false;
  repairing = false;
  announcing = false;
  lastWidth = 0;
  repairWindowStart = 0;
  repairsInWindow = 0;
}
