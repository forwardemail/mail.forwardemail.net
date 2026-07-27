/**
 * Honour the operating system's preferred text size.
 *
 * iOS exposes Dynamic Type to web content through the `-apple-system-body`
 * font shorthand: WKWebView resolves it to the user's chosen body size from
 * Settings > Display & Brightness > Text Size (and the larger Accessibility
 * sizes). Nothing else in the web platform reports that preference, so the only
 * way to read it is to render an element with that font and measure it.
 *
 * The measured size is turned into a ratio against the 17px iOS default and
 * published as `--fe-text-scale`, which every font-size token multiplies by
 * (tokens.css). Those tokens are also Tailwind's font-size theme variables, so
 * one value scales all app text. Only text scales: spacing, hit targets, and
 * layout stay put, which matches how Dynamic Type behaves in native apps.
 *
 * Android is intentionally not handled here. Android WebView already applies the
 * system font scale to CSS text itself, so scaling again would compound it.
 */

import { nativePlatform } from './platform.js';

// iOS body text at the default "Large" content size. A measurement equal to
// this means the user has not changed anything and the scale is exactly 1.
const IOS_DEFAULT_BODY_PX = 17;

// The accessibility sizes go far past what a three-pane mail layout can absorb
// (up to ~53px body text, over 3x). Clamp so the largest settings stay usable
// and readable rather than reflowing into unusable columns. The upper bound is
// generous enough to cover the whole non-accessibility range.
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.6;

// Ignore sub-pixel jitter so a re-measure that lands a hair off does not
// invalidate style on every foreground.
const EPSILON = 0.01;

let applied = 1;
let probe: HTMLSpanElement | null = null;

/**
 * Measure the OS body text size, in px, or null when the platform does not
 * report one (every non-iOS target, or a webview that resolved the shorthand
 * to its own default rather than the user's preference).
 */
function measureSystemBodyPx(): number | null {
  if (typeof document === 'undefined' || !document.body) return null;

  if (!probe) {
    probe = document.createElement('span');
    // `font` must be set as the shorthand for iOS to resolve the system text
    // style; setting font-family alone does not pick up Dynamic Type.
    probe.style.cssText =
      'position:absolute;left:-9999px;top:0;visibility:hidden;' +
      'pointer-events:none;font:-apple-system-body;';
    probe.setAttribute('aria-hidden', 'true');
    probe.textContent = 'M';
    document.body.append(probe);
  }

  const measured = Number.parseFloat(getComputedStyle(probe).fontSize);
  if (!Number.isFinite(measured) || measured <= 0) return null;
  return measured;
}

function clamp(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * Re-measure and publish the scale. Safe to call repeatedly; it only touches
 * the DOM when the value actually moved.
 */
export function refreshOsTextScale(): number {
  const measured = measureSystemBodyPx();
  if (measured === null) return applied;

  const scale = clamp(measured / IOS_DEFAULT_BODY_PX);
  if (Math.abs(scale - applied) < EPSILON) return applied;

  applied = scale;
  document.documentElement.style.setProperty('--fe-text-scale', String(scale));
  return applied;
}

/**
 * Start following the OS text size. No-op off iOS.
 *
 * iOS does not notify a webview when the content size category changes: the
 * user leaves for Settings and comes back, so the app is backgrounded in
 * between. Re-measuring when the page becomes visible again catches it. Resize
 * covers rotation and split view, where a stale measurement would also show.
 */
export function initOsTextScale(): void {
  if (nativePlatform !== 'ios') return;
  if (typeof document === 'undefined') return;

  refreshOsTextScale();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshOsTextScale();
  });
  window.addEventListener('resize', () => refreshOsTextScale());
}

/** Test seam: the current published scale. */
export function getOsTextScale(): number {
  return applied;
}
