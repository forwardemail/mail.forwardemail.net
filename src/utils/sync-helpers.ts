import { Local } from './storage.js';
import {
  extractAddressList,
  displayAddresses,
  toDisplayAddress,
  type AddressObject,
} from './address.js';
import { decodeMimeHeader } from './mime-utils.js';
import { isHiddenLabel } from './label-filters';
import { decodeLabelBuffer } from '../workers/sync-pure';
import type { Message, MessageBody } from '$types';

type RawMessage = Record<string, unknown> & {
  nodemailer?: {
    headers?: Record<string, string>;
    Headers?: Record<string, string>;
    from?: AddressObject;
    textAsHtml?: string;
    text?: string;
    html?: string;
  };
};

/**
 * Strip HTML tags, style/script blocks, and HTML entities from a string,
 * then collapse whitespace and truncate to produce a clean plaintext snippet.
 */
function stripHtmlToPlaintext(html: string, maxLen = 160): string {
  if (!html) return '';
  const cleaned = String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|blockquote|pre)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&[#\w]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

export const accountKey = (account?: string | null): string =>
  account || Local.get('email') || 'default';

const LABEL_FIELD_KEYS = [
  'labels',
  'label_ids',
  'labelIds',
  'Labels',
  'tags',
  'Tags',
  'LabelIds',
  'keywords',
  'Keywords',
  'keyword',
];

export function hasLabelData(raw: Record<string, unknown> = {}): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return LABEL_FIELD_KEYS.some(
    (key) => Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined,
  );
}

const isDebugFromField = (): boolean => {
  try {
    return Local.get('debug_perf') === '1' || Local.get('debug_from_field') === '1';
  } catch {
    return false;
  }
};

/**
 * Last-resort derivation of *some* from-string when all the structured
 * sources (From, nodemailer.from, headers, envelope, Sender) come back
 * empty. Better to render "via example.com" than an empty cell — and far
 * better than persisting `''` which we can't distinguish from "never
 * fetched" later.
 *
 * Probes (in order):
 *   - Return-Path: header (set by every receiving MTA)
 *   - nodemailer.envelope.from / msg.envelope.from
 *   - Message-ID's domain (extract the @host part of a stored message_id)
 */
function deriveFromFallback(raw: RawMessage): string {
  const headers =
    (raw.nodemailer?.headers as Record<string, string> | undefined) ||
    (raw.nodemailer?.Headers as Record<string, string> | undefined) ||
    {};
  const probeHeader = (name: string): string => {
    const lower = name.toLowerCase();
    const direct = headers[name] || headers[lower];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const matchKey = Object.keys(headers).find((key) => key.toLowerCase() === lower);
    if (matchKey && typeof headers[matchKey] === 'string') return headers[matchKey].trim();
    return '';
  };

  const returnPath = probeHeader('Return-Path');
  if (returnPath) {
    const stripped = returnPath.replace(/^<|>$/g, '').trim();
    if (stripped) return stripped;
  }

  const envFrom =
    raw.nodemailer?.envelope?.from || (raw.envelope as { from?: string } | undefined)?.from;
  if (typeof envFrom === 'string' && envFrom.trim()) return envFrom.trim();

  const messageId =
    (raw.message_id as string) ||
    (raw.MessageId as string) ||
    (raw['Message-ID'] as string) ||
    headers['message-id'] ||
    headers['Message-ID'] ||
    '';
  if (typeof messageId === 'string') {
    const match = messageId.match(/@([^>\s]+)/);
    if (match?.[1]) return `<unknown@${match[1].trim()}>`;
  }

  return '';
}

export function extractFromField(raw: RawMessage): string {
  const parsedList = extractAddressList(raw as never, 'from');
  const parsedDisplay = displayAddresses(parsedList).join(', ');
  if (parsedDisplay) {
    return parsedDisplay;
  }

  const fromVal =
    (raw.From as AddressObject) || (raw.from as AddressObject) || raw.nodemailer?.from;

  let primary = '';
  if (!fromVal) {
    const senderDisplay = toDisplayAddress(raw.sender as AddressObject);
    primary = senderDisplay || (typeof raw.sender === 'string' ? raw.sender : '');
  } else if (Array.isArray(fromVal)) {
    primary = displayAddresses(fromVal).join(', ');
  } else if (
    typeof fromVal === 'object' &&
    Array.isArray((fromVal as { value?: unknown[] }).value)
  ) {
    primary = displayAddresses((fromVal as { value: AddressObject[] }).value).join(', ');
  }
  if (!primary) {
    primary = toDisplayAddress(fromVal) || '';
  }
  if (primary) return primary;

  const fallback = deriveFromFallback(raw);
  if (fallback) return fallback;

  if (isDebugFromField()) {
    console.warn('[sync-helpers] extractFromField: no from derivable', {
      id: raw.id || raw.Id || raw.uid || raw.Uid,
      keys: Object.keys(raw || {}),
      nodemailerKeys: raw.nodemailer ? Object.keys(raw.nodemailer) : null,
      headerKeys: raw.nodemailer?.headers ? Object.keys(raw.nodemailer.headers) : null,
    });
  }

  return '';
}

