/* global ServiceWorkerGlobalScope */
/**
 * Forward Email – Platform Detection
 *
 * Single source of truth for runtime platform detection.
 * Used by adapters, notification managers, and build scripts to
 * branch on platform without scattering typeof checks everywhere.
 */

/**
 * True when running inside a Tauri webview (desktop or mobile).
 */
export const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);

/**
 * The native OS reported by @tauri-apps/plugin-os. The plugin injects this
 * value into the webview before any JS runs, so it is authoritative and does
 * not depend on the user-agent string. A custom Tauri user-agent, an Android
 * WebView UA, or iPadOS (which reports a desktop "Macintosh" UA) all make
 * navigator.userAgent unreliable for platform branching.
 *   'windows' | 'macos' | 'linux' | 'android' | 'ios', or null outside Tauri.
 */
function readNativePlatform() {
  if (!isTauri || typeof window === 'undefined') return null;

  const pluginPlatform = window.__TAURI_OS_PLUGIN_INTERNALS__?.platform;
  if (typeof pluginPlatform === 'string') return pluginPlatform;

  // Older builds may not have initialized the OS plugin global yet. Keep
  // user-agent detection as a fallback for the two mobile targets we branch on.
  if (typeof navigator === 'undefined') return null;
  if (/android/i.test(navigator.userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return 'ios';
  return null;
}

export const nativePlatform = readNativePlatform();

/**
 * True when running inside a Tauri desktop webview.
 */
export const isTauriDesktop = isTauri && nativePlatform !== 'android' && nativePlatform !== 'ios';

/**
 * True when running inside a Tauri mobile webview (Android or iOS).
 */
export const isTauriMobile = isTauri && (nativePlatform === 'android' || nativePlatform === 'ios');

export const isServiceWorkerSupported =
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

export const isServiceWorkerContext =
  typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope;

/**
 * Returns a string tag for the current runtime.
 *   'tauri-desktop' | 'tauri-mobile' | 'web'
 */
export function getPlatform() {
  if (isTauriDesktop) return 'tauri-desktop';
  if (isTauriMobile) return 'tauri-mobile';
  return 'web';
}

/**
 * Returns the operating system the webview is running on.
 *   'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown'
 *
 * Exposed on <html data-os="..."> at startup so CSS can scope
 * engine-specific workarounds (e.g. WebView2 rendering bugs on Windows).
 */
export function getOS() {
  // Prefer the authoritative native platform inside Tauri. The OS plugin
  // reports the same tags this function returns, plus BSD variants that the
  // allowlist below collapses to 'unknown'. Outside Tauri nativePlatform is
  // null, so fall back to the user agent, which is reliable in real browsers.
  if (nativePlatform && ['windows', 'macos', 'linux', 'android', 'ios'].includes(nativePlatform)) {
    return nativePlatform;
  }

  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/windows/i.test(ua)) return 'windows';
  if (/macintosh|mac os x/i.test(ua)) return 'macos';
  if (/linux/i.test(ua)) return 'linux';
  return 'unknown';
}

/**
 * Whether the current platform can register a service worker.
 * False on Tauri (WRY webview uses custom scheme where SW fails).
 */
export function canUseServiceWorker() {
  if (isTauri) return false;
  return isServiceWorkerSupported;
}

/**
 * Whether the current platform supports the Background Sync API.
 */
export function canUseBackgroundSync() {
  if (!canUseServiceWorker()) return false;
  return 'SyncManager' in window;
}

/**
 * Wait for the service worker to become active, with a timeout.
 *
 * On some platforms (Chrome OS Flex, certain Linux configs) the SW API
 * exists (`'serviceWorker' in navigator` is true) but the worker never
 * activates — storage quota, corrupted cache, or browser eviction.
 * `navigator.serviceWorker.ready` hangs forever in that case.
 *
 * This helper races `.ready` against a timeout so callers can fall back
 * instead of silently hanging.
 *
 * @param {number} [timeoutMs=5000] — max milliseconds to wait
 * @returns {Promise<ServiceWorkerRegistration|null>} the registration, or null on timeout/error
 */
export function swReadyWithTimeout(timeoutMs = 5000) {
  if (!isServiceWorkerSupported) return Promise.resolve(null);

  // Already controlling — resolve immediately
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.ready.catch(() => null);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);

    navigator.serviceWorker.ready
      .then((reg) => {
        clearTimeout(timer);
        resolve(reg.active ? reg : null);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}
