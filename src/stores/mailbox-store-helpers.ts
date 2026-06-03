// Pure helpers extracted from mailboxStore.ts so they can be unit-tested
// without loading the store's I/O graph (Dexie/db, sync worker, Remote, other
// stores). These are message-identity / list-merge / value-coercion helpers
// with no module state and no side effects. Anything touching db/Remote/stores
// (e.g. mergeMissingLabels/mergeMissingFrom) stays in mailboxStore.ts.
//
// Params are intentionally left loosely typed to match the originals verbatim
// (mailboxStore.ts is pervasively untyped) — this is a behavior-preserving
// extraction, not a retype.

// Validate a value the way Dexie validates a primary key, used as a fallback
// guard before writing to IndexedDB. Strings, finite numbers, Dates, and
// arrays of those are valid keys; null/undefined/objects/NaN are not.
export const isValidDexieKeyFallback = (key) => {
  if (key == null) return false;
  if (Array.isArray(key)) return key.every(isValidDexieKeyFallback);
  if (key instanceof Date) return true;
  const type = typeof key;
  if (type === 'string') return true;
  if (type === 'number') return Number.isFinite(key);
  return false;
};

// Normalize a labels value (array or comma-separated string) into a clean
// string[] — trims entries, drops empties and the literal "[]" placeholder.
export const coerceLabelList = (value) => {
  const normalizeLabel = (label) => {
    const normalized = String(label ?? '').trim();
    if (!normalized || /^\[\s*\]$/.test(normalized)) return '';
    return normalized;
  };
  if (Array.isArray(value)) {
    return value.map((label) => normalizeLabel(label)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((label) => normalizeLabel(label))
      .filter(Boolean);
  }
  return [];
};

export const hasFromValue = (value) => typeof value === 'string' && value.trim().length > 0;

// Derive a stable, collision-safe identity for a message used to dedup list
// pages. Prefer the server-assigned id/uid; fall back to the Message-ID header
// scoped by folder so forwarded copies sharing a Message-ID aren't collapsed.
export const getMessageKey = (msg) => {
  // Prefer server-assigned id/uid which is unique per message per folder.
  // Fallback to Message-ID header scoped by folder to avoid collapsing
  // forwarded emails that share the same Message-ID as the original.
  const uid = msg?.id ?? msg?.uid ?? msg?.Uid ?? msg?.uidnext;
  if (uid != null) return uid;
  const messageId =
    msg?.message_id ?? msg?.messageId ?? msg?.['Message-ID'] ?? msg?.header_message_id;
  if (messageId) {
    const folder = msg?.folder ?? '';
    return `${folder}:${messageId}`;
  }
  return null;
};

// Merge two message-list pages, preserving order (existing first, then
// incoming) and dropping duplicates by getMessageKey. Messages with no
// derivable key are always kept (can't dedup what we can't identify).
export const mergeMessagePages = (existing = [], incoming = []) => {
  const merged = [];
  const seen = new Set();
  const append = (list) => {
    (list || []).forEach((msg) => {
      const key = getMessageKey(msg);
      if (key == null) {
        merged.push(msg);
        return;
      }
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(msg);
    });
  };
  append(existing);
  append(incoming);
  return merged;
};
