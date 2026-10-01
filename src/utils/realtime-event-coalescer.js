/*
 * Coalesce one logical realtime event delivered over WebSocket and native push.
 *
 * Both transports are intentionally at-least-once and may arrive in either
 * order.  WebSocket delivery is preferred while the app is visible; a native
 * push waits briefly and becomes the fallback only when the matching socket
 * event does not arrive.  A bounded TTL cache suppresses the opposite order and
 * late provider retries.  Callers create separate instances for separate kinds
 * of idempotent work (for example, UI notifications and data refreshes).
 */

import { normalizeStringList, normalizeUidList } from './realtime-payload.js';

export const PUSH_COALESCE_MS = 1500;
// How long a socket event waits for its push copy where the system may draw
// the push itself (macOS; see shouldHoldSocketEvent below).
export const SOCKET_HOLD_FOR_PUSH_MS = 3000;
export const TRANSPORT_DEDUP_TTL_MS = 5 * 60 * 1000;
export const MAX_TRANSPORT_DEDUP_ENTRIES = 500;
// The server can publish one change twice, each copy with its own
// notification_id. A content identity collapses the copies; for events that
// carry a notification_id it only has to outlive the copies, so it expires
// sooner and cannot swallow a later event that reuses a UID.
export const ONE_TIME_CONTENT_TTL_MS = 60 * 1000;
// Window in which a repeatable change identical to the previous change of the
// same target is treated as a second copy of it.
export const REPEATABLE_CONTENT_TTL_MS = 2000;

const MAX_KEY_PART_LENGTH = 256;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const stringValue = String(value).trim();
    if (stringValue) return stringValue;
  }
  return '';
}

// Push data can carry lists as strings ("[1,2]" or "1,2"); normalize them so
// both copies of an event produce one identity.
function joinUids(value) {
  return normalizeUidList(value).join(',');
}

function joinValues(value) {
  return normalizeStringList(value).join(',');
}

function getUidValidity(data) {
  return firstNonEmpty(
    data.uidValidity,
    data.uid_validity,
    data.uidvalidity,
    data.message?.uidValidity,
    data.message?.uid_validity,
  );
}

function getCalendarIdentity(data) {
  return firstNonEmpty(
    data.eventId,
    data.event_id,
    data.calendarEventId,
    data.calendar_event_id,
    data.uid,
    data.href,
    data.path,
    data.event?.id,
    data.event?.uid,
    data.task?.id,
    data.task?.uid,
  );
}

function getContactIdentity(data) {
  return firstNonEmpty(
    data.contactId,
    data.contact_id,
    data.uid,
    data.href,
    data.path,
    data.contact?.id,
    data.contact?.uid,
  );
}

/**
 * Every identity below is drawn from values that are only unique WITHIN one
 * mailbox: an IMAP UID is a per-mailbox counter, and a mailbox path is
 * "INBOX" for every account there is. With several accounts connected at once,
 * `flagsUpdated:INBOX>5>\Seen` is byte-identical for account A and account B,
 * so the second account's event looked like a duplicate of the first and was
 * dropped for the whole five-minute dedup window — silently, and for both the
 * notification and the data-refresh coalescer.
 *
 * Prefixing with the account makes the key mean "this event, for this mailbox".
 * WebSocket events are tagged by the connection manager and push events have
 * `_account` resolved from `alias_id` before dispatch, so both transports
 * produce the same prefix and still coalesce against each other.
 */
function accountPrefix(data) {
  const account = typeof data?._account === 'string' ? data._account.trim().toLowerCase() : '';
  return account ? `${account.slice(0, MAX_KEY_PART_LENGTH)}|` : '';
}

/**
 * Return the stable identifier shared by the WebSocket and push copies.
 * The legacy identities keep mixed-version deployments usable while rolling
 * out notification_id; they intentionally avoid display text, which may cause
 * unrelated events to be coalesced.
 */
