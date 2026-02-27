/**
 * Forward Email – Notification Manager
 *
 * Bridges WebSocket events to platform-appropriate notifications:
 *   - Tauri desktop/mobile: via @tauri-apps/plugin-notification
 *   - Web browser: via the Web Notifications API
 *
 * Also manages:
 *   - Badge count (unread messages)
 *   - Notification click routing (navigate to message/folder)
 *   - Permission requests
 *   - Notification grouping and deduplication
 *
 * Hardening:
 *   - All string fields from WebSocket payloads are sanitised before display.
 *   - Badge counts are bounds-checked.
 *   - Deduplication map is size-limited to prevent memory exhaustion.
 *   - Notification data paths are validated against an allowlist of prefixes.
 */

import { WS_EVENTS } from './websocket-client';
import { isTauri } from './platform.js';
import { notify, requestPermission } from './notification-bridge.js';
import { setBadgeCount as tauriBadge } from './tauri-bridge.js';
import { updateFaviconBadge } from './favicon-badge.js';

// ── Input sanitisation ──────────────────────────────────────────────────────

const MAX_TITLE_LEN = 256;
const MAX_BODY_LEN = 1024;
const MAX_TAG_LEN = 128;
const MAX_PATH_LEN = 256;

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  return (
    value
      .slice(0, maxLen)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  );
}

// Allowed prefixes for notification data.path
const ALLOWED_PATH_PREFIXES = ['#inbox', '#folders', '#calendar', '#contacts', '#settings'];

function sanitizePath(path) {
  if (typeof path !== 'string') return '#inbox';
  const cleaned = sanitize(path, MAX_PATH_LEN);
  if (ALLOWED_PATH_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) {
    return cleaned;
  }
  return '#inbox'; // Default to inbox for unknown paths
}