export function extractRecipientsField(raw: RawMessage, field: string = 'to'): string {
  const parsedList = extractAddressList(raw as never, field);
  const parsedDisplay = displayAddresses(parsedList).join(', ');
  if (parsedDisplay) {
    return parsedDisplay;
  }

  const fieldVal =
    (raw[field] as AddressObject) ||
    (raw[field.charAt(0).toUpperCase() + field.slice(1)] as AddressObject) ||
    ((raw.nodemailer as Record<string, unknown>)?.[field] as AddressObject);

  if (!fieldVal) {
    return '';
  }

  if (typeof fieldVal === 'string') {
    return toDisplayAddress(fieldVal);
  }

  if (Array.isArray(fieldVal)) {
    return displayAddresses(fieldVal).join(', ');
  }

  if (typeof fieldVal === 'object') {
    if ((fieldVal as { text?: string }).text) {
      return toDisplayAddress((fieldVal as { text: string }).text);
    }
    if (Array.isArray((fieldVal as { value?: unknown[] }).value)) {
      return displayAddresses((fieldVal as { value: AddressObject[] }).value).join(', ');
    }
  }

  return toDisplayAddress(fieldVal) || '';
}

interface LabelLike {
  id?: string;
  Id?: string;
  keyword?: string;
  value?: string;
  name?: string;
  label?: string;
}

