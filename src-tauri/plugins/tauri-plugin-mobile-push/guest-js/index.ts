import {
  invoke,
  addPluginListener,
  type PluginListener,
} from "@tauri-apps/api/core";

// ── Types ──────────────────────────────────────────────────────────

/** Payload delivered with push notification events. */
export interface PushNotification {
  title?: string;
  body?: string;
  data: Record<string, unknown>;
  badge?: number;
  sound?: string;
}

// ── Commands ───────────────────────────────────────────────────────

/**
 * Request permission to display push notifications.
 *
 * On iOS this triggers the system permission dialog. On Android 13+
 * (API 33) it requests the `POST_NOTIFICATIONS` runtime permission.
 * Earlier Android versions return `{ granted: true }` immediately.
 */
export async function requestPermission(): Promise<{ granted: boolean }> {
  return invoke("plugin:mobile-push|request_permission");
}

/**
 * Return the current device push token.
 *
 * - iOS: APNs device token (hex string)
 * - Android: FCM registration token
 *
 * The token may change over the lifetime of the app. Use
 * {@link onTokenRefresh} to stay up-to-date.
 */
export async function getToken(): Promise<string> {
  const result = await invoke<{ token: string }>(
    "plugin:mobile-push|get_token",
  );
  return result.token;
}

// ── Event listeners ────────────────────────────────────────────────

/**
 * Called when a push notification is received while the app is in the
 * foreground.
 */
export async function onNotificationReceived(
  handler: (notification: PushNotification) => void,
): Promise<PluginListener> {
  return addPluginListener(
    "mobile-push",
    "notification-received",
    handler,
  );
}

/**
 * Called when the user taps a push notification to open the app.
 */
export async function onNotificationTapped(
  handler: (notification: PushNotification) => void,
): Promise<PluginListener> {
  return addPluginListener(
    "mobile-push",
    "notification-tapped",
    handler,
  );
}

/**
 * Called when the platform issues a new push token (e.g., after an
 * APNs token refresh or FCM token rotation). Send the new token to
 * your backend whenever this fires.
 */
export async function onTokenRefresh(
  handler: (payload: { token: string }) => void,
): Promise<PluginListener> {
  return addPluginListener(
    "mobile-push",
    "token-received",
    handler,
  );
}