export function getRealtimeEventKey(eventName, data) {
  return getRealtimeEventKeys(eventName, data)[0] || '';
}

/**
 * Events whose legacy identity names something that happens once: a new
 * message, or messages moved, copied or expunged by UID (a UID is never
 * reused in its mailbox). The same identity always means the same event, so
 * it can collapse two producers of it even though each send gets its own
 * notification_id.
 *
 * Every other identity names something that changes again and again: a
 * message's flags or labels, a calendar event, a contact, a mailbox path.
 * Read then unread of one message, or two edits of one event, share the
 * identity, so using it would drop the second change for the whole dedup
 * window and leave the view stale. Those collapse on notification_id alone
 * whenever the event has one.
 */
const ONE_TIME_EVENTS = new Set([
  'newMessage',
  'messagesMoved',
  'messagesCopied',
  'messagesExpunged',
  'newRelease',
]);

/**
 * Return EVERY key this event answers to: the notification_id key when the
 * payload carries one, plus the legacy identity key (see ONE_TIME_EVENTS for
 * when that is left out). Registering and looking up under both is what lets
 * a push that carries notification_id coalesce with a WebSocket copy that
 * lacks it (or vice versa) on mixed-version deployments.
 */
export function getRealtimeEventKeys(eventName, data) {
  return getRealtimeEventKeyEntries(eventName, data).map((entry) => entry.key);
}

// Each key with how long it stays remembered.
function getRealtimeEventKeyEntries(eventName, data) {
  if (typeof eventName !== 'string' || !data || typeof data !== 'object') return [];

  const entries = [];

  // notification_id is minted per delivery by the server, so it is already
  // globally unique and needs no account scoping.
  const notificationId = firstNonEmpty(data.notification_id, data.notificationId);
  if (notificationId) {
    entries.push({
      key: `id:${notificationId.slice(0, MAX_KEY_PART_LENGTH)}`,
      ttl: TRANSPORT_DEDUP_TTL_MS,
    });
  }

  const legacyKey = getLegacyEventKey(eventName, data);
  if (legacyKey && ONE_TIME_EVENTS.has(eventName)) {
    entries.push({
      key: legacyKey,
      ttl: notificationId ? ONE_TIME_CONTENT_TTL_MS : TRANSPORT_DEDUP_TTL_MS,
    });
  } else if (legacyKey && !notificationId) {
    entries.push({ key: legacyKey, ttl: TRANSPORT_DEDUP_TTL_MS });
  }

  return entries;
}

/**
 * For a repeatable event, the thing it changes (`target`) and what it changed
 * it to (`change`). Two server copies of one change share both, and the
 * server `timestamp` too. A real repeat, such as read then unread then read
 * again, has its own timestamp, so without equal timestamps nothing is a copy.
 */
function getRepeatableChange(eventName, data) {
  if (!data || typeof data !== 'object') return null;
  const timestamp = firstNonEmpty(data.timestamp);
  if (!timestamp) return null;
  let target = '';
  let change = '';
  switch (eventName) {
    case 'flagsUpdated':
    case 'labelsUpdated': {
      const uids = firstNonEmpty(joinUids(data.uids), data.uid, data.id);
      if (!uids) return null;
      // Without the flags or labels two different changes look the same
      const values = joinValues(eventName === 'flagsUpdated' ? data.flags : data.labels);
      if (!values) return null;
      target = [firstNonEmpty(data.mailbox, data.path), uids, values].join('>');
      change = firstNonEmpty(data.action) || 'update';
      break;
    }
    case 'mailboxCreated':
    case 'mailboxDeleted':
      target = firstNonEmpty(data.path, data.mailbox?.path, data.mailbox);
      change = eventName;
      break;
    case 'mailboxRenamed': {
      const oldPath = firstNonEmpty(data.oldPath, data.old_path);
      const newPath = firstNonEmpty(data.newPath, data.new_path);
      if (!oldPath || !newPath) return null;
      target = [oldPath, newPath].sort().join('>');
      change = `${oldPath}>${newPath}`;
      break;
    }
    default:
      return null;
  }

  if (!target) return null;
  return {
    target: `${accountPrefix(data)}${eventName.startsWith('mailbox') ? 'mailbox' : eventName}:${target.slice(0, MAX_KEY_PART_LENGTH * 4)}`,
    change: `${change}@${timestamp.slice(0, MAX_KEY_PART_LENGTH)}`,
  };
}