export function normalizeMessageForCache(
  raw: RawMessage = {},
  folder?: string,
  account: string = accountKey(),
): Message {
  const flags = Array.isArray(raw.flags) ? (raw.flags as string[]) : [];
  const nodemailerHeaders =
    raw.nodemailer?.headers || raw.nodemailer?.Headers || ({} as Record<string, string>);
  const headerMessageId =
    (raw.header_message_id as string) ||
    (raw.headerMessageId as string) ||
    nodemailerHeaders['message-id'] ||
    nodemailerHeaders['Message-ID'] ||
    null;
  const inReplyToHeader =
    (raw.in_reply_to as string) ||
    (raw.inReplyTo as string) ||
    (raw['In-Reply-To'] as string) ||
    nodemailerHeaders['in-reply-to'] ||
    nodemailerHeaders['In-Reply-To'] ||
    null;
  const referencesHeader =
    (raw.references as string) ||
    (raw.References as string) ||
    nodemailerHeaders.references ||
    nodemailerHeaders.References ||
    null;
  // Only use server-assigned identifiers for the record ID.
  // Email headers (message_id, header_message_id) must NOT be used here —
  // forwarded emails and replies can share the same Message-ID header,
  // causing distinct messages to collide and overwrite each other in IDB.
  const apiId = (raw.id as string) || (raw.Id as string);
  const uid = (raw.Uid as number) || (raw.uid as number) || null;
  // Prefer internal_date — the IMAP INTERNALDATE / true server receive time.
  // It is reliable for both display and sort (server-assigned, not subject to
  // sender clock skew). created_at is the DB record's INSERT time, NOT the
  // message's receive time: the backend builds each per-mailbox SQLite store
  // lazily, so on a fresh sync every created_at ≈ the moment of sync — which is
  // exactly the "every email arrived at the moment of sync" bug. Keep created_at
  // only as a last resort. Never fall back to Date.now() (dateMs stays 0 when a
  // date is truly absent; the UI must not stamp the sync time).
  const dateVal =
    (raw.internal_date as string) ||
    (raw.date as string | number) ||
    (raw.Date as string | number) ||
    (raw.header_date as string) ||
    (raw.created_at as string | number) ||
    (raw.received_at as string);
  const parsedDate = dateVal ? new Date(dateVal) : null;
  const dateMs = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.getTime() : 0;
  const subject = decodeMimeHeader(
    (raw.Subject as string) || (raw.subject as string) || '(No subject)',
  );
  const rawLabels =
    (raw.labels as unknown[]) ||
    (raw.label_ids as unknown[]) ||
    (raw.labelIds as unknown[]) ||
    (raw.Labels as unknown[]) ||
    (raw.tags as unknown[]) ||
    (raw.Tags as unknown[]) ||
    (raw.LabelIds as unknown[]) ||
    (raw.keywords as unknown) ||
    (raw.Keywords as unknown) ||
    (raw.keyword as unknown) ||
    [];

  const normalizeLabel = (label: unknown): string => {
    const normalized = String(label ?? '').trim();
    if (!normalized || /^\[\s*\]$/.test(normalized)) return '';
    return normalized;
  };

  // Defensive: the list/folders endpoint can return `labels` as a serialized
  // Buffer ({type:"Buffer", data:[...]}) instead of the decoded array the
  // detail endpoint returns. Decode it first so the real label isn't mangled
  // into the object's keys ("type","data") by the Object.entries branch below
  // (or dropped). STOPGAP until the API returns a string array consistently.
  const bufferLabels = decodeLabelBuffer(rawLabels);
  const extractedLabels = bufferLabels
    ? bufferLabels.map((l) => normalizeLabel(l)).filter(Boolean)
    : Array.isArray(rawLabels)
      ? rawLabels
          .map((l) => {
            if (typeof l === 'string') return normalizeLabel(l);
            if (typeof l === 'number') return normalizeLabel(String(l));
            if (l && typeof l === 'object') {
              const lObj = l as LabelLike;
              return normalizeLabel(
                lObj.id || lObj.Id || lObj.keyword || lObj.value || lObj.name || lObj.label || '',
              );
            }
            return '';
          })
          .filter(Boolean)
      : typeof rawLabels === 'string'
        ? (rawLabels as string)
            .split(',')
            .map((l: string) => normalizeLabel(l))
            .filter(Boolean)
        : rawLabels && typeof rawLabels === 'object'
          ? Object.entries(rawLabels as Record<string, unknown>)
              .filter(
                ([, enabled]) => enabled !== false && enabled !== null && enabled !== undefined,
              )
              .map(([label]) => normalizeLabel(label))
              .filter(Boolean)
          : [];
  const labels = extractedLabels.filter((l) => !isHiddenLabel(l));

  const isUnreadRaw =
    Array.isArray(flags) && flags.length
      ? !flags.includes('\\Seen')
      : ((raw.is_unread as boolean) ??
        (raw.isUnread as boolean) ??
        (raw.IsUnread as boolean) ??
        true);
  const isUnread = typeof isUnreadRaw === 'boolean' ? isUnreadRaw : Boolean(isUnreadRaw);

  const toField = extractRecipientsField(raw, 'to');
  const ccField = extractRecipientsField(raw, 'cc');
  const bccField = extractRecipientsField(raw, 'bcc');
  const replyToField = extractRecipientsField(raw, 'replyTo');

  return {
    id: apiId || (uid != null ? String(uid) : null) || headerMessageId,
    account,
    folder:
      (raw.folder_path as string) || (raw.folder as string) || (raw.path as string) || folder || '',
    folder_id:
      (raw.folder_id as string) || (raw.folderId as string) || (raw.FolderId as string) || null,
    date: dateMs,
    dateMs,
    from: extractFromField(raw),
    to: toField || undefined,
    cc: ccField || undefined,
    bcc: bccField || undefined,
    reply_to: replyToField || null,
    subject,
    snippet: (() => {
      // Prefer pre-computed plaintext sources first
      const plain =
        (raw.Plain as string) ||
        (raw.snippet as string) ||
        (raw.preview as string) ||
        (raw.text as string) ||
        raw.nodemailer?.text ||
        '';
      if (plain) return stripHtmlToPlaintext(plain);
      // Fall back to HTML body sources, stripping tags
      const html =
        (raw.textAsHtml as string) ||
        raw.nodemailer?.textAsHtml ||
        (raw.html as string) ||
        raw.nodemailer?.html ||
        '';
      return stripHtmlToPlaintext(html);
    })(),
    flags,
    is_unread: isUnread,
    is_unread_index: isUnread ? 1 : 0,
    is_starred: Boolean(raw.is_flagged) || Boolean(raw.is_starred) || flags.includes('\\Flagged'),
    is_flagged: Boolean(raw.is_flagged) || Boolean(raw.is_starred) || flags.includes('\\Flagged'),
    has_attachment: (() => {
      const fromFlag = Boolean(raw.has_attachment || raw.hasAttachments);
      const fromArray = Array.isArray(raw.attachments) && (raw.attachments as unknown[]).length > 0;
      return fromFlag || fromArray;
    })(),
    modseq: (raw.modseq as string) || (raw.ModSeq as string) || (raw.modSeq as string) || null,
    message_id:
      (raw.MessageId as string) ||
      (raw.message_id as string) ||
      (raw['Message-ID'] as string) ||
      headerMessageId ||
      apiId,
    root_id: (raw.root_id as string) || (raw.rootId as string) || null,
    thread_id:
      (raw.thread_id as string) ||
      (raw.threadId as string) ||
      (raw.thread as string) ||
      (raw.root_id as string) ||
      null,
    uid: uid || null,
    header_message_id: headerMessageId,
    in_reply_to: inReplyToHeader || null,
    references: referencesHeader || null,
    labels,
    bodyIndexed: false,
    updatedAt: Date.now(),
  };
}

