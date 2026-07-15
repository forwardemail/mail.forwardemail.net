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
import { extractEmail } from './address.ts';
import { Local } from './storage.js';
import { createRealtimeEventCoalescer } from './realtime-event-coalescer.js';

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

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function decodeICalText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').trim();
}

function extractIcalSummary(ical) {
  if (typeof ical !== 'string' || !ical.trim()) return '';
  const match = ical.match(/^SUMMARY(?:;[^:\r\n]+)*:(.+)$/im);
  return match ? decodeICalText(match[1]) : '';
}

function extractCalendarItemId(data) {
  if (!data || typeof data !== 'object') return '';
  return firstNonEmpty(
    data.id,
    data.uid,
    data.event_id,
    data.eventId,
    data.event?.id,
    data.event?.uid,
    data.event?.event_id,
    data.calendarEvent?.id,
    data.calendarEvent?.uid,
    data.resource?.id,
    data.resource?.uid,
  );
}

function extractCalendarComponentType(data) {
  if (!data || typeof data !== 'object') return '';
  return firstNonEmpty(
    data.componentType,
    data.component_type,
    data.event?.componentType,
    data.event?.component_type,
    data.calendarEvent?.componentType,
    data.calendarEvent?.component_type,
    data.resource?.componentType,
    data.resource?.component_type,
  ).toUpperCase();
}

function extractCalendarSummary(data) {
  if (!data || typeof data !== 'object') return '';
  return firstNonEmpty(
    data.summary,
    data.title,
    data.name,
    data.event?.summary,
    data.event?.title,
    data.event?.name,
    data.calendarEvent?.summary,
    data.calendarEvent?.title,
    data.calendarEvent?.name,
    data.resource?.summary,
    data.resource?.title,
    extractIcalSummary(data.ical),
    extractIcalSummary(data.event?.ical),
    extractIcalSummary(data.calendarEvent?.ical),
    extractIcalSummary(data.resource?.ical),
  );
}

function buildCalendarNotificationData(data, isTask = false) {
  const id = extractCalendarItemId(data);
  const hash = id ? `${isTask ? '#task=' : '#event='}${encodeURIComponent(String(id))}` : '';
  const payload = { path: '#calendar' };
  const url = buildDeepLink(`/calendar${hash}`);
  if (url) payload.url = url;
  if (id) payload.itemId = String(id);
  return payload;
}

function extractContactId(data) {
  if (!data || typeof data !== 'object') return '';
  return firstNonEmpty(
    data.id,
    data.uid,
    data.contact_id,
    data.contactId,
    data.contact?.id,
    data.contact?.uid,
    data.contact?.contact_id,
  );
}

function extractContactName(data) {
  if (!data || typeof data !== 'object') return '';
  return firstNonEmpty(
    data.name,
    data.full_name,
    data.contact?.fn,
    data.contact?.name,
    data.contact?.full_name,
    data.contact?.email,
    data.email,
  );
}

function buildContactNotificationData(data) {
  const id = extractContactId(data);
  const hash = id ? `#contact=${encodeURIComponent(String(id))}` : '';
  const payload = { path: '#contacts' };
  const url = buildDeepLink(`/contacts${hash}`);
  if (url) payload.url = url;
  if (id) payload.itemId = String(id);
  return payload;
}

// Allowed prefixes for notification data.path
const ALLOWED_PATH_PREFIXES = [
  '#inbox',
  '#folders',
  '#calendar',
  '#contacts',
  '#settings',
  '#notes',
];
const ALLOWED_APP_PATH_PREFIXES = ['/calendar', '/contacts', '/mailbox/settings'];

function sanitizePath(path) {
  if (typeof path !== 'string') return '#inbox';
  const cleaned = sanitize(path, MAX_PATH_LEN);
  if (ALLOWED_PATH_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) {
    return cleaned;
  }
  return '#inbox'; // Default to inbox for unknown paths
}

function sanitizeAppPath(path) {
  if (typeof path !== 'string') return '';
  const cleaned = sanitizePlain(path, MAX_PATH_LEN);
  if (ALLOWED_APP_PATH_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) {
    return cleaned;
  }
  return '';
}