function getLegacyEventKey(eventName, data) {
  const message = data.message && typeof data.message === 'object' ? data.message : data;
  let identity = '';
  switch (eventName) {
    // A UID is only unique within one mailbox and one UIDVALIDITY, so both
    // are part of the identity when the payload names them.
    case 'newMessage': {
      const uid = firstNonEmpty(
        message.uid,
        message.id,
        message.message_id,
        message.MessageId,
        message.messageId,
      );
      if (!uid) return '';
      identity = [
        // the socket names the mailbox by path, push by id: prefer the path
        firstNonEmpty(message.folder_path, data.path, data.mailbox),
        getUidValidity(data),
        uid,
      ]
        .filter(Boolean)
        .join('>');
      break;
    }
    // The server names the moved and copied messages in sourceUid and
    // destinationUid. Without the UIDs every move between the same two
    // folders had one identity, and each one after the first was dropped.
    case 'messagesMoved': {
      const uids = firstNonEmpty(
        joinUids(data.uids),
        joinUids(data.sourceUid),
        joinUids(data.source_uid),
        data.uid,
      );
      if (!uids) return '';
      identity = [
        firstNonEmpty(data.sourceMailbox, data.source_mailbox),
        firstNonEmpty(data.destinationMailbox, data.destination_mailbox),
        getUidValidity(data),
        uids,
      ]
        .filter(Boolean)
        .join('>');
      break;
    }
    case 'messagesCopied': {
      const uids = firstNonEmpty(
        joinUids(data.uids),
        joinUids(data.destinationUid),
        joinUids(data.destination_uid),
        data.uid,
      );
      if (!uids) return '';
      identity = [
        firstNonEmpty(data.destinationMailbox, data.destination_mailbox),
        getUidValidity(data),
        uids,
      ]
        .filter(Boolean)
        .join('>');
      break;
    }
    case 'flagsUpdated':
    case 'labelsUpdated':
      identity = [
        firstNonEmpty(data.mailbox, data.path),
        firstNonEmpty(joinUids(data.uids), data.uid, data.id),
        firstNonEmpty(joinValues(data.flags), joinValues(data.labels), data.action),
      ].join('>');
      break;
    case 'messagesExpunged': {
      // without UIDs this would name every expunge in the mailbox
      const uids = firstNonEmpty(joinUids(data.uids), data.uid, data.id);
      if (!uids) return '';
      identity = [firstNonEmpty(data.mailbox, data.path), getUidValidity(data), uids]
        .filter(Boolean)
        .join('>');
      break;
    }
    case 'mailboxCreated':
    case 'mailboxDeleted':
      identity = firstNonEmpty(data.path, data.mailbox?.path, data.mailbox);
      break;
    case 'mailboxRenamed':
      identity = `${firstNonEmpty(data.oldPath, data.old_path)}>${firstNonEmpty(
        data.newPath,
        data.new_path,
      )}`;
      break;
    case 'calendarCreated':
    case 'calendarUpdated':
    case 'calendarDeleted':
      identity = firstNonEmpty(data.calendarId, data.calendar_id, data.href, data.path, data.id);
      break;
    case 'calendarEventCreated':
    case 'calendarEventUpdated':
    case 'calendarEventDeleted':
      identity = getCalendarIdentity(data);
      break;
    case 'addressBookCreated':
    case 'addressBookUpdated':
    case 'addressBookDeleted':
      // the server sends the address book as data.addressBook
      identity = firstNonEmpty(
        data.addressBook?.id,
        data.addressBook?.addressBookId,
        data.addressBookId,
        data.address_book_id,
        data.href,
        data.path,
        data.id,
      );
      break;
    case 'contactCreated':
    case 'contactUpdated':
    case 'contactDeleted':
      identity = getContactIdentity(data);
      break;
    case 'newRelease':
      identity = firstNonEmpty(
        data.release?.tagName,
        data.release?.tag_name,
        data.release?.version,
        data.tagName,
        data.tag_name,
        data.version,
      );
      break;
    default:
      return '';
  }

  const normalizedIdentity = identity.replace(/^>+|>+$/g, '');
  return normalizedIdentity
    ? `${accountPrefix(data)}legacy:${eventName}:${normalizedIdentity.slice(0, MAX_KEY_PART_LENGTH)}`
    : '';
}

