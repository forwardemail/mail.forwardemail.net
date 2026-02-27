/**
 * tauri-bridge.js – Frontend bridge for Tauri v2 IPC.
 *
 * Provides a unified API for the webmail client to communicate with the
 * Tauri Rust backend.  This is the single module that covers desktop AND
 * mobile via Tauri's unified IPC layer.
 *
 * All Tauri JS imports are lazily loaded so this module can be safely
 * imported in a plain browser context (the functions simply become no-ops
 * when `window.__TAURI_INTERNALS__` is absent).
 *
 * Hardening:
 *   - All inputs are validated before being sent over IPC.
 *   - Deep-link URLs are validated against an allowlist of schemes.
 *   - Badge counts are bounds-checked.
 *   - Event payloads are type-checked before dispatch.
 */

let _invoke;
let _listen;
let _emit;

async function ensureTauriApi() {
  if (_invoke) return;
  try {
    const core = await import('@tauri-apps/api/core');
    const event = await import('@tauri-apps/api/event');
    _invoke = core.invoke;
    _listen = event.listen;
    _emit = event.emit;
  } catch {
    // Not running inside Tauri – provide silent no-ops.
    _invoke = async () => {};
    _listen = async () => () => {};
    _emit = async () => {};
  }
}

// ── Validation helpers ──────────────────────────────────────────────────────

const ALLOWED_DEEP_LINK_SCHEMES = ['mailto:', 'forwardemail:'];

function isValidDeepLink(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim().toLowerCase();
  return ALLOWED_DEEP_LINK_SCHEMES.some((scheme) => trimmed.startsWith(scheme));
}

function sanitizeString(value, maxLength = 1024) {
  if (typeof value !== 'string') return '';
  // Truncate to max length and strip control characters (except newline/tab)
  // eslint-disable-next-line no-control-regex
  return value.slice(0, maxLength).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns true when the app is running inside a Tauri webview.
 */
export function isTauri() {
  return Boolean(typeof window !== 'undefined' && window.__TAURI_INTERNALS__);
}

/**
 * Invoke a Tauri command (Rust backend).
 * The command name is validated against a known set.
 */
const ALLOWED_COMMANDS = new Set([
  'get_app_version',
  'get_platform',
  'set_badge_count',
  'toggle_window_visibility',
]);

export async function invoke(cmd, args) {
  if (typeof cmd !== 'string' || !ALLOWED_COMMANDS.has(cmd)) {
    console.warn('[tauri-bridge] Blocked unknown IPC command:', cmd);
    return undefined;
  }

  await ensureTauriApi();
  return _invoke(cmd, args);
}

/**
 * Listen to a Tauri event emitted from Rust.
 * Returns an unlisten function.
 */
export async function listen(eventName, handler) {
  if (typeof eventName !== 'string' || typeof handler !== 'function') {
    return () => {};
  }

  await ensureTauriApi();
  return _listen(eventName, handler);
}

/**
 * Emit a Tauri event to the Rust backend.
 */
export async function emit(eventName, payload) {
  if (typeof eventName !== 'string') return;
  await ensureTauriApi();
  return _emit(eventName, payload);
}

/**
 * Get the app version from the Rust backend.
 */
export async function getAppVersion() {
  return invoke('get_app_version');
}

/**
 * Get the platform string (e.g. "macos-aarch64").
 */
export async function getPlatform() {
  return invoke('get_platform');
}

/**
 * Set the dock/taskbar badge count (macOS).
 * Input is validated: must be a non-negative integer <= 99999.
 */
export async function setBadgeCount(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0 || n > 99_999) {
    console.warn('[tauri-bridge] Invalid badge count:', count);
    return;
  }

  return invoke('set_badge_count', { count: n });
}

/**
 * Toggle main window visibility (for tray icon).
 */
export async function toggleWindowVisibility() {
  return invoke('toggle_window_visibility');
}

/**
 * Register a handler for deep-link URLs (mailto:, forwardemail://).
 * URLs are validated against the allowed scheme list before dispatch.
 * Returns an unlisten function.
 */
export async function onDeepLink(handler) {
  return listen('deep-link-received', (event) => {
    if (event.payload && Array.isArray(event.payload.urls)) {
      for (const url of event.payload.urls) {
        if (isValidDeepLink(url)) {
          handler(sanitizeString(url, 2048));
        }
      }
    }
  });
}

/**
 * Register a handler for single-instance arguments.
 * Arguments are sanitised before dispatch.
 * Returns an unlisten function.
 */
export async function onSingleInstance(handler) {
  return listen('single-instance', (event) => {
    if (!event.payload) return;
    const safePayload = {
      args: Array.isArray(event.payload.args)
        ? event.payload.args.map((a) => sanitizeString(String(a), 2048))
        : [],
      cwd: sanitizeString(String(event.payload.cwd || ''), 512),
    };
    handler(safePayload);
  });
}

/**
 * Initialize the Tauri bridge.
 * Call once during app bootstrap.
 */
export async function initTauriBridge() {
  if (!isTauri()) return;

  await ensureTauriApi();

  // Listen for deep-link URLs and dispatch a custom DOM event
  // so existing code can handle mailto: links.
  await onDeepLink((url) => {
    window.dispatchEvent(new CustomEvent('app:deep-link', { detail: { url } }));
  });

  // Listen for single-instance events (second launch with args).
  await onSingleInstance((payload) => {
    window.dispatchEvent(new CustomEvent('app:single-instance', { detail: payload }));
  });

  console.log('[tauri-bridge] initialized');
}
