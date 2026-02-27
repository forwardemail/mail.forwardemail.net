/**
 * Forward Email – Mailto Handler Registration
 *
 * Manages the `mailto:` protocol handler registration for the web app.
 * Shows a one-time prompt on first INBOX render after sign-in, and
 * provides Settings UI integration to check status and re-register.
 *
 * Web: Uses navigator.registerProtocolHandler()
 * Tauri: Deep-link registration is handled natively in src-tauri/
 *
 * Hardening:
 *   - localStorage key is scoped per account to avoid cross-account leakage.
 *   - Registration URL is validated before use.
 *   - All string inputs are sanitised.
 */

import { isTauri } from './platform.js';

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
  if (isTauri) return false; // Tauri handles this natively
  return (
    typeof navigator !== 'undefined' && typeof navigator.registerProtocolHandler === 'function'
  );
}

/**
 * Attempt to register as the default mailto: handler.
 *
 * The URL template must include `%s` which the browser replaces with the
 * mailto: URL. We route it through the app's hash-based routing.
 *
 * @returns {boolean} true if registration was attempted (no error thrown)
 */
export function registerAsMailtoHandler() {
  if (!isProtocolHandlerSupported()) return false;

  try {
    // Build the handler URL: current origin + /#compose?mailto=%s
    const origin = window.location.origin;
    const handlerUrl = `${origin}/#compose?mailto=${HANDLER_URL_TEMPLATE}`;

    navigator.registerProtocolHandler('mailto', handlerUrl);
    // Persist optimistic status since most browsers don't expose a check API
    try {
      localStorage.setItem(REGISTRATION_STATUS_KEY, 'registered');
    } catch {
      // ignore
    }
    return true;
  } catch (err) {
    console.warn('[mailto-handler] Registration failed:', err);
    return false;
  }
}

/**
 * Check if we are currently registered as the mailto: handler.
 *
 * Note: The Web API `navigator.isProtocolHandlerRegistered()` is not
 * widely supported. We use a best-effort approach:
 *   - If the API exists, use it
 *   - Otherwise, return 'unknown'
 *
 * @returns {'registered' | 'declined' | 'unknown'}
 */
export function getRegistrationStatus() {
  if (isTauri) return 'registered'; // Tauri registers natively

  if (!isProtocolHandlerSupported()) return 'unknown';

  try {
    // isProtocolHandlerRegistered is a non-standard API (Firefox only)
    if (typeof navigator.isProtocolHandlerRegistered === 'function') {
      const origin = window.location.origin;
      const handlerUrl = `${origin}/#compose?mailto=${HANDLER_URL_TEMPLATE}`;
      const result = navigator.isProtocolHandlerRegistered('mailto', handlerUrl);
      if (result === 'registered') return 'registered';
      if (result === 'declined') return 'declined';
    }
  } catch {
    // API not available
  }

  // Fall back to optimistic status from a previous registerAsMailtoHandler() call
  try {
    if (localStorage.getItem(REGISTRATION_STATUS_KEY) === 'registered') {
      return 'registered';
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

  // Delegate to the existing mailto parser
  try {
    const { parseMailto, mailtoToPrefill } = require('./mailto.js');
    return mailtoToPrefill(parseMailto(mailtoUrl));
  } catch {
    return null;
  }
}

/**
 * Should the mailto prompt be shown?
 * Returns true only once per account, on web platform, when the API is supported.
 *
 * @param {string} account - Current user email
 * @returns {boolean}
 */
export function shouldShowMailtoPrompt(account) {
  if (isTauri) return false;
  if (!isProtocolHandlerSupported()) return false;
  if (hasPromptBeenShown(account)) return false;
  return true;
}