function buildDeepLink(path) {
  const cleaned = sanitizeAppPath(path);
  if (!cleaned) return '';
  return `forwardemail://${cleaned.replace(/^\//, '')}`;
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

// ── Notification dedup (persisted across app restarts) ──────────────────────
//
// Each tag identifies one specific event: a message UID, a mailbox path, a
// calendar item, a release version. Any given tag should fire at most once.
// The map is persisted to localStorage and reloaded on startup so that an
// Android app reopen (which reconnects the WebSocket and replays the same
// NEW_MESSAGE / push events) doesn't re-notify things the user already saw.
// A long TTL means "notified once, don't notify again" rather than a short
// same-session window; the old behavior lost all tracking on app close.

const recentNotifications = new Map();
const DEDUP_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_DEDUP_ENTRIES = 500;
const DEDUP_STORAGE_KEY = 'fe_notified_tags';

function loadRecentNotifications() {
  try {
    const raw = localStorage.getItem(DEDUP_STORAGE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!entries || typeof entries !== 'object') return;
    const now = Date.now();
    for (const [tag, ts] of Object.entries(entries)) {
      if (typeof ts === 'number' && now - ts < DEDUP_TTL_MS) {
        recentNotifications.set(tag, ts);
      }
    }
  } catch {
    // ignore malformed / unavailable storage
  }
}

function persistRecentNotifications() {
  try {
    localStorage.setItem(
      DEDUP_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(recentNotifications)),
    );
  } catch {
    // ignore quota / unavailable storage
  }
}

loadRecentNotifications();

