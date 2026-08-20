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

export const PUSH_COALESCE_MS = 1500;
export const TRANSPORT_DEDUP_TTL_MS = 5 * 60 * 1000;
export const MAX_TRANSPORT_DEDUP_ENTRIES = 500;

const MAX_KEY_PART_LENGTH = 256;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const stringValue = String(value).trim();
    if (stringValue) return stringValue;
  }
  return '';
}

function joinValues(value) {
  return Array.isArray(value) ? value.map(String).join(',') : '';
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
 * Return EVERY key this event answers to: the notification_id key when the
 * payload carries one, plus the legacy identity key. Registering and looking
 * up under both is what lets a push that carries notification_id coalesce
 * with a WebSocket copy that lacks it (or vice versa) on mixed-version
 * deployments.
 */
export function getRealtimeEventKeys(eventName, data) {
  if (typeof eventName !== 'string' || !data || typeof data !== 'object') return [];

  const keys = [];

  // notification_id is minted per delivery by the server, so it is already
  // globally unique and needs no account scoping.
  const notificationId = firstNonEmpty(data.notification_id, data.notificationId);
  if (notificationId) keys.push(`id:${notificationId.slice(0, MAX_KEY_PART_LENGTH)}`);

  const legacyKey = getLegacyEventKey(eventName, data);
  if (legacyKey) keys.push(legacyKey);

  return keys;
}

function getLegacyEventKey(eventName, data) {
  const message = data.message && typeof data.message === 'object' ? data.message : data;
  let identity = '';
  switch (eventName) {
    case 'newMessage':
      identity = firstNonEmpty(
        message.uid,
        message.id,
        message.message_id,
        message.MessageId,
        message.messageId,
      );
      break;
    case 'messagesMoved':
      identity = [
        firstNonEmpty(data.sourceMailbox, data.source_mailbox),
        firstNonEmpty(data.destinationMailbox, data.destination_mailbox),
        firstNonEmpty(joinValues(data.uids), data.uid),
      ].join('>');
      break;
    case 'messagesCopied':
      identity = [
        firstNonEmpty(data.destinationMailbox, data.destination_mailbox),
        firstNonEmpty(joinValues(data.uids), data.uid),
      ].join('>');
      break;
    case 'flagsUpdated':
    case 'labelsUpdated':
      identity = [
        firstNonEmpty(data.mailbox, data.path),
        firstNonEmpty(joinValues(data.uids), data.uid, data.id),
        firstNonEmpty(joinValues(data.flags), joinValues(data.labels), data.action),
      ].join('>');
      break;
    case 'messagesExpunged':
      identity = [
        firstNonEmpty(data.mailbox, data.path),
        firstNonEmpty(joinValues(data.uids), data.uid, data.id),
      ].join('>');
      break;
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
    case 'addressBookDeleted':
      identity = firstNonEmpty(
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
 * @returns {{handleWebSocket: Function, handlePush: Function, destroy: Function}}
 */
export function createRealtimeEventCoalescer({
  onEvent,
  // eslint-disable-next-line no-unused-vars
  isVisible = () => document.visibilityState === 'visible',
  pushCoalesceMs = PUSH_COALESCE_MS,
}) {
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');

  const seenEvents = new Map();
  const pendingPushEvents = new Map();
  let destroyed = false;

  const pruneSeenEvents = (now) => {
    for (const [key, timestamp] of seenEvents) {
      if (now - timestamp >= TRANSPORT_DEDUP_TTL_MS) seenEvents.delete(key);
    }
    while (seenEvents.size > MAX_TRANSPORT_DEDUP_ENTRIES) {
      const oldestKey = seenEvents.keys().next().value;
      if (oldestKey === undefined) break;
      seenEvents.delete(oldestKey);
    }
  };

  const hasSeen = (keys, now = Date.now()) => {
    for (const key of keys) {
      const timestamp = seenEvents.get(key);
      if (timestamp !== undefined && now - timestamp < TRANSPORT_DEDUP_TTL_MS) return true;
    }

    return false;
  };

  const remember = (keys, now = Date.now()) => {
    if (!keys.length) return;
    for (const key of keys) {
      seenEvents.delete(key);
      seenEvents.set(key, now);
    }

    pruneSeenEvents(now);
  };

  const consume = (source, eventName, data, suppressVisual = false) => {
    if (destroyed) return false;
    const keys = getRealtimeEventKeys(eventName, data);
    if (hasSeen(keys)) return false;
    remember(keys);
    onEvent(eventName, data, { source, suppressVisual });
    return true;
  };

  // A pending entry is registered under EVERY key its payload answers to, so
  // clearing it must remove every registration, not just the key it was
  // found under.
  const deletePendingEntry = (entry) => {
    for (const key of entry.keys) pendingPushEvents.delete(key);
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
    }

    return consume('websocket', eventName, data);
  };

  const handlePush = (data) => {
    if (destroyed || !data || typeof data !== 'object') return false;
    const eventName = data.event;
    if (typeof eventName !== 'string' || !eventName) return false;

    const keys = getRealtimeEventKeys(eventName, data);
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
    seenEvents.clear();
  };

  return { handleWebSocket, handlePush, destroy };
}