interface MergeResult {
  record: Partial<Message>;
  changed: boolean;
}

export function mergeFlagsAndMetadata(
  existing: Partial<Message> = {},
  incoming: Partial<Message> = {},
): MergeResult {
  const next = { ...existing };
  let changed = false;

  const nextFlags = Array.isArray(incoming.flags) ? incoming.flags : existing.flags || [];
  const existingFlags = existing.flags || [];
  // Compare the flag *set*, not its order. The server frequently returns the
  // same flags in a different order; treating that as a change would bump
  // updatedAt, rewrite the record, re-index search, and re-render the row on
  // every sync for no reason.
  if (JSON.stringify([...nextFlags].sort()) !== JSON.stringify([...existingFlags].sort())) {
    next.flags = nextFlags;
    changed = true;
  }

  const nextUnread = incoming.is_unread ?? existing.is_unread;
  const normalizedUnread = typeof nextUnread === 'boolean' ? nextUnread : Boolean(nextUnread);
  if (normalizedUnread !== existing.is_unread) {
    next.is_unread = normalizedUnread;
    next.is_unread_index = normalizedUnread ? 1 : 0;
    changed = true;
  }

  const nextStarred = incoming.is_starred ?? existing.is_starred;
  if (nextStarred !== existing.is_starred) {
    next.is_starred = nextStarred;
    changed = true;
  }

  if (incoming.modseq && incoming.modseq !== existing.modseq) {
    next.modseq = incoming.modseq;
    changed = true;
  }

  const incomingFrom = typeof incoming.from === 'string' ? incoming.from.trim() : '';
  const existingFrom = typeof existing.from === 'string' ? existing.from.trim() : '';
  if (incomingFrom && incomingFrom !== existingFrom) {
    next.from = incoming.from;
    changed = true;
  }

  const incomingReplyTo = typeof incoming.reply_to === 'string' ? incoming.reply_to.trim() : '';
  const existingReplyTo = typeof existing.reply_to === 'string' ? existing.reply_to.trim() : '';
  if (incomingReplyTo && incomingReplyTo !== existingReplyTo) {
    next.reply_to = incoming.reply_to;
    changed = true;
  }

  // Merge labels — the API is the source of truth for cross-client sync
  if (Array.isArray(incoming.labels)) {
    const existingLabels = Array.isArray(existing.labels) ? existing.labels : [];
    const incomingLabels = incoming.labels.filter(
      (l): l is string => typeof l === 'string' && l.length > 0,
    );
    if (JSON.stringify(incomingLabels) !== JSON.stringify(existingLabels)) {
      next.labels = incomingLabels;
      changed = true;
    }
  }

  if (changed) {
    next.updatedAt = Date.now();
  }

  return { record: changed ? next : existing, changed };
}

export function isCachedBodyComplete(
  cached: Partial<MessageBody> | null | undefined,
  message: Partial<Message> | null | undefined,
): boolean {
  if (!cached?.body) return false;
  if (message?.has_attachment && !(cached.attachments || []).length) return false;
  return true;
}

export function abortIfNeeded(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

export function didMetadataChange(
  candidate: Partial<Message> = {},
  existing: Partial<Message> | null = {},
): boolean {
  if (!existing) return true;
  const sameFlags = JSON.stringify(candidate.flags || []) === JSON.stringify(existing.flags || []);
  const sameUnread = candidate.is_unread === existing.is_unread;
  const sameStar = candidate.is_starred === existing.is_starred;
  const sameModSeq = !candidate.modseq || candidate.modseq === existing.modseq;
  return !(sameFlags && sameUnread && sameStar && sameModSeq);
}

export function getMessageApiId(
  msg: (Partial<Message> & Record<string, unknown>) | null | undefined = {},
): string | number | null {
  if (!msg) return null;

  return (
    (msg.id as string) ||
    (msg.message_id as string) ||
    (msg.header_message_id as string) ||
    (msg.uid as number) ||
    (msg.Uid as number) ||
    null
  );
}