function isDuplicate(tag) {
  if (!tag) return false;
  const now = Date.now();
  const last = recentNotifications.get(tag);
  if (last !== undefined && now - last < DEDUP_TTL_MS) return true;

  recentNotifications.set(tag, now);

  // Prune expired entries, then bound the size (Map preserves insertion order,
  // so deleting the first key drops the oldest).
  if (recentNotifications.size > MAX_DEDUP_ENTRIES) {
    for (const [key, ts] of recentNotifications) {
      if (now - ts > DEDUP_TTL_MS) recentNotifications.delete(key);
    }
    while (recentNotifications.size > MAX_DEDUP_ENTRIES) {
      const oldest = recentNotifications.keys().next().value;
      if (oldest === undefined) break;
      recentNotifications.delete(oldest);
    }
  }

  persistRecentNotifications();
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

// Last-resort name-based fallback for folders that should never trigger
// new-message notifications. Primary detection uses the IMAP specialUse flag
// and the mailbox store's resolved Sent/Drafts paths (see handleNewMessage).
const SILENT_FOLDERS = new Set([
  'DRAFTS',
  'DRAFT',
  'SENT',
  'SENT MAIL',
  'SENT MESSAGES',
  'SENT ITEMS',
  'ARCHIVE',
  'ARCHIVES',
  'ALL MAIL',
  'JUNK',
  'JUNK EMAIL',
  'SPAM',
  'TRASH',
  'BIN',
  'DELETED ITEMS',
  'DELETED MESSAGES',
]);

const SILENT_SPECIAL_USE = new Set([
  '\\Sent',
  '\\Drafts',
  '\\Archive',
  '\\Junk',
  '\\Trash',
  '\\All',
]);

// IMAP servers can deliver messages already marked \Seen when another client
// APPENDed/COPYed them (e.g. Thunderbird migrating mail). A genuine new
// delivery is never pre-read, so this catches cross-folder copies of already
// read mail across all folders — including Inbox.
const hasSeenFlag = (msg) => {
  const flags = msg?.flags;
  if (!Array.isArray(flags)) return false;
  return flags.some((f) => typeof f === 'string' && f.toLowerCase() === '\\seen');
};

/**
 * Resolve the mailbox identifier from a newMessage WS payload to the matching
 * folder record.  The server may send a MongoDB ObjectId or a path string
 * (e.g. "INBOX", "Drafts").  Returns `{ path, specialUse }` — specialUse is
 * the IMAP attribute ('\\Sent', '\\Drafts', etc.) when the folder is labelled,
 * null otherwise.
 */
async function resolveMailbox(identifier) {
  if (!identifier) return { path: 'INBOX', specialUse: null };
  try {
    const { get } = await import('svelte/store');
    const { mailboxStore } = await import('../stores/mailboxStore');
    const folders = get(mailboxStore.state.folders) || [];
    const match =
      folders.find((f) => String(f.id) === identifier) ||
      folders.find((f) => String(f._id) === identifier) ||
      folders.find((f) => f.path?.toUpperCase?.() === identifier.toUpperCase());
    if (match) return { path: match.path || identifier, specialUse: match.specialUse || null };
  } catch {
    // Store may not be ready — fall through to raw value
  }
  return { path: identifier, specialUse: null };
}

/**
 * Insert a freshly delivered message into the in-memory mailboxStore when the
 * user is currently viewing the destination folder. The shape mirrors what
 * `normalizeMessage` in sync-helpers.ts produces so the row renders correctly
 * before the next loadMessages() reconciles with the server.
 *
 * No-op when the affected folder isn't the active one — refreshFolder() in
 * websocket-updater handles cache invalidation for the non-active case.
 */
async function prependNewMessageToStore({ msg, mailbox, from, subject, uid }) {
  if (!uid && !msg?.id) return;
  try {
    const { get } = await import('svelte/store');
    const { mailboxStore } = await import('../stores/mailboxStore');
    const currentFolder = get(mailboxStore.state.selectedFolder);
    if (!currentFolder || !mailbox) return;
    if (currentFolder.toUpperCase() !== String(mailbox).toUpperCase()) return;

    const id = String(msg?.id ?? msg?.Uid ?? msg?.uid ?? uid);
    const messages = get(mailboxStore.state.messages) || [];
    if (messages.some((m) => String(m.id) === id)) return;

    const flags = Array.isArray(msg?.flags) ? msg.flags : [];
    const dateRaw =
      msg?.created_at ||
      msg?.Date ||
      msg?.date ||
      msg?.internal_date ||
      msg?.header_date ||
      msg?.received_at ||
      null;
    const parsedDate = dateRaw ? new Date(dateRaw) : null;
    const dateMs =
      parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.getTime() : Date.now();

    const envelope = {
      id,
      uid: msg?.uid ?? msg?.Uid ?? null,
      account: Local.get('email') || 'default',
      folder: currentFolder,
      date: dateMs,
      dateMs,
      from: from || 'Unknown',
      subject: subject || '(No subject)',
      normalizedSubject: subject || '',
      snippet: msg?.snippet || msg?.preview || '',
      flags,
      is_unread: !flags.some((f) => typeof f === 'string' && f.toLowerCase() === '\\seen'),
      is_starred: flags.some((f) => typeof f === 'string' && f.toLowerCase() === '\\flagged'),
      has_attachment: Boolean(msg?.has_attachment || msg?.hasAttachments),
      message_id: msg?.message_id || msg?.MessageId || msg?.['Message-ID'] || null,
      updatedAt: Date.now(),
      __optimistic: true,
    };
    mailboxStore.state.messages.set([envelope, ...messages]);
  } catch {
    // Store not ready or shape change — silently fall back to refreshFolder()
  }
}

async function handleNewMessage(data, { suppressVisual = false } = {}) {
  if (!data || typeof data !== 'object') return;

  const msg = data.message || data;
  const uid = msg.uid || msg.id;
  // The mailbox identifier lives at the top level of the WS payload
  // (data.mailbox), NOT inside data.message.
  const rawMailbox = data.mailbox || msg.mailbox || 'INBOX';
  const { path: mailbox, specialUse } = await resolveMailbox(rawMailbox);

  // Suppress notifications for messages that aren't a fresh user-facing
  // delivery. Five signals from strongest to weakest, because server payloads
  // and folder metadata are inconsistent across providers / cold-start timing:
  //   1. Pre-\Seen flag on the arriving message — a real new delivery is
  //      never already read, so this signals an IMAP COPY/APPEND from
  //      another client (e.g. Thunderbird migrating old mail).
  //   2. IMAP specialUse flag on the folder (server-authoritative): Sent,
  //      Drafts, Archive, Junk, Trash, All.
  //   3. Path equality against the account's configured Sent/Drafts folder.
  //   4. Uppercase path match against the SILENT_FOLDERS name list.
  //   5. From-address equal to the active account email (catches Cc-to-self
  //      and any case where folder classification failed).
  if (hasSeenFlag(msg)) return;
  if (specialUse && SILENT_SPECIAL_USE.has(specialUse)) return;

  try {
    const { mailboxStore } = await import('../stores/mailboxStore');
    const sentPath = mailboxStore.actions?.getSentFolderPath?.();
    const draftsPath = mailboxStore.actions?.getDraftsFolderPath?.();
    if (mailbox && (mailbox === sentPath || mailbox === draftsPath)) return;
  } catch {
    // Store not ready — fall through to name-based filter
  }

  const upperPath = (mailbox || '').toUpperCase();
  if (SILENT_FOLDERS.has(upperPath)) return;

  const fromAddr = (extractEmail(msg.from) || msg.from?.address || '').toLowerCase();
  const accountEmail = (Local.get('email') || '').toLowerCase();
  if (accountEmail && fromAddr && fromAddr === accountEmail) return;

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

  // Optimistically inject the envelope into the message list if the user is
  // currently viewing the affected folder. Without this, the WS broadcast
  // arrives before the backend indexer makes the message queryable, so the
  // subsequent refreshFolder()→loadMessages() returns the old list and the
  // user only sees the new mail after folder-switch (10-30s later).
  prependNewMessageToStore({ msg, mailbox, from, subject, uid }).catch(() => {
    // Failure here only affects the in-place refresh — refreshFolder() runs
    // separately in websocket-updater and will eventually catch up.
  });

  if (!suppressVisual) {
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

function handleMailboxCreated(data, { suppressVisual = false } = {}) {
  if (!data || typeof data !== 'object') return;
  const path = sanitize(data.path || data.mailbox?.path || 'Unknown', MAX_BODY_LEN);
  if (suppressVisual) return;
  showNotification({
    title: 'Folder Created',
    body: `New folder: ${path}`,
    tag: sanitize(`mailbox-created-${path}`, MAX_TAG_LEN),
    data: { path: '#folders' },
  });
}

function handleMailboxDeleted(data, { suppressVisual = false } = {}) {
  if (!data || typeof data !== 'object') return;
  const path = sanitize(data.path || 'Unknown', MAX_BODY_LEN);
  if (suppressVisual) return;
  showNotification({
    title: 'Folder Deleted',
    body: `Folder removed: ${path}`,
    tag: sanitize(`mailbox-deleted-${path}`, MAX_TAG_LEN),
    data: { path: '#folders' },
  });
}

function handleMailboxRenamed(data, { suppressVisual = false } = {}) {
  if (!data || typeof data !== 'object') return;
  const oldPath = sanitize(data.oldPath || '', MAX_BODY_LEN);
  const newPath = sanitize(data.newPath || '', MAX_BODY_LEN);
  if (suppressVisual) return;
  showNotification({
    title: 'Folder Renamed',
    body: `"${oldPath}" -> "${newPath}"`,
    tag: sanitize(`mailbox-renamed-${newPath}`, MAX_TAG_LEN),
    data: { path: '#folders' },
  });
}

function handleCalendarEventCreated(data, { suppressVisual = false } = {}) {
  if (!data || typeof data !== 'object') return;
  const isTask = extractCalendarComponentType(data) === 'VTODO';
  const label = isTask ? 'Task' : 'Event';
  const summary = sanitize(
    extractCalendarSummary(data) || `New ${label.toLowerCase()}`,
    MAX_BODY_LEN,
  );
  const itemId = extractCalendarItemId(data);
  if (suppressVisual) return;
  showNotification({
    title: `Calendar ${label} Created`,
    body: summary,
    tag: sanitize(`cal-event-${itemId || Date.now()}`, MAX_TAG_LEN),
    data: buildCalendarNotificationData(data, isTask),
  });
}

function handleCalendarEventUpdated(data, { suppressVisual = false } = {}) {
  if (!data || typeof data !== 'object') return;
  const isTask = extractCalendarComponentType(data) === 'VTODO';
  const label = isTask ? 'Task' : 'Event';
  const summary = sanitize(extractCalendarSummary(data) || `${label} updated`, MAX_BODY_LEN);
  const itemId = extractCalendarItemId(data);
  if (suppressVisual) return;
  showNotification({
    title: `Calendar ${label} Updated`,
    body: summary,
    tag: sanitize(`cal-event-update-${itemId || Date.now()}`, MAX_TAG_LEN),
    data: buildCalendarNotificationData(data, isTask),
  });
}

function handleContactCreated(data, { suppressVisual = false } = {}) {
  if (!data || typeof data !== 'object') return;
  const name = sanitize(extractContactName(data) || 'New contact', MAX_BODY_LEN);
  const contactId = extractContactId(data);
  if (suppressVisual) return;
  showNotification({
    title: 'Contact Added',
    body: name,
    tag: sanitize(`contact-${contactId || Date.now()}`, MAX_TAG_LEN),
    data: buildContactNotificationData(data),
  });
}

function handleContactUpdated(data, { suppressVisual = false } = {}) {
  if (!data || typeof data !== 'object') return;
  const name = sanitize(extractContactName(data) || 'Contact updated', MAX_BODY_LEN);
  const contactId = extractContactId(data);
  if (suppressVisual) return;
  showNotification({
    title: 'Contact Updated',
    body: name,
    tag: sanitize(`contact-update-${contactId || Date.now()}`, MAX_TAG_LEN),
    data: buildContactNotificationData(data),
  });
}

function handleNewRelease(data, { suppressVisual = false } = {}) {
  if (!data || typeof data !== 'object') return;

  // Unwrap the nested release object if present (server sends
  // { release: { tagName, name, body, htmlUrl, ... } } after
  // protocol fields are stripped by websocket-client.js)
  const r = data.release && typeof data.release === 'object' ? data.release : data;

  const version = sanitize(r.tagName || r.tag_name || r.version || 'new', 64);
  const name = sanitize(r.name || `Version ${version}`, MAX_BODY_LEN);
  const url = sanitizeUrl(r.htmlUrl || r.html_url || '');
  if (suppressVisual) return;
  showNotification({
    title: 'Forward Email Update Available',
    body: `${name} is now available. Click to learn more.`,
    tag: sanitize(`release-${version}`, MAX_TAG_LEN),
    data: url ? { url } : {},
  });
}

// ── Transport routing ───────────────────────────────────────────────────────

const ROUTED_NOTIFICATION_EVENTS = new Set([
  WS_EVENTS.NEW_MESSAGE,
  WS_EVENTS.FLAGS_UPDATED,
  WS_EVENTS.MESSAGES_EXPUNGED,
  WS_EVENTS.MAILBOX_CREATED,
  WS_EVENTS.MAILBOX_DELETED,
  WS_EVENTS.MAILBOX_RENAMED,
  WS_EVENTS.CALENDAR_EVENT_CREATED,
  WS_EVENTS.CALENDAR_EVENT_UPDATED,
  WS_EVENTS.CONTACT_CREATED,
  WS_EVENTS.CONTACT_UPDATED,
  WS_EVENTS.NEW_RELEASE,
]);

function routeNotificationEvent(eventName, data, options) {
  switch (eventName) {
    case WS_EVENTS.NEW_MESSAGE:
      handleNewMessage(data, options);
      return true;
    case WS_EVENTS.FLAGS_UPDATED:
      handleFlagsUpdated(data);
      return true;
    case WS_EVENTS.MESSAGES_EXPUNGED:
      handleMessagesExpunged(data);
      return true;
    case WS_EVENTS.MAILBOX_CREATED:
      handleMailboxCreated(data, options);
      return true;
    case WS_EVENTS.MAILBOX_DELETED:
      handleMailboxDeleted(data, options);
      return true;
    case WS_EVENTS.MAILBOX_RENAMED:
      handleMailboxRenamed(data, options);
      return true;
    case WS_EVENTS.CALENDAR_EVENT_CREATED:
      handleCalendarEventCreated(data, options);
      return true;
    case WS_EVENTS.CALENDAR_EVENT_UPDATED:
      handleCalendarEventUpdated(data, options);
      return true;
    case WS_EVENTS.CONTACT_CREATED:
      handleContactCreated(data, options);
      return true;
    case WS_EVENTS.CONTACT_UPDATED:
      handleContactUpdated(data, options);
      return true;
    case WS_EVENTS.NEW_RELEASE:
      handleNewRelease(data, options);
      return true;
    default:
      return false;
  }
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
  const coalescer = createRealtimeEventCoalescer({
    onEvent: routeNotificationEvent,
  });

  for (const eventName of ROUTED_NOTIFICATION_EVENTS) {
    unsubs.push(wsClient.on(eventName, (payload) => coalescer.handleWebSocket(eventName, payload)));
  }

  // APNs, FCM, and UnifiedPush all enter through one DOM event.  The coalescer
  // lets a matching socket event win in the foreground and otherwise consumes
  // push after a bounded delay, while suppressing visuals already shown by the
  // operating system.
  const pushHandler = (event) => {
    const payload = event?.detail;
    if (!ROUTED_NOTIFICATION_EVENTS.has(payload?.event)) return;
    coalescer.handlePush(payload);
  };
  window.addEventListener('fe:push-notification', pushHandler);
  unsubs.push(() => window.removeEventListener('fe:push-notification', pushHandler));

  return () => {
    coalescer.destroy();
    for (const unsub of unsubs) {
      if (typeof unsub === 'function') unsub();
    }
  };
}
