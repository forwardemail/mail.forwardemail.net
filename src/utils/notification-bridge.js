/**
 * Forward Email – Notification Bridge
 *
 * Cross-platform notification abstraction.  Selects the right notification
 * transport based on the runtime platform:
 *
 *   - Web       -> Notification API (+ SW showNotification for persistence)
 *   - Tauri     -> @tauri-apps/plugin-notification (desktop + mobile)
 *
 * Every call-site uses the same notify() function regardless of platform.
 *
 * Hardening:
 *   - All string inputs are sanitised (length-limited, control chars stripped).
 *   - Permission state is checked before every notification attempt.
 *   - Notification channel IDs are validated against an allowlist.
 */

import { isTauri, isTauriMobile } from './platform.js';
import { notificationDataToTarget, openNotificationTarget } from './notification-open.ts';

// Android-specific detection. tauri-plugin-notification @ 2.3.x has known
// breakage on Android (tauri-apps/plugins-workspace#2341): cancelAll throws,
// pending/active return empty or wrong types, channels() reports
// permission-denied even when granted, scheduling fails in builds. We avoid
// every one of those APIs here. createChannel itself is wrapped in try/catch
// and logs explicitly on Android so a silent failure is at least debuggable.
const isAndroid =
  isTauriMobile && typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);

let _tauriNotification;

async function ensureTauriNotification() {
  if (_tauriNotification) return _tauriNotification;
  try {
    _tauriNotification = await import('@tauri-apps/plugin-notification');
  } catch {
    _tauriNotification = null;
  }
  return _tauriNotification;
}

// ── Input sanitisation ──────────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 4096;
const MAX_TAG_LENGTH = 128;

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// Allowed Android notification channel IDs
const ALLOWED_CHANNEL_IDS = new Set(['new-mail', 'sync-status']);

// ── Notification click tracking ─────────────────────────────────────────────
//
// On macOS, the Tauri notification plugin routes dev-mode notifications through
// com.apple.Terminal (so that unbundled apps can send notifications at all).
// This means onAction callbacks never fire in dev.  In production builds the
// app's real bundle ID is used and clicks activate the correct app.
//
// Strategy:
//   1. Register an onAction handler (works in production + mobile).
//   2. Fallback: track the most recent notification and navigate when the
//      native window gains focus within a short time window.

let _lastNotificationData = null;
let _lastNotificationTime = 0;
const NOTIFICATION_CLICK_WINDOW_MS = 10_000;

// A remote push tap is being handled (push-notifications.js): the window
// gains focus because of that tap, and the focus fallback below opening the
// app's own last notification as well would navigate twice.
if (typeof window !== 'undefined') {
  window.addEventListener('fe:push-tap', () => {
    _lastNotificationData = null;
  });
}

function trackNotification(data) {
  if (!data) return;
  _lastNotificationData = data;
  _lastNotificationTime = Date.now();
}

