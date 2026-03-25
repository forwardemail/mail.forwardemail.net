/**
 * Forward Email – Sync Bridge
 *
 * Unified entry point that selects the correct sync back-end based on the
 * runtime platform:
 *
 *   - Web (with SW support) -> delegates to the Service Worker via
 *     `navigator.serviceWorker.controller.postMessage(...)` (existing path).
 *
 *   - Tauri / non-SW platforms -> delegates to the main-thread
 *     `sync-shim.js` which runs the same `createSyncCore()` logic in-process.
 *
 * The rest of the application imports from this module instead of touching
 * the Service Worker or shim directly.  This keeps every call-site
 * platform-agnostic.
 *
 * Hardening:
 *   - SW message payloads are validated (type-checked, allowlisted).
 *   - Shim commands are validated before dispatch.
 *   - Sync-shim CustomEvent payloads are type-checked.
 */

import { canUseServiceWorker, swReadyWithTimeout } from './platform.js';

let _mode = null; // 'sw' | 'shim'
let _shimCore = null;

const SW_READY_TIMEOUT_MS = 5000;

// Allowlisted sync command types
const ALLOWED_COMMANDS = new Set(['startSync', 'cancelSync', 'syncStatus']);

// Allowlisted inbound message types from the sync backend
const ALLOWED_MESSAGE_TYPES = new Set([
  'syncProgress',
  'syncComplete',
  'mutationQueueProcessed',
  'dbError',
]);

/**
 * Initialise the sync bridge.  Call once at app bootstrap.
 *
 * On web, checks that the SW actually activates within a timeout.
 * If the SW API exists but the worker never activates (Chrome OS Flex,
 * storage quota issues, etc.) falls back to the main-thread shim so
 * syncing still works.
 *
 * On Tauri / non-SW platforms this lazily loads and boots the shim.
 */
export async function initSyncBridge() {
  if (canUseServiceWorker()) {
    const reg = await swReadyWithTimeout(SW_READY_TIMEOUT_MS);
    if (reg) {
      _mode = 'sw';
      return;
    }

    console.warn(
      '[sync-bridge] SW not active after %dms — falling back to shim',
      SW_READY_TIMEOUT_MS,
    );
  }

  // Lazy-load the shim so it's tree-shaken out of the web bundle
  const { initSyncShim } = await import('./sync-shim.js');
  _shimCore = initSyncShim();
  _mode = 'shim';
}

/**
 * Send a sync command.  Payload shape is identical to the existing SW
 * message protocol ({ type: 'startSync' | 'cancelSync' | 'syncStatus', ... }).
 */
export function sendSyncCommand(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
    console.warn('[sync-bridge] Invalid command payload');
    return;
  }

  if (!ALLOWED_COMMANDS.has(payload.type)) {
    console.warn('[sync-bridge] Unknown command type:', payload.type);
    return;
  }

  if (_mode === 'sw') {
    _sendViaSW(payload);
    return;
  }

  if (_mode === 'shim' && _shimCore) {
    _handleShimCommand(payload);
    return;
  }

  console.warn('[sync-bridge] No sync back-end initialised');
}

/**
 * Subscribe to sync messages from whichever back-end is active.
 * Returns an unsubscribe function.
 *
 * @param {(data: object) => void} handler
 * @returns {() => void}
 */
export function onSyncMessage(handler) {
  if (typeof handler !== 'function') return () => {};

  if (_mode === 'sw') {
    const listener = (event) => {
      // Validate the message comes from our SW (same origin)
      if (event.source && event.source !== navigator.serviceWorker.controller) {
        return; // Ignore messages from unknown sources
      }

      const data = event.data;
      if (data && typeof data === 'object' && typeof data.type === 'string') {
        if (ALLOWED_MESSAGE_TYPES.has(data.type)) {
          handler(data);
        }
      }
    };

    navigator.serviceWorker.addEventListener('message', listener);
    return () => navigator.serviceWorker.removeEventListener('message', listener);
  }

  // Shim mode — listen for CustomEvents
  const listener = (event) => {
    const detail = event.detail;
    if (detail && typeof detail === 'object' && typeof detail.type === 'string') {
      if (ALLOWED_MESSAGE_TYPES.has(detail.type)) {
        handler(detail);
      }
    }
  };

  window.addEventListener('sync-shim-message', listener);
  return () => window.removeEventListener('sync-shim-message', listener);
}

/**
 * Tear down the bridge (logout / HMR).
 */
export async function destroySyncBridge() {
  if (_mode === 'shim') {
    const { destroySyncShim } = await import('./sync-shim.js');
    destroySyncShim();
    _shimCore = null;
  }

  _mode = null;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _sendViaSW(payload) {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage(payload);
    return;
  }

  // SW controller is gone — fall back to shim dynamically
  _runtimeFallbackToShim(payload);
}

async function _runtimeFallbackToShim(payload) {
  // Already switched to shim (e.g. from a prior fallback)
  if (_mode === 'shim' && _shimCore) {
    _handleShimCommand(payload);
    return;
  }

  console.warn('[sync-bridge] SW controller lost — switching to shim');
  try {
    const { initSyncShim } = await import('./sync-shim.js');
    _shimCore = initSyncShim();
    _mode = 'shim';
    _handleShimCommand(payload);
  } catch (err) {
    console.warn('[sync-bridge] Shim fallback failed:', err);
  }
}

function _handleShimCommand(payload) {
  if (!_shimCore) return;

  switch (payload.type) {
    case 'startSync': {
      _shimCore.startSync(payload);
      break;
    }

    case 'cancelSync': {
      _shimCore.cancelSync(payload.accountId, payload.folderId);
      break;
    }

    case 'syncStatus': {
      _shimCore.getSyncStatus(payload.accountId, payload.folderId);
      break;
    }

    default:
      break;
  }
}
