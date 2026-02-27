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
export async function notify({ title, body, icon, tag, data, channelId }) {
  // Sanitise all string inputs
  const safeTitle = sanitize(title, MAX_TITLE_LENGTH);
  const safeBody = sanitize(body, MAX_BODY_LENGTH);
  const safeTag = sanitize(tag, MAX_TAG_LENGTH);

  if (!safeTitle) return; // Title is required

  if (isTauri) {
    const safeChannel = channelId && ALLOWED_CHANNEL_IDS.has(channelId) ? channelId : undefined;
    return _notifyTauri({ title: safeTitle, body: safeBody, channelId: safeChannel });
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

async function _notifyTauri({ title, body, channelId }) {
  const mod = await ensureTauriNotification();
  if (!mod) return;
  try {
    const granted = await mod.isPermissionGranted();
    if (!granted) return;
    const payload = { title, body: body || '' };
    if (channelId) payload.channelId = channelId;
    mod.sendNotification(payload);
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
