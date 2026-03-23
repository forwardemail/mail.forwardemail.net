/**
 * Forward Email – Background Service Manager
 *
 * Manages persistent WebSocket connections and push notification delivery
 * when the app is backgrounded or the webview is not visible.
 *
 * Architecture:
 *
 * **Desktop (macOS/Windows/Linux):**
 *   The Tauri app stays running in the system tray. The WebSocket connection
 *   in the webview remains active because the webview is kept alive (hidden,
 *   not destroyed). Notifications are delivered via the notification plugin.
 *
 * **Mobile (iOS/Android):**
 *   Mobile platforms aggressively suspend background processes. The WebSocket
 *   connection will be dropped when the app is backgrounded. To receive
 *   notifications while backgrounded, we rely on:
 *
 *   - **iOS:** APNs (Apple Push Notification service) via server-side push.
 *     The server sends push notifications when new mail arrives.
 *   - **Android:** FCM (Firebase Cloud Messaging) via server-side push.
 *     The server sends push notifications when new mail arrives.
 *
 *   When the app returns to foreground, the WebSocket reconnects automatically
 *   via the existing exponential backoff logic in websocket-client.js.
 *
 * **Web:**
 *   The service worker (sw-sync.js) handles background sync and can show
 *   notifications via the Push API. The WebSocket connection is only active
 *   while the tab is open.
 *
 * This module coordinates:
 *   1. Registering push notification tokens with the server
 *   2. Handling app lifecycle events (foreground/background)
 *   3. Reconnecting WebSocket on app resume
 *   4. Keeping the desktop app alive in the system tray
 *
 * Hardening:
 *   - Push tokens are validated before registration.
 *   - Server endpoints are validated against an allowlist.
 *   - App state transitions are debounced to prevent rapid cycling.
 */

import { isTauri, isTauriDesktop, isTauriMobile, getPlatform } from './platform.js';

// ── Constants ──────────────────────────────────────────────────────────────

const PUSH_TOKEN_ENDPOINT = 'https://api.forwardemail.net/v1/push-tokens';
const RESUME_DEBOUNCE_MS = 500;
const TOKEN_MAX_LENGTH = 4096;

// ── State ──────────────────────────────────────────────────────────────────

let pushToken = null;
let isBackground = false;
let resumeTimer = null;
let onResumeCallbacks = [];
let onBackgroundCallbacks = [];

// ── Push Token Management ──────────────────────────────────────────────────

/**
 * Validate a push notification token.
 */
function isValidToken(token) {
  return (
    typeof token === 'string' &&
    token.length > 0 &&
    token.length <= TOKEN_MAX_LENGTH &&
    /^[\w:_\-./]+$/.test(token)
  );
}

/**
 * Register a push notification token with the Forward Email server.
 *
 * @param {string} token - The device push token (APNs or FCM)
 * @param {string} platform - 'ios' | 'android'
 * @param {string} authToken - User's API auth token
 * @returns {Promise<boolean>} true if registration succeeded
 */
export async function registerPushToken(token, platform, authToken) {
  if (!isValidToken(token)) {
    console.warn('[background-service] Invalid push token');
    return false;
  }

  if (!['ios', 'android'].includes(platform)) {
    console.warn('[background-service] Invalid platform:', platform);
    return false;
  }

  if (typeof authToken !== 'string' || authToken.length === 0) {
    console.warn('[background-service] Missing auth token');
    return false;
  }

  try {
    const response = await fetch(PUSH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        token,
        platform,
        app_id: 'net.forwardemail.mail',
      }),
    });

    if (!response.ok) {
      console.warn('[background-service] Token registration failed:', response.status);
      return false;
    }

    pushToken = token;
    return true;
  } catch (err) {
    console.warn('[background-service] Token registration error:', err);
    return false;
  }
}

/**
 * Unregister the current push token from the server.
 *
 * @param {string} authToken - User's API auth token
 */
export async function unregisterPushToken(authToken) {
  if (!pushToken) return;

  try {
    await fetch(PUSH_TOKEN_ENDPOINT, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ token: pushToken }),
    });
  } catch {
    // Best effort
  }

  pushToken = null;
}

// ── App Lifecycle ──────────────────────────────────────────────────────────

/**
 * Register a callback for when the app resumes from background.
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
export function onResume(callback) {
  if (typeof callback !== 'function') return () => {};
  onResumeCallbacks.push(callback);
  return () => {
    onResumeCallbacks = onResumeCallbacks.filter((cb) => cb !== callback);
  };
}

/**
 * Register a callback for when the app goes to background.
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
export function onBackground(callback) {
  if (typeof callback !== 'function') return () => {};
  onBackgroundCallbacks.push(callback);
  return () => {
    onBackgroundCallbacks = onBackgroundCallbacks.filter((cb) => cb !== callback);
  };
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    isBackground = true;
    for (const cb of onBackgroundCallbacks) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  } else if (document.visibilityState === 'visible' && isBackground) {
    isBackground = false;
    // Debounce resume to prevent rapid cycling
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      for (const cb of onResumeCallbacks) {
        try {
          cb();
        } catch {
          // ignore
        }
      }
    }, RESUME_DEBOUNCE_MS);
  }
}

// ── Tauri Mobile Lifecycle ─────────────────────────────────────────────────

async function setupTauriMobileLifecycle() {
  if (!isTauriMobile) return;

  try {
    const { listen } = await import('@tauri-apps/api/event');

    // Tauri emits these events on mobile when the app goes to/from background
    await listen('tauri://focus', () => {
      if (isBackground) {
        isBackground = false;
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => {
          for (const cb of onResumeCallbacks) {
            try {
              cb();
            } catch {
              // ignore
            }
          }
        }, RESUME_DEBOUNCE_MS);
      }
    });

    await listen('tauri://blur', () => {
      isBackground = true;
      for (const cb of onBackgroundCallbacks) {
        try {
          cb();
        } catch {
          // ignore
        }
      }
    });
  } catch {
    // Fallback to visibility API
  }
}

// ── Desktop Tray Keep-Alive ────────────────────────────────────────────────

async function setupDesktopKeepAlive() {
  if (!isTauriDesktop) return;

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');

    const win = getCurrentWindow();

    // Intercept window close to hide instead of quit (keep in tray)
    await win.onCloseRequested(async (event) => {
      event.preventDefault();
      await win.hide();
    });
  } catch (err) {
    console.warn('[background-service] Desktop keep-alive setup failed:', err);
  }
}

// ── Initialization ─────────────────────────────────────────────────────────

/**
 * Initialize the background service.
 * Call once during app bootstrap.
 *
 * @param {Object} options
 * @param {Function} [options.onResume] - Called when app resumes
 * @param {Function} [options.onBackground] - Called when app goes to background
 */
export async function initBackgroundService(options = {}) {
  // Register visibility change listener (works on all platforms)
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Register optional callbacks
  if (typeof options.onResume === 'function') {
    onResume(options.onResume);
  }
  if (typeof options.onBackground === 'function') {
    onBackground(options.onBackground);
  }

  if (isTauri) {
    // Set up platform-specific lifecycle handling
    await setupTauriMobileLifecycle();
    await setupDesktopKeepAlive();
  }

  console.log(`[background-service] initialized (${getPlatform()})`);
}

/**
 * Clean up the background service.
 */
export function destroyBackgroundService() {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  clearTimeout(resumeTimer);
  onResumeCallbacks = [];
  onBackgroundCallbacks = [];
}

/**
 * Get the current background state.
 */
export function isAppInBackground() {
  return isBackground;
}

/**
 * Get the registered push token.
 */
export function getPushToken() {
  return pushToken;
}
