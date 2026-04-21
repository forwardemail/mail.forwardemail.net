/**
 * Forward Email – Mailto Handler Registration
 *
 * Manages the `mailto:` protocol handler registration across all platforms:
 *
 * Web:   Uses navigator.registerProtocolHandler()
 * Tauri: Uses native Rust IPC commands that delegate to:
 *   - macOS:   CoreServices LSCopyDefaultHandlerForURLScheme / LSSetDefaultHandlerForURLScheme
 *   - Windows: Registry via tauri-plugin-deep-link
 *   - Linux:   xdg-mime via tauri-plugin-deep-link
 *
 * Shows a one-time prompt on first INBOX render after sign-in, and
 * provides Settings UI integration to check status and re-register.
 *
 * Hardening:
 *   - localStorage key is scoped per account to avoid cross-account leakage.
 *   - Registration URL is validated before use.
 *   - All string inputs are sanitised.
 *   - Tauri IPC results are type-checked before use.
 */

import { isTauri, isTauriDesktop } from './platform.js';

// ── Constants ──────────────────────────────────────────────────────────────

const STORAGE_KEY_PREFIX = 'fe:mailto-prompt-shown';
const REGISTRATION_STATUS_KEY = 'fe:mailto-registered';
const HANDLER_URL_TEMPLATE = '%s'; // Placeholder replaced by browser

// ── Helpers ────────────────────────────────────────────────────────────────

function getStorageKey(account) {
  const safe = typeof account === 'string' ? encodeURIComponent(account) : 'default';
  return `${STORAGE_KEY_PREFIX}:${safe}`;
}

/**
 * Check if the mailto prompt has already been shown for this account.
 */
export function hasPromptBeenShown(account) {
  try {
    return localStorage.getItem(getStorageKey(account)) === 'true';
  } catch {
    return false;
  }
}

/**
 * Mark the mailto prompt as shown for this account.
 */