// Opening goes through notification-open.ts, which switches account first
// when the notification is for another signed-in account and waits for App
// Lock and boot. (Switching and then navigating 150ms later lost the
// navigation: the switch itself re-selects the new account's inbox.)
function navigateToNotification(data) {
  const target = notificationDataToTarget(data);
  if (target) openNotificationTarget(target);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Request notification permission on the current platform.
 * Returns 'granted', 'denied', or 'default'.
 *
 * On the web, call this from a click or key handler: browsers ignore or
 * auto-deny a request that no user action started.
 */
export async function requestPermission() {
  if (isTauri) {
    return _requestTauriPermission();
  }

  // Web
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  try {
    // Safari before 15 only supports the callback form.
    const result = await new Promise((resolve, reject) => {
      const maybePromise = Notification.requestPermission(resolve);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    });
    return result === 'granted' || result === 'denied' ? result : 'default';
  } catch {
    return 'default';
  }
}

/**
 * The current notification permission, without prompting:
 * 'granted' | 'denied' | 'default' | 'unsupported'.
 */
export async function getPermissionState() {
  if (isTauri) {
    const mod = await ensureTauriNotification();
    if (!mod) return 'unsupported';
    try {
      return (await mod.isPermissionGranted()) ? 'granted' : 'default';
    } catch {
      return 'default';
    }
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  const state = Notification.permission;
  return state === 'granted' || state === 'denied' ? state : 'default';
}

/**
 * Whether notifications can be turned off from the app. Browsers and the
 * operating systems keep that choice in their own settings; the terminal
 * client keeps its own permission (src/cli/notifications.ts) and gives it
 * back through Notification.revokePermission().
 */
export function canRevokePermission() {
  return (
    !isTauri &&
    typeof Notification !== 'undefined' &&
    typeof Notification.revokePermission === 'function'
  );
}

/** Turns notifications off where canRevokePermission() says it can. */
export async function revokePermission() {
  if (!canRevokePermission()) return false;
  await Notification.revokePermission();
  return true;
}

/**
 * Show a notification.
 *
 * @param {Object} options
 * @param {string} options.title
 * @param {string} [options.body]
 * @param {string} [options.icon]
 * @param {string} [options.tag]     - de-duplication tag
 * @param {Object} [options.data]    - arbitrary data attached to the notification
 * @param {string} [options.channelId] - Android notification channel
 * @returns {Promise<boolean>} whether a system notification was handed to the OS
 */
export async function notify({ title, body, icon, tag, data, channelId, number }) {
  // Sanitise all string inputs
  const safeTitle = sanitize(title, MAX_TITLE_LENGTH);
  const safeBody = sanitize(body, MAX_BODY_LENGTH);
  const safeTag = sanitize(tag, MAX_TAG_LENGTH);

  if (!safeTitle) return false; // Title is required

  if (isTauri) {
    const safeChannel = channelId && ALLOWED_CHANNEL_IDS.has(channelId) ? channelId : undefined;
    const safeNumber = typeof number === 'number' && number > 0 ? Math.round(number) : undefined;
    return _notifyTauri({
      title: safeTitle,
      body: safeBody,
      channelId: safeChannel,
      data,
      number: safeNumber,
      tag: safeTag,
    });
  }

  return _notifyWeb({ title: safeTitle, body: safeBody, icon, tag: safeTag, data });
}

/**
 * Initialize notification channels for the email app (Android only).
 * Call once during app bootstrap on Tauri.
 */
export async function initNotificationChannels() {
  if (!isTauri) return;
  const mod = await ensureTauriNotification();
  if (!mod || !mod.createChannel) return;
  try {
    await mod.createChannel({
      id: 'new-mail',
      name: 'New Mail',
      description: 'Notifications for new email messages',
      importance: 4,
      visibility: 0,
      vibration: true,
      sound: 'default',
    });
    await mod.createChannel({
      id: 'sync-status',
      name: 'Sync Status',
      description: 'Background sync status notifications',
      importance: 2,
      visibility: 0,
      vibration: false,
    });
  } catch (err) {
    if (isAndroid) {
      // On Android the plugin's channel surface is the most fragile piece —
      // failing here usually means notifications won't display at all on
      // Android 8+. Log loudly so it shows up in support reports.
      console.warn(
        '[notification-bridge] Android channel creation failed (likely plugins-workspace#2341):',
        err,
      );
    }
    // Otherwise: channels already exist or the plugin is unavailable; proceed.
  }
}

/**
 * Register click handling for Tauri notifications.
 * Call once during app bootstrap.
 */
export async function initTauriNotificationClickHandler() {
  if (!isTauri) return;
  const mod = await ensureTauriNotification();

  // Strategy 1: plugin onAction callback (production builds + mobile)
  if (mod) {
    try {
      if (mod.registerActionTypes) {
        await mod.registerActionTypes([
          {
            id: 'default-mail',
            actions: [{ id: 'open', title: 'Open', foreground: true }],
          },
        ]);
      }
    } catch {
      /* ignore */
    }

    try {
      if (mod.onAction) {
        await mod.onAction((event) => {
          const extra = event?.extra || event?.notification?.extra || event?.data;
          navigateToNotification(extra);
          _lastNotificationData = null; // prevent focus fallback double-fire
        });
      }
    } catch {
      /* ignore */
    }
  }

  // Strategy 2: focus-based fallback
  // When macOS activates the app after a notification click, the Tauri
  // window gains focus.  If it happens within the click window, navigate.
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.onFocusChanged(({ payload: focused }) => {
      if (!focused || !_lastNotificationData) return;
      if (Date.now() - _lastNotificationTime > NOTIFICATION_CLICK_WINDOW_MS) {
        _lastNotificationData = null;
        return;
      }
      navigateToNotification(_lastNotificationData);
      _lastNotificationData = null;
    });
  } catch {
    /* ignore */
  }
}

// ── Tauri implementation ────────────────────────────────────────────────────

async function _requestTauriPermission() {
  const mod = await ensureTauriNotification();
  if (!mod) return 'denied';
  try {
    const granted = await mod.isPermissionGranted();
    if (granted) return 'granted';
    const result = await mod.requestPermission();
    return result === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

// The Tauri notification plugin assigns a random i32 id when none is given,
// so two displays for the same message always stack as two entries in the
// shade. Deriving the id from the dedup tag makes a repeat display for the
// same message REPLACE the earlier one instead (same behavior the web branch
// gets from the Notification `tag` option).
function stableNotificationId(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (Math.imul(hash, 31) + tag.charCodeAt(i)) | 0;
  }
  return hash;
}

async function _notifyTauri({ title, body, channelId, data, number, tag }) {
  const mod = await ensureTauriNotification();
  if (!mod) return false;
  try {
    const granted = await mod.isPermissionGranted();
    if (!granted) return false;
    const payload = { title, body: body || '', actionTypeId: 'default-mail' };
    if (typeof tag === 'string' && tag) payload.id = stableNotificationId(tag);
    if (channelId) payload.channelId = channelId;
    // Android uses the number field for app icon badge count
    if (typeof number === 'number' && number > 0) payload.number = number;
    if (data && typeof data === 'object') {
      const extra = {};
      for (const key of ['account', 'folder', 'messageId', 'appPath', 'path', 'url']) {
        if (data[key]) extra[key] = String(data[key]);
      }
      if (Object.keys(extra).length) payload.extra = extra;
    }
    mod.sendNotification(payload);
    if (data) trackNotification(data);
    return true;
  } catch (err) {
    console.warn('[notification-bridge] Tauri notification failed:', err);
    return false;
  }
}

// ── Web implementation ──────────────────────────────────────────────────────

const WEB_NOTIFICATION_ICON = '/icons/icon-192.png';
const SERVICE_WORKER_READY_TIMEOUT_MS = 3000;

async function _notifyWeb({ title, body, icon, tag, data }) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return false;
  }

  // The service worker's notificationclick handler (public/sw-sync.js) reads
  // the target from data.target, so it needs no copy of the parsing here.
  const target = notificationDataToTarget(data);
  const payload = { ...(data && typeof data === 'object' ? data : {}), target };
  const options = { body, icon: icon || WEB_NOTIFICATION_ICON, tag, data: payload };

  // Prefer SW-based notification for persistence (survives tab close). It is
  // also the only kind Chrome on Android allows.
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
    try {
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS)),
      ]);
      if (registration?.showNotification) {
        await registration.showNotification(title, options);
        return true;
      }
    } catch (err) {
      console.warn('[notification-bridge] Service worker notification failed:', err);
    }
  }

  // Fallback to basic Notification API, which has no service worker to
  // handle the click: do it here.
  try {
    const notification = new Notification(title, options);
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore
      }
      notification.close();
      if (target) openNotificationTarget(target);
    };
    return true;
  } catch (err) {
    console.warn('[notification-bridge] Notification failed:', err);
    return false;
  }
}
