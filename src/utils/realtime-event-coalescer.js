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
 * Return the stable identifier shared by the WebSocket and push copies.
 * The legacy identities keep mixed-version deployments usable while rolling
 * out notification_id; they intentionally avoid display text, which may cause
 * unrelated events to be coalesced.
 */
export function getRealtimeEventKey(eventName, data) {
  if (typeof eventName !== 'string' || !data || typeof data !== 'object') return '';

  const notificationId = firstNonEmpty(data.notification_id, data.notificationId);
  if (notificationId) return `id:${notificationId.slice(0, MAX_KEY_PART_LENGTH)}`;

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
    ? `legacy:${eventName}:${normalizedIdentity.slice(0, MAX_KEY_PART_LENGTH)}`
    : '';
}

/**
 * @param {Object} options
 * @param {(eventName: string, data: Object, context: Object) => void} options.onEvent
 * @param {() => boolean} [options.isVisible]
 * @param {number} [options.pushCoalesceMs]
 * @returns {{handleWebSocket: Function, handlePush: Function, destroy: Function}}
 */
export function createRealtimeEventCoalescer({
  onEvent,
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

  const hasSeen = (key, now = Date.now()) => {
    if (!key) return false;
    const timestamp = seenEvents.get(key);
    return timestamp !== undefined && now - timestamp < TRANSPORT_DEDUP_TTL_MS;
  };

  const remember = (key, now = Date.now()) => {
    if (!key) return;
    seenEvents.delete(key);
    seenEvents.set(key, now);
    pruneSeenEvents(now);
  };

  const consume = (source, eventName, data, suppressVisual = false) => {
    if (destroyed) return false;
    const key = getRealtimeEventKey(eventName, data);
    if (hasSeen(key)) return false;
    remember(key);
    onEvent(eventName, data, { source, suppressVisual });
    return true;
  };

  const handleWebSocket = (eventName, data) => {
    if (destroyed) return false;
    const key = getRealtimeEventKey(eventName, data);
    const pendingPush = key ? pendingPushEvents.get(key) : null;
    if (pendingPush) {
      clearTimeout(pendingPush.timer);
      pendingPushEvents.delete(key);
    }
    return consume('websocket', eventName, data);
  };

  const handlePush = (data) => {
    if (destroyed || !data || typeof data !== 'object') return false;
    const eventName = data.event;
    if (typeof eventName !== 'string' || !eventName) return false;

    const key = getRealtimeEventKey(eventName, data);
    if (hasSeen(key) || (key && pendingPushEvents.has(key))) return false;

    const visible = isVisible();
    const suppressVisual = data.displayedBySystem === true || !visible;
    const consumePush = () => {
      if (key) pendingPushEvents.delete(key);
      consume('push', eventName, data, suppressVisual);
    };

    if (visible) {
      const timer = setTimeout(consumePush, pushCoalesceMs);
      if (key) pendingPushEvents.set(key, { timer });
      return true;
    }

    return consume('push', eventName, data, suppressVisual);
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