/**
 * @param {Object} options
 * @param {(eventName: string, data: Object, context: Object) => void} options.onEvent
 * @param {() => boolean} [options.isVisible] Deprecated — no longer used internally.
 * @param {number} [options.pushCoalesceMs]
 * @param {(eventName: string, data: Object) => boolean} [options.shouldHoldSocketEvent]
 *   Return true to hold a socket event until its push copy arrives (or
 *   socketHoldMs passes), because the system may draw that push itself. On
 *   macOS the socket copy usually wins the race; shown at once, the app and
 *   the system would both notify.
 * @param {number} [options.socketHoldMs]
 * @returns {{handleWebSocket: Function, handlePush: Function, destroy: Function}}
 */
export function createRealtimeEventCoalescer({
  onEvent,
  // eslint-disable-next-line no-unused-vars
  isVisible = () => document.visibilityState === 'visible',
  pushCoalesceMs = PUSH_COALESCE_MS,
  shouldHoldSocketEvent = () => false,
  socketHoldMs = SOCKET_HOLD_FOR_PUSH_MS,
}) {
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');

  // key -> expiry time
  const seenEvents = new Map();
  // repeatable target -> { change, expiresAt } of the last delivered change
  const recentChanges = new Map();
  const pendingPushEvents = new Map();
  const heldSocketEvents = new Map();
  let destroyed = false;

  const pruneMap = (map, now) => {
    for (const [key, value] of map) {
      const expiresAt = typeof value === 'number' ? value : value.expiresAt;
      if (now >= expiresAt) map.delete(key);
    }
    while (map.size > MAX_TRANSPORT_DEDUP_ENTRIES) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  };

  const hasSeen = (keys, now = Date.now()) => {
    for (const key of keys) {
      const expiresAt = seenEvents.get(key);
      if (expiresAt !== undefined && now < expiresAt) return true;
    }

    return false;
  };

  const remember = (entries, now = Date.now()) => {
    if (!entries.length) return;
    for (const { key, ttl } of entries) {
      seenEvents.delete(key);
      seenEvents.set(key, now + ttl);
    }

    pruneMap(seenEvents, now);
  };

  // True when this change repeats the last delivered change of its target
  // within the copy window. Otherwise records it as the last change.
  const isRepeatedChange = (eventName, data, now = Date.now()) => {
    const repeatable = getRepeatableChange(eventName, data);
    if (!repeatable) return false;
    const last = recentChanges.get(repeatable.target);
    if (last && now < last.expiresAt && last.change === repeatable.change) return true;
    recentChanges.delete(repeatable.target);
    recentChanges.set(repeatable.target, {
      change: repeatable.change,
      expiresAt: now + REPEATABLE_CONTENT_TTL_MS,
    });
    pruneMap(recentChanges, now);
    return false;
  };

  const consume = (source, eventName, data, suppressVisual = false) => {
    if (destroyed) return false;
    const entries = getRealtimeEventKeyEntries(eventName, data);
    if (hasSeen(entries.map((entry) => entry.key))) return false;
    // Remembered either way, so the push copy of a dropped copy is dropped too.
    remember(entries);
    if (isRepeatedChange(eventName, data)) return false;
    onEvent(eventName, data, { source, suppressVisual });
    return true;
  };

  // A pending entry is registered under EVERY key its payload answers to, so
  // clearing it must remove every registration, not just the key it was
  // found under.
  const deletePendingEntry = (entry) => {
    for (const key of entry.keys) pendingPushEvents.delete(key);
  };

  const deleteHeldEntry = (entry) => {
    for (const key of entry.keys) heldSocketEvents.delete(key);
  };

  const findHeldEntry = (keys) => {
    for (const key of keys) {
      const entry = heldSocketEvents.get(key);
      if (entry) return entry;
    }

    return null;
  };

  const wantsHold = (eventName, data) => {
    try {
      return shouldHoldSocketEvent(eventName, data) === true;
    } catch {
      return false;
    }
  };

  const handleWebSocket = (eventName, data) => {
    if (destroyed) return false;
    const keys = getRealtimeEventKeys(eventName, data);
    let pendingPush = null;
    for (const key of keys) {
      pendingPush = pendingPushEvents.get(key);
      if (pendingPush) break;
    }

    if (pendingPush) {
      clearTimeout(pendingPush.timer);
      deletePendingEntry(pendingPush);
      // The OS already showed this notification via push (FCM/APNs).
      // Suppress the client-side visual to avoid a duplicate.
      if (pendingPush.displayedBySystem) {
        return consume('websocket', eventName, data, true);
      }

      return consume('websocket', eventName, data);
    }

    // Already consumed, or a duplicate of a socket event that is being held.
    if (hasSeen(keys) || findHeldEntry(keys)) return false;

    if (keys.length > 0 && wantsHold(eventName, data)) {
      const entry = { timer: null, keys };
      entry.timer = setTimeout(() => {
        deleteHeldEntry(entry);
        consume('websocket', eventName, data);
      }, socketHoldMs);
      entry.release = (suppressVisual) => {
        clearTimeout(entry.timer);
        deleteHeldEntry(entry);
        return consume('websocket', eventName, data, suppressVisual);
      };
      for (const key of keys) heldSocketEvents.set(key, entry);
      return true;
    }

    return consume('websocket', eventName, data);
  };

  const handlePush = (data) => {
    if (destroyed || !data || typeof data !== 'object') return false;
    const eventName = data.event;
    if (typeof eventName !== 'string' || !eventName) return false;

    const keys = getRealtimeEventKeys(eventName, data);

    // The socket copy is being held for this push: consume the socket copy
    // (it carries richer data) now, without a visual when the system showed
    // the push itself.
    const held = findHeldEntry(keys);
    if (held) return held.release(data.displayedBySystem === true);

    if (hasSeen(keys) || keys.some((key) => pendingPushEvents.has(key))) return false;

    // suppressVisual only when the OS already displayed this notification
    // (FCM notification field / APNs alert). The notification-manager handles
    // the foreground-vs-background visual split (toast vs OS notification).
    const suppressVisual = data.displayedBySystem === true;
    const entry = { timer: null, displayedBySystem: suppressVisual, keys };
    const consumePush = () => {
      deletePendingEntry(entry);
      consume('push', eventName, data, suppressVisual);
    };

    // Always wait for WS to arrive (it carries richer data). If WS doesn't
    // arrive within the coalesce window, the push event is consumed as-is.
    entry.timer = setTimeout(consumePush, pushCoalesceMs);
    for (const key of keys) pendingPushEvents.set(key, entry);
    return true;
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const { timer } of pendingPushEvents.values()) clearTimeout(timer);
    pendingPushEvents.clear();
    for (const { timer } of heldSocketEvents.values()) clearTimeout(timer);
    heldSocketEvents.clear();
    seenEvents.clear();
    recentChanges.clear();
  };

  return { handleWebSocket, handlePush, destroy };
}
