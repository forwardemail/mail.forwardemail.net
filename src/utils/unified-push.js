/**
 * Forward Email – UnifiedPush Client
 *
 * Provides push notifications on devices without Google Play Services
 * by integrating with the UnifiedPush protocol (https://unifiedpush.org).
 *
 * UnifiedPush works through a "distributor" app installed on the device
 * (e.g., ntfy, NextPush) that maintains a persistent connection to a
 * push server and forwards messages to registered apps.
 *
 * Flow:
 *   1. Check if a UnifiedPush distributor is available on the device
 *   2. Register with the distributor to get an endpoint URL
 *   3. Send the endpoint URL to the Forward Email API
 *   4. Server sends WebPush-encrypted HTTP POST to the endpoint on events
 *   5. Distributor forwards the message to this app
 *   6. App decrypts and displays the notification or triggers a sync
 *
 * This module is only active on Tauri Android builds where FCM is unavailable.
 */

import { config } from '../config';
import { isTauriMobile } from './platform.js';
import { Local } from './storage';

const UP_STORAGE_KEY = 'unified_push_endpoint';
const UP_REGISTERED_KEY = 'unified_push_registered';

/**
 * Check if UnifiedPush is available on this device.
 * On Tauri Android, we check for the presence of a distributor via the Tauri shell plugin.
 *
 * @returns {Promise<boolean>}
 */
export async function isUnifiedPushAvailable() {
  if (!isTauriMobile) return false;

  try {
    // Check if a UnifiedPush distributor is installed by querying the
    // Android content provider. Tauri exposes this via a custom command.
    const { invoke } = await import('@tauri-apps/api/core');
    const available = await invoke('check_unified_push');
    return Boolean(available);
  } catch {
    return false;
  }
}

/**
 * Register with the UnifiedPush distributor to receive push notifications.
 * Returns the endpoint URL that should be sent to the Forward Email API.
 *
 * @returns {Promise<string|null>} The push endpoint URL, or null on failure
 */
export async function registerUnifiedPush() {
  if (!isTauriMobile) return null;

  try {
    const { invoke } = await import('@tauri-apps/api/core');

    // Register with the distributor — this triggers an Android broadcast
    // that the distributor responds to with an endpoint URL.
    const endpoint = await invoke('register_unified_push', {
      instance: 'forwardemail-webmail',
    });

    if (!endpoint || typeof endpoint !== 'string') {
      console.warn('[unified-push] Registration returned no endpoint');
      return null;
    }

    // Store locally for re-registration after app restart
    Local.set(UP_STORAGE_KEY, endpoint);

    // Register the endpoint with the Forward Email API
    const registered = await registerEndpointWithServer(endpoint);
    if (registered) {
      Local.set(UP_REGISTERED_KEY, 'true');
      console.info('[unified-push] Registered endpoint:', endpoint.slice(0, 40) + '...');
    }

    return endpoint;
  } catch (err) {
    console.error('[unified-push] Registration failed:', err);
    return null;
  }
}

/**
 * Unregister from UnifiedPush and remove the endpoint from the server.
 *
 * @returns {Promise<void>}
 */
export async function unregisterUnifiedPush() {
  try {
    const endpoint = Local.get(UP_STORAGE_KEY);
    if (endpoint) {
      await unregisterEndpointFromServer(endpoint);
    }

    if (isTauriMobile) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('unregister_unified_push', {
        instance: 'forwardemail-webmail',
      });
    }
  } catch (err) {
    console.warn('[unified-push] Unregister error:', err);
  } finally {
    Local.remove(UP_STORAGE_KEY);
    Local.remove(UP_REGISTERED_KEY);
  }
}

/**
 * Handle an incoming UnifiedPush message.
 * Called by the Tauri event listener when the distributor forwards a push.
 *
 * @param {ArrayBuffer|string} message - The push message payload
 * @returns {Object|null} Parsed notification payload
 */
export function handlePushMessage(message) {
  try {
    let payload;
    if (typeof message === 'string') {
      payload = JSON.parse(message);
    } else if (message instanceof ArrayBuffer) {
      payload = JSON.parse(new TextDecoder().decode(message));
    } else {
      return null;
    }

    // The server sends the same flat event format as WebSocket:
    // { event: 'newMessage', mailbox: 'INBOX', ... }
    if (!payload || typeof payload.event !== 'string') {
      console.warn('[unified-push] Invalid push payload:', payload);
      return null;
    }

    return payload;
  } catch (err) {
    console.error('[unified-push] Failed to parse push message:', err);
    return null;
  }
}

/**
 * Initialize UnifiedPush event listeners on Tauri Android.
 * Listens for incoming push messages and dispatches them as DOM events.
 *
 * @returns {Promise<Function|null>} Cleanup function, or null if not available
 */
export async function initUnifiedPushListener() {
  if (!isTauriMobile) return null;

  try {
    const { listen } = await import('@tauri-apps/api/event');

    // Listen for push messages forwarded by the Tauri Android bridge
    const unlisten = await listen('unified-push-message', (event) => {
      const payload = handlePushMessage(event.payload);
      if (payload) {
        // Dispatch as a DOM event so notification-manager.js can handle it
        window.dispatchEvent(
          new CustomEvent('fe:push-notification', {
            detail: payload,
          }),
        );
      }
    });

    // Also listen for endpoint changes (distributor may rotate endpoints)
    const unlistenEndpoint = await listen('unified-push-endpoint', async (event) => {
      const newEndpoint = event.payload;
      if (typeof newEndpoint === 'string' && newEndpoint.startsWith('https://')) {
        Local.set(UP_STORAGE_KEY, newEndpoint);
        await registerEndpointWithServer(newEndpoint);
        console.info('[unified-push] Endpoint updated');
      }
    });

    return () => {
      unlisten();
      unlistenEndpoint();
    };
  } catch (err) {
    console.error('[unified-push] Failed to init listener:', err);
    return null;
  }
}

/**
 * Check if UnifiedPush is currently registered.
 *
 * @returns {boolean}
 */
export function isUnifiedPushRegistered() {
  return Local.get(UP_REGISTERED_KEY) === 'true';
}

/**
 * Get the stored UnifiedPush endpoint URL.
 *
 * @returns {string|null}
 */
export function getUnifiedPushEndpoint() {
  return Local.get(UP_STORAGE_KEY) || null;
}

// ── Private Helpers ────────────────────────────────────────────────────────

/**
 * Register the push endpoint with the Forward Email API server.
 * The server will send WebPush-encrypted HTTP POST to this endpoint.
 */
async function registerEndpointWithServer(endpoint) {
  try {
    const apiBase = config.apiBase || 'https://api.forwardemail.net';
    const authToken = Local.get('authToken') || Local.get('api_key');
    if (!authToken) {
      console.warn('[unified-push] No auth token, skipping server registration');
      return false;
    }

    const response = await fetch(`${apiBase}/v1/push/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        endpoint,
        type: 'unified-push',
      }),
    });

    if (!response.ok) {
      console.warn('[unified-push] Server registration failed:', response.status);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[unified-push] Server registration error:', err);
    return false;
  }
}

/**
 * Remove the push endpoint from the Forward Email API server.
 */
async function unregisterEndpointFromServer(endpoint) {
  try {
    const apiBase = config.apiBase || 'https://api.forwardemail.net';
    const authToken = Local.get('authToken') || Local.get('api_key');
    if (!authToken) return;

    await fetch(`${apiBase}/v1/push/unregister`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Best-effort cleanup
  }
}
