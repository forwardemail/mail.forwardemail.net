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
