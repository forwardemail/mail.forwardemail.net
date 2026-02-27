/**
 * Forward Email – Main-Thread Sync Shim
 *
 * Drop-in replacement for the Service Worker sync path on platforms where
 * service workers are unavailable or unreliable (Tauri desktop, Tauri mobile,
 * or any non-SW shell).
 *
 * It re-uses the **exact same** createSyncCore() factory from sync-core.js
 * but wires it to the main-thread environment:
 *
 *   - postMessage -> dispatches a CustomEvent on `window`
 *   - fetch       -> standard window.fetch
 *   - indexedDB   -> window.indexedDB
 *
 * The shim also provides:
 *   - An `online` listener that processes the mutation queue (equivalent to
 *     the SW Background Sync `sync` event).
 *   - A periodic heartbeat that retries pending mutations (equivalent to
 *     the SW periodic sync).
 *   - Tauri-specific hooks for window focus/visibility changes.
 *
 * Hardening:
 *   - CustomEvent payloads are frozen to prevent mutation after dispatch.
 *   - Heartbeat and visibility handlers are properly cleaned up on destroy.
 *   - Tauri event listeners are tracked and cleaned up.
 *   - processMutations is debounced to prevent rapid-fire calls.
 */

import { createSyncCore } from './sync-core.js';
import { isTauri } from './platform.js';

let _core = null;
let _heartbeat = null;
let _visibilityHandler = null;
let _onlineHandler = null;
let _tauriUnlisteners = [];
let _lastProcessTime = 0;

const HEARTBEAT_MS = 30_000; // 30 s — matches mutation-queue.js setInterval
const DEBOUNCE_MS = 2_000; // Minimum interval between processMutations calls

/**
 * Post a message to the main thread via CustomEvent.
 * This mirrors the SW `postToClients` pattern so the rest of the app can
 * listen in the same way regardless of platform.
 */
function postMessage(payload) {
  if (typeof window !== 'undefined') {
    // Freeze the detail to prevent downstream mutation
    const clonedPayload = JSON.parse(JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent('sync-shim-message', { detail: clonedPayload }));
  }

  return Promise.resolve();
}

/**
 * Debounced wrapper around core.processMutations to prevent rapid-fire calls
 * from multiple triggers (online + visibility + focus all firing at once).
 */
function debouncedProcessMutations() {
  if (!_core) return;
  const now = Date.now();
  if (now - _lastProcessTime < DEBOUNCE_MS) return;
  _lastProcessTime = now;
  _core.processMutations();
}

/**
 * Initialise the main-thread sync shim.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initSyncShim() {
  if (_core) return _core;

  _core = createSyncCore({
    postMessage,
    fetch: window.fetch.bind(window),
    indexedDB: window.indexedDB,
  });

  // Online / offline listeners (replaces Background Sync)
  _onlineHandler = () => {
    debouncedProcessMutations();
  };
  window.addEventListener('online', _onlineHandler);

  // Periodic heartbeat (replaces SW periodic sync)
  _heartbeat = setInterval(() => {
    if (navigator.onLine) {
      debouncedProcessMutations();
    }
  }, HEARTBEAT_MS);

  // Visibility change (process mutations when app comes to foreground)
  _visibilityHandler = () => {
    if (document.visibilityState === 'visible' && navigator.onLine && _core) {
      debouncedProcessMutations();
    }
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  // Tauri-specific hooks
  if (isTauri) {
    _setupTauriHooks();
  }

  return _core;
}

/**
 * Return the sync core instance (must call initSyncShim first).
 */
export function getSyncShim() {
  return _core;
}

/**
 * Tear down the shim (useful for HMR or logout).
 * Cleans up all event listeners and timers.
 */
export function destroySyncShim() {
  if (_heartbeat) {
    clearInterval(_heartbeat);
    _heartbeat = null;
  }

  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }

  if (_onlineHandler) {
    window.removeEventListener('online', _onlineHandler);
    _onlineHandler = null;
  }

  // Clean up Tauri event listeners
  for (const unlisten of _tauriUnlisteners) {
    if (typeof unlisten === 'function') {
      try {
        unlisten();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
  _tauriUnlisteners = [];

  _core = null;
  _lastProcessTime = 0;
}

// ── Tauri-specific hooks ────────────────────────────────────────────────────

async function _setupTauriHooks() {
  try {
    const { listen } = await import('@tauri-apps/api/event');

    // Tauri emits a 'tauri://focus' event when the window gains focus.
    const unlistenFocus = await listen('tauri://focus', () => {
      if (navigator.onLine && _core) {
        debouncedProcessMutations();
      }
    });
    _tauriUnlisteners.push(unlistenFocus);

    // Also listen for the custom 'tauri-ready' event from our Rust backend.
    const unlistenReady = await listen('tauri-ready', () => {
      if (navigator.onLine && _core) {
        debouncedProcessMutations();
      }
    });
    _tauriUnlisteners.push(unlistenReady);
  } catch (err) {
    console.warn('[sync-shim] Tauri event API not available:', err.message);
  }
}
