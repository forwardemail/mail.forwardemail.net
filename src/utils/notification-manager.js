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
import { isDemoMode } from './demo-mode.js';
import { updateFaviconBadge } from './favicon-badge.js';
import { Remote } from './remote.js';
import { decodeMimeHeader } from './mime-utils.js';
import { extractFromField } from './sync-helpers.ts';

// ── In-app toast reference ─────────────────────────────────────────────────
// Set from main.ts via setNotificationToasts() — same pattern as
// setDemoToasts() and setIndexToasts().
let _toasts = null;

/**
 * Provide the toast host so new-message events can show an in-app toast
 * in addition to the OS-level notification.
 */
export function setNotificationToasts(toasts) {
  _toasts = toasts;
}

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

/**
 * Plain-text sanitisation for native (Tauri) notifications.
 * Strips control chars but does NOT HTML-encode — native notifications are plain text.
 */
function sanitizePlain(value, maxLen) {
  if (typeof value !== 'string') return '';
  return (
    value
      .slice(0, maxLen)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  );
}

/**
 * Extract just the display name from a "Name <email>" string.
 * Returns the name only, or the email if no name part exists.
 */
function extractDisplayName(fromStr) {
  if (typeof fromStr !== 'string') return '';
  const trimmed = decodeMimeHeader(fromStr).trim();
  const angleBracket = trimmed.indexOf('<');
  if (angleBracket > 0) {
    const name = trimmed
      .slice(0, angleBracket)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (name) return name;
  }
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse From and Subject from a raw EML string's headers.
 * Only reads the header block (before the first blank line).
 */
function parseEmlHeaders(eml) {
  if (typeof eml !== 'string') return {};
  const headerEnd = eml.indexOf('\r\n\r\n');
  const headerBlock = headerEnd > 0 ? eml.slice(0, headerEnd) : eml.slice(0, 4096);
  // Unfold continuation lines (lines starting with whitespace)
  const unfolded = headerBlock.replace(/\r\n[ \t]+/g, ' ');
  const result = {};
  for (const line of unfolded.split('\r\n')) {
    const match = line.match(/^(From|Subject):\s*(.+)/i);
    if (match) {
      const key = match[1].toLowerCase();
      if (!result[key]) result[key] = decodeMimeHeader(match[2]).trim();
    }
  }
  return result;
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
  if (isDemoMode()) {
    permissionGranted = false;
    return false;
  }

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

// Folder names that should never trigger new-message notifications or badge
// increments.  Drafts is the primary case: saving a draft creates a server-side
// message which fires a newMessage WS event, but the user should not be notified
// about their own draft.
const SILENT_FOLDERS = new Set(['DRAFTS', 'DRAFT']);

/**
 * Resolve the mailbox identifier from a newMessage WS payload to a
 * human-readable folder path.  The server may send a MongoDB ObjectId
 * or a path string (e.g. "INBOX", "Drafts").  We try the folder store
 * first (by id / _id / path) and fall back to the raw value.
 */
async function resolveMailboxPath(identifier) {
  if (!identifier) return 'INBOX';
  try {
    const { get } = await import('svelte/store');
    const { mailboxStore } = await import('../stores/mailboxStore');
    const folders = get(mailboxStore.state.folders) || [];
    const match =
      folders.find((f) => String(f.id) === identifier) ||
      folders.find((f) => String(f._id) === identifier) ||
      folders.find((f) => f.path?.toUpperCase?.() === identifier.toUpperCase());
    if (match) return match.path || identifier;
  } catch {
    // Store may not be ready — fall through to raw value
  }
  return identifier;
}

async function handleNewMessage(data) {
  if (!data || typeof data !== 'object') return;

  const msg = data.message || data;
  const uid = msg.uid || msg.id;
  // The mailbox identifier lives at the top level of the WS payload
  // (data.mailbox), NOT inside data.message.
  const rawMailbox = data.mailbox || msg.mailbox || 'INBOX';
  const mailbox = await resolveMailboxPath(rawMailbox);

  // Skip notifications for folders the user doesn't need alerts about
  // (e.g. Drafts — saving a draft fires a newMessage event on the server).
  const upperPath = (mailbox || '').toUpperCase();
  if (SILENT_FOLDERS.has(upperPath)) return;

  incrementBadge(1);

  let from =
    msg.from?.text ||
    msg.from?.name ||
    msg.from?.address ||
    (typeof msg.from === 'string' ? msg.from : null);
  let subject = msg.subject || msg.Subject;

  // WS payload includes raw EML — parse From/Subject directly from headers
  if (!from && typeof msg.eml === 'string') {
    const headers = parseEmlHeaders(msg.eml);
    from = headers.from || null;
    subject = subject || headers.subject;
  }

  // Fallback: fetch from API if we still don't have sender info
  if (!from) {
    try {
      const res = await Remote.request(
        'MessageList',
        { folder: mailbox, page: 1, limit: 1 },
        { method: 'GET', pathOverride: '/v1/messages' },
      );
      const list = res?.Result?.List || res?.Result || res || [];
      const latest = Array.isArray(list) ? list[0] : null;
      if (latest) {
        from = extractFromField(latest) || null;
        subject = subject || latest.subject || latest.Subject;
      }
    } catch {
      // API fetch failed — show notification with whatever we have
    }
  }

  const displayName = sanitizePlain(extractDisplayName(from) || 'Unknown sender', MAX_TITLE_LEN);
  const safeSubject = sanitizePlain(subject || '(No subject)', MAX_BODY_LEN);
  const safeTag = sanitize(`new-message-${uid || Date.now()}`, MAX_TAG_LEN);

  showNotification({
    title: `New email from ${displayName}`,
    body: safeSubject,
    tag: safeTag,
    channelId: 'new-mail',
    data: {
      path: sanitizePath(`#inbox/${uid}`),
      url: `forwardemail://mailbox#inbox/${encodeURIComponent(String(uid))}`,
      uid,
    },
  });

  // In-app toast (visible when the app window is focused)
  _toasts?.show?.(`New email from ${displayName}: ${safeSubject}`, 'info');
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
  const isTask = data.componentType === 'VTODO';
  const label = isTask ? 'Task' : 'Event';
  const summary = sanitize(
    data.summary || data.event?.summary || `New ${label.toLowerCase()}`,
    MAX_BODY_LEN,
  );
  showNotification({
    title: `Calendar ${label} Created`,
    body: summary,
    tag: sanitize(`cal-event-${data.id || Date.now()}`, MAX_TAG_LEN),
    data: { path: '#calendar' },
  });
}

function handleCalendarEventUpdated(data) {
  if (!data || typeof data !== 'object') return;
  const isTask = data.componentType === 'VTODO';
  const label = isTask ? 'Task' : 'Event';
  const summary = sanitize(data.summary || data.event?.summary || `${label} updated`, MAX_BODY_LEN);
  showNotification({
    title: `Calendar ${label} Updated`,
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

  // Unwrap the nested release object if present (server sends
  // { release: { tagName, name, body, htmlUrl, ... } } after
  // protocol fields are stripped by websocket-client.js)
  const r = data.release && typeof data.release === 'object' ? data.release : data;

  const version = sanitize(r.tagName || r.tag_name || r.version || 'new', 64);
  const name = sanitize(r.name || `Version ${version}`, MAX_BODY_LEN);
  const url = sanitizeUrl(r.htmlUrl || r.html_url || '');
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
