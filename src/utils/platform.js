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
 * True when running inside a Tauri desktop webview.
 */
export const isTauriDesktop =
  isTauri &&
  typeof navigator !== 'undefined' &&
  !/android|iphone|ipad|ipod/i.test(navigator.userAgent);

/**
 * True when running inside a Tauri mobile webview (Android or iOS).
 */
export const isTauriMobile =
  isTauri &&
  typeof navigator !== 'undefined' &&
  /android|iphone|ipad|ipod/i.test(navigator.userAgent);

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
