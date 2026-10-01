/*
 * Normalize untrusted realtime payload fields (WebSocket and push).
 *
 * WebSocket events carry arrays and numbers. Push data (FCM in particular) is
 * a flat string map, so the same field can arrive as a JSON array string or a
 * comma separated list. Every reader goes through these helpers so both copies
 * of one event look the same, and so a malformed or oversized payload cannot
 * reach the stores.
 */

// An expunge of a large folder names every UID in one event. Past this cap
// the rest is left to the folder refresh that follows every event.
export const MAX_REALTIME_UIDS = 10_000;
export const MAX_REALTIME_STRINGS = 200;
const MAX_STRING_LENGTH = 256;

function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'number') return [value];
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return trimmed.split(',');
}

/** IMAP UIDs as positive integers, deduplicated, in payload order, at most `max`. */
export function normalizeUidList(value, max = MAX_REALTIME_UIDS) {
  const seen = new Set();
  for (const item of toList(value)) {
    if (typeof item !== 'number' && typeof item !== 'string') continue;
    const uid = Number(typeof item === 'string' ? item.trim() : item);
    if (!Number.isSafeInteger(uid) || uid <= 0 || seen.has(uid)) continue;
    seen.add(uid);
    if (seen.size >= max) break;
  }

  return [...seen];
}

/** Non-empty trimmed strings, deduplicated, length and count capped. */
export function normalizeStringList(value, max = MAX_REALTIME_STRINGS) {
  const result = new Set();
  for (const item of toList(value)) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const text = String(item).trim();
    if (!text || text.length > MAX_STRING_LENGTH) continue;
    result.add(text);
    if (result.size >= max) break;
  }

  return [...result];
}

/** A single identifier (mailbox id, path) as a trimmed, bounded string. */
export function normalizeIdentifier(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  return text && text.length <= MAX_STRING_LENGTH * 4 ? text : '';
}

const FLAG_ACTIONS = new Set(['add', 'remove', 'set']);

/** 'add' | 'remove' | 'set', or '' for anything else. */
export function normalizeFlagAction(value) {
  return typeof value === 'string' && FLAG_ACTIONS.has(value) ? value : '';
}
