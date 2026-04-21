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

import { isTauri } from './platform.js';

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

function trackNotification(data) {
  if (!data) return;
  _lastNotificationData = data;
  _lastNotificationTime = Date.now();
}

function navigateToNotification(data) {
  const url = data?.url;
  if (typeof url === 'string' && url.toLowerCase().startsWith('forwardemail://')) {
    window.dispatchEvent(new CustomEvent('app:deep-link', { detail: { url } }));
    return;
  }

  const path = data?.path;
  if (path && typeof path === 'string') {
    const normalizedHash = path.startsWith('#') ? path : `#${path}`;
    const previousHref = window.location.href;
    const nextHash = normalizedHash.slice(1);
    if (window.location.hash === normalizedHash) {
      window.dispatchEvent(
        new HashChangeEvent('hashchange', {
          oldURL: previousHref,
          newURL: previousHref,
        }),
      );
      return;
    }

    window.location.hash = nextHash;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Request notification permission on the current platform.
 * Returns 'granted', 'denied', or 'default'.
 */
export async function requestPermission() {
  if (isTauri) {
    return _requestTauriPermission();
  }

  // Web
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
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
 */
export async function notify({ title, body, icon, tag, data, channelId, number }) {
  // Sanitise all string inputs
  const safeTitle = sanitize(title, MAX_TITLE_LENGTH);
  const safeBody = sanitize(body, MAX_BODY_LENGTH);
  const safeTag = sanitize(tag, MAX_TAG_LENGTH);

  if (!safeTitle) return; // Title is required

  if (isTauri) {
    const safeChannel = channelId && ALLOWED_CHANNEL_IDS.has(channelId) ? channelId : undefined;
    const safeNumber = typeof number === 'number' && number > 0 ? Math.round(number) : undefined;
    return _notifyTauri({
      title: safeTitle,
      body: safeBody,
      channelId: safeChannel,
      data,
      number: safeNumber,
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
  } catch {
    // Channels may already exist.
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

async function _notifyTauri({ title, body, channelId, data, number }) {
  const mod = await ensureTauriNotification();
  if (!mod) return;
  try {
    const granted = await mod.isPermissionGranted();
    if (!granted) return;
    const payload = { title, body: body || '', actionTypeId: 'default-mail' };
    if (channelId) payload.channelId = channelId;
    // Android uses the number field for app icon badge count
    if (typeof number === 'number' && number > 0) payload.number = number;
    if (data && typeof data === 'object') {
      const extra = {};
      if (data.path) extra.path = String(data.path);
      if (data.uid) extra.uid = String(data.uid);
      if (data.url) extra.url = String(data.url);
      if (Object.keys(extra).length) payload.extra = extra;
    }
    mod.sendNotification(payload);
    if (data) trackNotification(data);
  } catch (err) {
    console.warn('[notification-bridge] Tauri notification failed:', err);
  }
}

// ── Web implementation ──────────────────────────────────────────────────────

function _notifyWeb({ title, body, icon, tag, data }) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return;
  }

  // Prefer SW-based notification for persistence (survives tab close)
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then((reg) => {
      reg.showNotification(title, { body, icon, tag, data });
    });
    return;
  }

  // Fallback to basic Notification API
  new Notification(title, { body, icon, tag, data });
}
