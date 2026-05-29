/* Shared message-record normalizer for the service-worker background sync.
 *
 * Loaded via importScripts (see workbox.config.cjs) BEFORE sw-sync.js so the
 * global is defined first. Plain classic JS (no import/export) because the
 * service worker is not bundled and must avoid pulling in Dexie/ESM modules.
 *
 * The canonical implementation lives in src/utils/sync-helpers.ts
 * (normalizeMessageForCache). This file mirrors its data-integrity logic
 * (identity, the Dexie indexes, flags, threading, labels) so a message looks
 * the same regardless of which sync path populated the cache. That contract is
 * enforced by tests/unit/message-normalize-contract.test.ts.
 *
 * Caveats (best-effort here, full parity needs the bundled canonical — see #4b
 * in the arch backlog): `from`/`snippet`/`subject` are not MIME-decoded or
 * HTML-stripped, and hidden-label filtering is left to the canonical path.
 */
(function () {
  const normalizeLabelValue = (label) => {
    const normalized = String(label == null ? '' : label).trim();
    if (!normalized || /^\[\s*\]$/.test(normalized)) return '';
    return normalized;
  };

  const extractLabels = (raw) => {
    const rawLabels =
      raw.labels ||
      raw.label_ids ||
      raw.labelIds ||
      raw.Labels ||
      raw.tags ||
      raw.Tags ||
      raw.LabelIds ||
      raw.keywords ||
      raw.Keywords ||
      raw.keyword ||
      [];
    if (Array.isArray(rawLabels)) {
      return rawLabels
        .map((l) => {
          if (typeof l === 'string') return normalizeLabelValue(l);
          if (typeof l === 'number') return normalizeLabelValue(String(l));
          if (l && typeof l === 'object') {
            return normalizeLabelValue(
              l.id || l.Id || l.keyword || l.value || l.name || l.label || '',
            );
          }
          return '';
        })
        .filter(Boolean);
    }
    if (typeof rawLabels === 'string') {
      return rawLabels
        .split(',')
        .map((l) => normalizeLabelValue(l))
        .filter(Boolean);
    }
    if (rawLabels && typeof rawLabels === 'object') {
      return Object.entries(rawLabels)
        .filter(([, enabled]) => enabled !== false && enabled !== null && enabled !== undefined)
        .map(([label]) => normalizeLabelValue(label))
        .filter(Boolean);
    }
    return [];
  };

  function normalizeMessageRecord(raw, folder, account) {
    raw = raw || {};
    const nodemailerHeaders =
      (raw.nodemailer && (raw.nodemailer.headers || raw.nodemailer.Headers)) || {};
    const headerMessageId =
      raw.header_message_id ||
      raw.headerMessageId ||
      nodemailerHeaders['message-id'] ||
      nodemailerHeaders['Message-ID'] ||
      null;
    const inReplyToHeader =
      raw.in_reply_to ||
      raw.inReplyTo ||
      raw['In-Reply-To'] ||
      nodemailerHeaders['in-reply-to'] ||
      nodemailerHeaders['In-Reply-To'] ||
      null;
    const referencesHeader =
      raw.references ||
      raw.References ||
      nodemailerHeaders.references ||
      nodemailerHeaders.References ||
      null;

    // Only server-assigned identifiers form the record ID — email headers
    // (Message-ID) can collide across forwards/replies. Matches the canonical.
    const apiId = raw.id || raw.Id;
    const uid = raw.Uid || raw.uid || null;

    // Prefer server receive time over the sender's clock; never stamp Date.now().
    const dateVal =
      raw.created_at ||
      raw.date ||
      raw.Date ||
      raw.internal_date ||
      raw.header_date ||
      raw.received_at;
    const parsedDate = dateVal ? new Date(dateVal) : null;
    const dateMs = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.getTime() : 0;

    const subject = raw.Subject || raw.subject || '(No subject)';
    const flags = Array.isArray(raw.flags) ? raw.flags : [];

    const isUnreadRaw =
      Array.isArray(flags) && flags.length
        ? !flags.includes('\\Seen')
        : (raw.is_unread ?? raw.isUnread ?? raw.IsUnread ?? true);
    const isUnread = typeof isUnreadRaw === 'boolean' ? isUnreadRaw : Boolean(isUnreadRaw);
    const isFlagged =
      Boolean(raw.is_flagged) || Boolean(raw.is_starred) || flags.includes('\\Flagged');

    return {
      id: apiId || (uid != null ? String(uid) : null) || headerMessageId,
      account,
      folder: raw.folder_path || raw.folder || raw.path || folder || '',
      folder_id: raw.folder_id || raw.folderId || raw.FolderId || null,
      date: dateMs,
      dateMs,
      from:
        (raw.From && (raw.From.Display || raw.From.Email)) ||
        (raw.from && raw.from.text) ||
        raw.from ||
        raw.sender ||
        (raw.nodemailer && raw.nodemailer.from && raw.nodemailer.from.text) ||
        'Unknown',
      subject,
      snippet:
        (raw.Plain && raw.Plain.slice && raw.Plain.slice(0, 160)) ||
        raw.snippet ||
        raw.preview ||
        raw.text ||
        (raw.nodemailer && raw.nodemailer.text) ||
        raw.textAsHtml ||
        (raw.nodemailer && raw.nodemailer.textAsHtml) ||
        '',
      flags,
      is_unread: isUnread,
      is_unread_index: isUnread ? 1 : 0,
      is_starred: isFlagged,
      is_flagged: isFlagged,
      has_attachment:
        Boolean(raw.has_attachment || raw.hasAttachments) ||
        (Array.isArray(raw.attachments) && raw.attachments.length > 0),
      modseq: raw.modseq || raw.ModSeq || raw.modSeq || null,
      message_id: raw.MessageId || raw.message_id || raw['Message-ID'] || headerMessageId || apiId,
      root_id: raw.root_id || raw.rootId || null,
      thread_id: raw.thread_id || raw.threadId || raw.thread || raw.root_id || null,
      uid: uid || null,
      header_message_id: headerMessageId,
      in_reply_to: inReplyToHeader || null,
      references: referencesHeader || null,
      labels: extractLabels(raw),
      bodyIndexed: false,
      updatedAt: Date.now(),
    };
  }

  if (typeof self !== 'undefined') self.normalizeMessageRecord = normalizeMessageRecord;
  if (typeof globalThis !== 'undefined') globalThis.normalizeMessageRecord = normalizeMessageRecord;
})();
