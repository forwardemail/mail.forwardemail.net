/**
 * Forward Email – Push Notifications (APNs + FCM)
 *
 * Client-side module for registering and managing push notification tokens
 * on iOS (APNs) and Android (FCM) via Tauri plugins.
 *
 * Architecture:
 *
 *   ┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
 *   │  Tauri App   │────▶│  Forward Email    │────▶│  APNs / FCM      │
 *   │  (iOS/Android)│     │  API Server       │     │  Push Service    │
 *   │              │◀────│                    │◀────│                  │
 *   └──────────────┘     └──────────────────┘     └──────────────────┘
 *     1. Get token         2. Register token        3. Send push
 *     4. Receive push      (server stores token)    (on new mail)
 *
 * The server-side component (not in this repo) is responsible for:
 *   - Storing device tokens per user
 *   - Sending push notifications via APNs/FCM when new mail arrives
 *   - Handling token refresh and invalidation
 *
 * This module handles:
 *   - Requesting push notification permission
 *   - Obtaining the device push token
 *   - Registering/unregistering the token with the Forward Email API
 *   - Handling token refresh events
 *   - Processing incoming push notification payloads
 *
 * Hardening:
 *   - Tokens are validated before server registration.
 *   - API endpoints are hardcoded (not configurable from frontend).
 *   - Token registration uses authenticated API calls.
 *   - Push payloads are validated before processing.
 */

import { isTauriMobile } from './platform.js';
import { registerPushToken, unregisterPushToken } from './background-service.js';
import {
  isUnifiedPushAvailable,
  registerUnifiedPush,
  unregisterUnifiedPush,
  initUnifiedPushListener,
  isUnifiedPushRegistered,
} from './unified-push.js';

// ── Constants ──────────────────────────────────────────────────────────────

const TOKEN_STORAGE_KEY = 'fe:push-token';
const TOKEN_PLATFORM_KEY = 'fe:push-platform';

// ── State ──────────────────────────────────────────────────────────────────

let initialized = false;
let tokenRefreshCleanup = null;

// ── Token Storage ──────────────────────────────────────────────────────────

function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeToken(token, platform) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    localStorage.setItem(TOKEN_PLATFORM_KEY, platform);
  } catch {
    // ignore
  }
}

function clearStoredToken() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(TOKEN_PLATFORM_KEY);
  } catch {
    // ignore
  }
}

// ── Platform Detection ─────────────────────────────────────────────────────

function getMobilePlatform() {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  return null;
}

// ── Push Token Acquisition ─────────────────────────────────────────────────

/**
 * Request push notification permission and obtain the device token.
 *
 * On iOS: Uses APNs via the Tauri notification plugin.
 * On Android: Uses FCM via the Tauri notification plugin.
 *
 * @returns {Promise<{token: string, platform: string} | null>}
 */