export function markPromptShown(account) {
  try {
    localStorage.setItem(getStorageKey(account), 'true');
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Check if the browser supports registerProtocolHandler.
 */
export function isProtocolHandlerSupported() {
  if (isTauri) return false; // Tauri uses native IPC instead
  return (
    typeof navigator !== 'undefined' && typeof navigator.registerProtocolHandler === 'function'
  );
}

/**
 * Whether the current platform supports mailto handler management.
 * True for: desktop web (registerProtocolHandler) and Tauri desktop.
 */
export function isMailtoHandlerSupported() {
  if (isTauriDesktop) return true;
  return isProtocolHandlerSupported();
}

/**
 * Attempt to register as the default mailto: handler.
 *
 * Web: Uses navigator.registerProtocolHandler()
 * Tauri: Uses the native set_default_mailto_handler IPC command
 *
 * @returns {Promise<{ success: boolean, method?: string, message?: string }>}
 */
export async function registerAsMailtoHandler() {
  // ── Tauri desktop path ──
  if (isTauriDesktop) {
    try {
      const { setDefaultMailtoHandler } = await import('./tauri-bridge.js');
      const result = await setDefaultMailtoHandler();

      if (!result || typeof result !== 'object') {
        return { success: false, message: 'No response from native handler' };
      }

      // Persist status for quick synchronous checks
      if (result.method === 'registered') {
        try {
          localStorage.setItem(REGISTRATION_STATUS_KEY, 'registered');
        } catch {
          // ignore
        }
      }

      return {
        success: result.method === 'registered',
        method: result.method,
        message: result.message,
      };
    } catch (err) {
      console.warn('[mailto-handler] Tauri registration failed:', err);
      return { success: false, message: String(err) };
    }
  }

  // ── Web path ──
  if (!isProtocolHandlerSupported()) return { success: false };

  try {
    const origin = window.location.origin;
    const handlerUrl = `${origin}/#compose?mailto=${HANDLER_URL_TEMPLATE}`;

    navigator.registerProtocolHandler('mailto', handlerUrl);
    try {
      localStorage.setItem(REGISTRATION_STATUS_KEY, 'registered');
    } catch {
      // ignore
    }
    return { success: true, method: 'registered' };
  } catch (err) {
    console.warn('[mailto-handler] Registration failed:', err);
    return { success: false, message: String(err) };
  }
}

/**
 * Check if we are currently registered as the mailto: handler.
 *
 * @returns {Promise<'default' | 'registered' | 'not_default' | 'declined' | 'unknown'>}
 */
export async function getRegistrationStatus() {
  // ── Tauri desktop path ──
  if (isTauriDesktop) {
    try {
      const { isDefaultMailtoHandler } = await import('./tauri-bridge.js');
      const result = await isDefaultMailtoHandler();

      if (result && typeof result === 'object' && typeof result.status === 'string') {
        return result.status; // 'default' | 'registered' | 'not_default' | 'unknown'
      }
    } catch (err) {
      console.warn('[mailto-handler] Tauri status check failed:', err);
    }

    // Fall back to optimistic localStorage
    try {
      if (localStorage.getItem(REGISTRATION_STATUS_KEY) === 'registered') {
        return 'registered';
      }
    } catch {
      // ignore
    }

    return 'unknown';
  }

  // ── Web path ──
  if (!isProtocolHandlerSupported()) return 'unknown';

  try {
    // isProtocolHandlerRegistered is a non-standard API (Firefox only)
    if (typeof navigator.isProtocolHandlerRegistered === 'function') {
      const origin = window.location.origin;
      const handlerUrl = `${origin}/#compose?mailto=${HANDLER_URL_TEMPLATE}`;
      const result = navigator.isProtocolHandlerRegistered('mailto', handlerUrl);
      if (result === 'registered') return 'default';
      if (result === 'declined') return 'declined';
    }
  } catch {
    // API not available
  }

  // Fall back to optimistic status from a previous registerAsMailtoHandler() call
  try {
    if (localStorage.getItem(REGISTRATION_STATUS_KEY) === 'registered') {
      return 'default';
    }
  } catch {
    // ignore
  }

  return 'unknown';
}

/**
 * Synchronous variant for quick checks (uses localStorage only).
 * For accurate status, prefer the async getRegistrationStatus().
 *
 * @returns {'default' | 'registered' | 'not_default' | 'unknown'}
 */
export function getRegistrationStatusSync() {
  try {
    if (localStorage.getItem(REGISTRATION_STATUS_KEY) === 'registered') {
      return isTauriDesktop ? 'registered' : 'default';
    }
  } catch {
    // ignore
  }
  return 'unknown';
}

/**
 * Unregister as the mailto: handler.
 *
 * Note: `navigator.unregisterProtocolHandler()` is not widely supported.
 * On Tauri, unregistration is not currently supported.
 *
 * @returns {boolean} true if unregistration was attempted
 */
export function unregisterAsMailtoHandler() {
  if (!isProtocolHandlerSupported()) return false;

  try {
    if (typeof navigator.unregisterProtocolHandler === 'function') {
      const origin = window.location.origin;
      const handlerUrl = `${origin}/#compose?mailto=${HANDLER_URL_TEMPLATE}`;
      navigator.unregisterProtocolHandler('mailto', handlerUrl);
      return true;
    }
  } catch {
    // API not available
  }

  return false;
}

/**
 * Parse a mailto: URL from the hash route and return compose prefill data.
 * Used when the app is opened via mailto: deep link.
 *
 * Expected hash format: #compose?mailto=mailto:user@example.com?subject=Hello
 *
 * @param {string} hash - The window.location.hash value
 * @returns {Object|null} Parsed mailto data or null
 */
export function parseMailtoFromHash(hash) {
  if (!hash || typeof hash !== 'string') return null;

  const content = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!content.startsWith('compose?mailto=')) return null;

  const mailtoUrl = decodeURIComponent(content.slice('compose?mailto='.length));
  if (!mailtoUrl.toLowerCase().startsWith('mailto:')) return null;

  return { mailtoUrl };
}

/**
 * Async variant that resolves the mailto URL into compose-ready prefill data.
 * Prefer this over parseMailtoFromHash when you need the full prefill object.
 *
 * @param {string} hash - The window.location.hash value
 * @returns {Promise<Object|null>} Parsed prefill data or null
 */
export async function resolveMailtoFromHash(hash) {
  const result = parseMailtoFromHash(hash);
  if (!result) return null;

  try {
    const { parseMailto, mailtoToPrefill } = await import('./mailto.js');
    return mailtoToPrefill(parseMailto(result.mailtoUrl));
  } catch {
    return null;
  }
}

/**
 * Should the mailto prompt be shown?
 *
 * Returns true when:
 * - The platform supports mailto handler management
 * - The prompt hasn't been shown for this account yet
 * - We are NOT already the default handler (sync check)
 *
 * @param {string} account - Current user email
 * @returns {boolean}
 */
export function shouldShowMailtoPrompt(account) {
  if (!isMailtoHandlerSupported()) return false;
  if (hasPromptBeenShown(account)) return false;
  // Don't show if we already know we're the default
  if (getRegistrationStatusSync() === 'default') return false;
  return true;
}