function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    // Only allow https URLs
    if (parsed.protocol !== 'https:') return '';
    // Only allow known domains
    if (
      parsed.hostname !== 'github.com' &&
      parsed.hostname !== 'forwardemail.net' &&
      !parsed.hostname.endsWith('.forwardemail.net')
    ) {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

// ── Notification Queue (dedup within 2 seconds) ─────────────────────────────

const recentNotifications = new Map();
const DEDUP_WINDOW_MS = 2_000;
const MAX_DEDUP_ENTRIES = 200;

function isDuplicate(tag) {
  if (!tag) return false;
  const now = Date.now();
  if (recentNotifications.has(tag)) {
    const last = recentNotifications.get(tag);
    if (now - last < DEDUP_WINDOW_MS) return true;
  }

  recentNotifications.set(tag, now);

  // Prune old entries to prevent unbounded growth
  if (recentNotifications.size > MAX_DEDUP_ENTRIES) {
    for (const [key, ts] of recentNotifications) {
      if (now - ts > DEDUP_WINDOW_MS * 5) recentNotifications.delete(key);
    }
  }

  return false;
}

// ── Permission ──────────────────────────────────────────────────────────────

let permissionGranted = false;

export async function requestNotificationPermission() {
  const result = await requestPermission();
  permissionGranted = result === 'granted';
  return permissionGranted;
}

// ── Show Notification ───────────────────────────────────────────────────────

async function showNotification({ title, body, tag, icon, data, channelId }) {
  if (!permissionGranted) {
    const granted = await requestNotificationPermission();
    if (!granted) return;
  }

  if (isDuplicate(tag)) return;

  await notify({ title, body, tag, icon, data, channelId });
}

// ── Badge Count ─────────────────────────────────────────────────────────────

const MAX_BADGE = 99_999;
let currentBadge = 0;

export async function setBadgeCount(count) {
  // Bounds-check
  const n = typeof count === 'number' ? count : 0;
  currentBadge = Math.max(0, Math.min(Math.round(n), MAX_BADGE));

  if (isTauri) {
    tauriBadge(currentBadge);
    return;
  }

  // Web badge API (Chrome 81+)
  if ('setAppBadge' in navigator) {
    try {
      if (currentBadge > 0) {
        await navigator.setAppBadge(currentBadge);
      } else {
        await navigator.clearAppBadge();
      }
    } catch {
      // ignore
    }
  }

  // Favicon badge (all browsers)
  updateFaviconBadge(currentBadge);
}

export function getBadgeCount() {
  return currentBadge;
}

/**
 * Atomically increment or decrement the badge count.
 * Avoids read-then-write races when multiple events fire concurrently.
 */
export async function incrementBadge(delta) {
  const newCount = Math.max(0, Math.min(currentBadge + delta, MAX_BADGE));
  await setBadgeCount(newCount);
}

/**
 * Initialise the badge count from the mailbox store's INBOX unread count.
 * Call once after the mailbox store has loaded folders.
 * This ensures the badge reflects reality on app start, not just WS deltas.
 */
export async function initBadgeFromStore() {
  try {
    const { get } = await import('svelte/store');
    const { mailboxStore } = await import('../stores/mailboxStore');
    const folders = get(mailboxStore.state.folders) || [];
    const inbox = folders.find((f) => f.path?.toUpperCase?.() === 'INBOX');
    if (inbox && typeof inbox.count === 'number' && inbox.count >= 0) {
      await setBadgeCount(inbox.count);
    }
  } catch {
    // Store may not be ready yet — badge will sync from WS events
  }
}

// ── Event -> Notification Mapping ───────────────────────────────────────────

function handleNewMessage(data) {
  if (!data || typeof data !== 'object') return;

  const from = sanitize(
    data.message?.from?.text ||
      data.message?.from?.address ||
      data.message?.from ||
      'Unknown sender',
    MAX_TITLE_LEN,
  );
  const subject = sanitize(data.message?.subject || '(No subject)', MAX_BODY_LEN);
  const uid = data.message?.uid || data.message?.id;
  const safeTag = sanitize(`new-message-${uid || Date.now()}`, MAX_TAG_LEN);

  showNotification({
    title: `New email from ${from}`,
    body: subject,
    tag: safeTag,
    channelId: 'new-mail',
    data: { path: sanitizePath(`#inbox/${uid}`), uid },
  });

  incrementBadge(1);
}

function handleFlagsUpdated(data) {
  if (!data || typeof data !== 'object') return;

  if (data.action === 'add' && Array.isArray(data.flags) && data.flags.includes('\\Seen')) {
    incrementBadge(-1);
  }

  if (data.action === 'remove' && Array.isArray(data.flags) && data.flags.includes('\\Seen')) {
    incrementBadge(1);
  }
}

function handleMessagesExpunged(data) {
  if (!data || typeof data !== 'object') return;
  const count = Array.isArray(data.uids) ? data.uids.length : 1;
  incrementBadge(-count);
}

function handleMailboxCreated(data) {
  if (!data || typeof data !== 'object') return;
  const path = sanitize(data.path || data.mailbox?.path || 'Unknown', MAX_BODY_LEN);
  showNotification({
    title: 'Folder Created',
    body: `New folder: ${path}`,
    tag: sanitize(`mailbox-created-${path}`, MAX_TAG_LEN),
    data: { path: '#folders' },
  });
}

function handleMailboxDeleted(data) {
  if (!data || typeof data !== 'object') return;
  const path = sanitize(data.path || 'Unknown', MAX_BODY_LEN);
  showNotification({
    title: 'Folder Deleted',
    body: `Folder removed: ${path}`,
    tag: sanitize(`mailbox-deleted-${path}`, MAX_TAG_LEN),
    data: { path: '#folders' },
  });
}

function handleMailboxRenamed(data) {
  if (!data || typeof data !== 'object') return;
  const oldPath = sanitize(data.oldPath || '', MAX_BODY_LEN);
  const newPath = sanitize(data.newPath || '', MAX_BODY_LEN);
  showNotification({
    title: 'Folder Renamed',
    body: `"${oldPath}" -> "${newPath}"`,
    tag: sanitize(`mailbox-renamed-${newPath}`, MAX_TAG_LEN),
    data: { path: '#folders' },
  });
}

function handleCalendarEventCreated(data) {
  if (!data || typeof data !== 'object') return;
  const summary = sanitize(data.summary || data.event?.summary || 'New event', MAX_BODY_LEN);
  showNotification({
    title: 'Calendar Event Created',
    body: summary,
    tag: sanitize(`cal-event-${data.id || Date.now()}`, MAX_TAG_LEN),
    data: { path: '#calendar' },
  });
}

function handleCalendarEventUpdated(data) {
  if (!data || typeof data !== 'object') return;
  const summary = sanitize(data.summary || data.event?.summary || 'Event updated', MAX_BODY_LEN);
  showNotification({
    title: 'Calendar Event Updated',
    body: summary,
    tag: sanitize(`cal-event-update-${data.id || Date.now()}`, MAX_TAG_LEN),
    data: { path: '#calendar' },
  });
}

function handleContactCreated(data) {
  if (!data || typeof data !== 'object') return;
  const name = sanitize(data.name || data.contact?.fn || 'New contact', MAX_BODY_LEN);
  showNotification({
    title: 'Contact Added',
    body: name,
    tag: sanitize(`contact-${data.id || Date.now()}`, MAX_TAG_LEN),
    data: { path: '#contacts' },
  });
}

function handleNewRelease(data) {
  if (!data || typeof data !== 'object') return;
  const version = sanitize(data.tagName || data.tag_name || data.version || 'new', 64);
  const name = sanitize(data.name || `Version ${version}`, MAX_BODY_LEN);
  const url = sanitizeUrl(data.htmlUrl || data.html_url || '');
  showNotification({
    title: 'Forward Email Update Available',
    body: `${name} is now available. Click to learn more.`,
    tag: sanitize(`release-${version}`, MAX_TAG_LEN),
    data: url ? { url } : {},
  });
}

// ── Wire Up ─────────────────────────────────────────────────────────────────

/**
 * Connect a WebSocket client's events to the notification system.
 *
 * @param {Object} wsClient - A client from createWebSocketClient()
 * @returns {Function} Cleanup function to remove all listeners
 */
export function connectNotifications(wsClient) {
  if (!wsClient || typeof wsClient.on !== 'function') {
    console.warn('[notification-manager] Invalid wsClient');
    return () => {};
  }

  const unsubs = [];

  unsubs.push(wsClient.on(WS_EVENTS.NEW_MESSAGE, handleNewMessage));
  unsubs.push(wsClient.on(WS_EVENTS.FLAGS_UPDATED, handleFlagsUpdated));
  unsubs.push(wsClient.on(WS_EVENTS.MESSAGES_EXPUNGED, handleMessagesExpunged));
  unsubs.push(wsClient.on(WS_EVENTS.MAILBOX_CREATED, handleMailboxCreated));
  unsubs.push(wsClient.on(WS_EVENTS.MAILBOX_DELETED, handleMailboxDeleted));
  unsubs.push(wsClient.on(WS_EVENTS.MAILBOX_RENAMED, handleMailboxRenamed));
  unsubs.push(wsClient.on(WS_EVENTS.CALENDAR_EVENT_CREATED, handleCalendarEventCreated));
  unsubs.push(wsClient.on(WS_EVENTS.CALENDAR_EVENT_UPDATED, handleCalendarEventUpdated));
  unsubs.push(wsClient.on(WS_EVENTS.CONTACT_CREATED, handleContactCreated));
  unsubs.push(wsClient.on(WS_EVENTS.NEW_RELEASE, handleNewRelease));

  return () => {
    for (const unsub of unsubs) {
      if (typeof unsub === 'function') unsub();
    }
  };
}