async function acquirePushToken() {
  if (!isTauriMobile) return null;

  const platform = getMobilePlatform();
  if (!platform) return null;

  try {
    // Use Tauri notification plugin to get the push token
    const notification = await import('@tauri-apps/plugin-notification');

    // Check/request permission
    const granted = await notification.isPermissionGranted();
    if (!granted) {
      const result = await notification.requestPermission();
      if (result !== 'granted') {
        console.warn('[push-notifications] Permission denied');
        return null;
      }
    }

    // Get the device token
    // Note: This requires the notification plugin to be configured with
    // FCM (Android) or APNs (iOS) credentials. See docs/PUSH_NOTIFICATIONS.md
    if (typeof notification.getDeviceToken === 'function') {
      const token = await notification.getDeviceToken();
      if (token) {
        return { token, platform };
      }
    }

    // Fallback: try the remote-push plugin if available
    try {
      const remotePush = await import('tauri-plugin-remote-push-api');
      const token = await remotePush.getToken();
      if (token) {
        return { token, platform };
      }
    } catch {
      // Plugin not available
    }

    console.warn('[push-notifications] Could not obtain push token');
    return null;
  } catch (err) {
    console.warn('[push-notifications] Token acquisition failed:', err);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize push notifications.
 * Call once during app bootstrap on mobile platforms.
 *
 * Strategy:
 *   1. Try FCM/APNs via Tauri notification plugin (standard path)
 *   2. If FCM is unavailable (no Google Play Services), fall back to UnifiedPush
 *   3. UnifiedPush works with any distributor (ntfy, NextPush, etc.)
 *
 * @param {Object} options
 * @param {string} options.authToken - User's API authentication token
 * @returns {Promise<boolean>} true if push notifications were set up
 */
export async function initPushNotifications({ authToken } = {}) {
  if (initialized) return true;
  if (!isTauriMobile) return false;
  if (!authToken) {
    console.warn('[push-notifications] No auth token provided');
    return false;
  }

  try {
    // Check if we already have a stored token (FCM/APNs)
    const existingToken = getStoredToken();
    if (existingToken) {
      const platform = getMobilePlatform();
      if (platform) {
        const success = await registerPushToken(existingToken, platform, authToken);
        if (success) {
          initialized = true;
          return true;
        }
      }
    }

    // Try FCM/APNs first
    const result = await acquirePushToken();
    if (result) {
      const success = await registerPushToken(result.token, result.platform, authToken);
      if (success) {
        storeToken(result.token, result.platform);
        initialized = true;
        await setupTokenRefreshListener();
        return true;
      }
    }

    // FCM unavailable — try UnifiedPush as fallback
    // This handles devices without Google Play Services (e.g., GrapheneOS, /e/OS)
    if (await isUnifiedPushAvailable()) {
      console.info('[push-notifications] FCM unavailable, trying UnifiedPush');
      const endpoint = await registerUnifiedPush();
      if (endpoint) {
        // Set up listener for incoming push messages
        await initUnifiedPushListener();
        initialized = true;
        console.info('[push-notifications] UnifiedPush registered');
        return true;
      }
    }

    // Check if UnifiedPush was previously registered (survives app restart)
    if (isUnifiedPushRegistered()) {
      await initUnifiedPushListener();
      initialized = true;
      return true;
    }

    console.warn('[push-notifications] No push provider available');
    return false;
  } catch (err) {
    console.warn('[push-notifications] Initialization failed:', err);
    return false;
  }
}

/**
 * Set up a listener for push token refresh events.
 * Tokens can be refreshed by the OS at any time.
 */
async function setupTokenRefreshListener() {
  if (tokenRefreshCleanup) return;

  try {
    const { listen } = await import('@tauri-apps/api/event');
    const { Local } = await import('./storage.js');
    const unlisten = await listen('push-token-refreshed', async (event) => {
      const newToken = event?.payload?.token;
      if (typeof newToken === 'string' && newToken.length > 0) {
        // Re-read authToken from storage to avoid stale closures
        const authToken = Local.get('authToken') || Local.get('api_key');
        if (!authToken) return;
        const platform = getMobilePlatform();
        if (platform) {
          const success = await registerPushToken(newToken, platform, authToken);
          if (success) {
            storeToken(newToken, platform);
          }
        }
      }
    });
    tokenRefreshCleanup = unlisten;
  } catch {
    // Event API not available
  }
}

/**
 * Handle an incoming push notification payload.
 * Called when a push notification is tapped or received while the app is open.
 *
 * @param {Object} payload - The push notification payload
 * @returns {Object|null} Parsed action to take (e.g., navigate to message)
 */
export function handlePushPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Validate payload structure
  const type = payload.type || payload.data?.type;
  if (typeof type !== 'string') return null;

  switch (type) {
    case 'new-message': {
      const uid = payload.uid || payload.data?.uid;
      const mailbox = payload.mailbox || payload.data?.mailbox || 'INBOX';
      if (uid) {
        return { action: 'navigate', path: `#${mailbox}/${uid}` };
      }
      return { action: 'navigate', path: '#INBOX' };
    }

    case 'calendar-event': {
      return { action: 'navigate', path: '#calendar' };
    }

    case 'contact-update': {
      return { action: 'navigate', path: '#contacts' };
    }

    default:
      return null;
  }
}

/**
 * Clean up push notifications.
 * Call on sign-out to unregister the device token.
 *
 * @param {string} authToken - User's API authentication token
 */
export async function cleanupPushNotifications(authToken) {
  if (tokenRefreshCleanup) {
    tokenRefreshCleanup();
    tokenRefreshCleanup = null;
  }

  if (authToken) {
    await unregisterPushToken(authToken);
  }

  // Also clean up UnifiedPush if it was registered
  if (isUnifiedPushRegistered()) {
    await unregisterUnifiedPush();
  }

  clearStoredToken();
  initialized = false;
}

/**
 * Check if push notifications are initialized.
 */
export function isPushInitialized() {
  return initialized;
}
