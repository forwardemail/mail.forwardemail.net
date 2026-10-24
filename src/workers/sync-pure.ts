/**
 * Pure helpers used by sync.worker.ts. Extracted into their own module so
 * they can be unit-tested without constructing a real Worker.
 */

export function toUid(value: unknown): number | string {
  const num = Number(value);
  return Number.isFinite(num) ? num : (value as string | number) || 0;
}

export function toKey(account: string, folder: string): string {
  return `${account}::${folder}`;
}

export function accountKey(account: string | null | undefined): string {
  return account || 'default';
}

/**
 * Decode the `{ type: "Buffer", data: [...] }` shape that the list/folders API
 * returns for `labels` — the raw stored blob, framed around a JSON array —
 * into a string array. The message-detail endpoint already returns a decoded
 * array; this is a defensive STOPGAP for the list endpoint until it does the
 * same. Returns `null` when `value` is not a Buffer shape so callers fall back
 * to their normal array/string handling.
 */
export function decodeLabelBuffer(value: unknown): string[] | null {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { type?: unknown }).type !== 'Buffer' ||
    !Array.isArray((value as { data?: unknown }).data)
  ) {
    return null;
  }
  const data = (value as { data: unknown[] }).data;
  try {
    // Built-in byte/string handling (no Node Buffer in the worker/browser).
    const bytes = Uint8Array.from(data, (b) => Number(b) & 0xff);
    const decoder = new TextDecoder();
    // The blob frames a JSON array with a few non-ASCII codec bytes around it,
    // so the whole thing isn't valid JSON. The label content is ASCII, so
    // locate the bracketed JSON by byte and decode just that slice.
    const open = bytes.indexOf(0x5b); // '['
    const close = bytes.lastIndexOf(0x5d); // ']'
    if (open !== -1 && close > open) {
      const parsed: unknown = JSON.parse(decoder.decode(bytes.subarray(open, close + 1)));
      if (Array.isArray(parsed)) {
        return parsed.map((l) => String(l ?? '').trim()).filter(Boolean);
      }
    }
    // Fallback: scan the decoded text for quoted tokens if the JSON didn't parse.
    const tokens = decoder.decode(bytes).match(/"([^"\\]+)"/g);
    if (tokens) return tokens.map((t) => t.slice(1, -1).trim()).filter(Boolean);
  } catch {
    // malformed buffer — fall through to empty
  }
  return [];
}

/**
 * Whether a message from the API says what its labels are. The list endpoint
 * returns them as a list, empty when the message has none, and that is the
 * answer: a label removed on another device or in Thunderbird has to go away
 * here too, rather than come back from the cache. Older servers sent the
 * stored bytes instead (see decodeLabelBuffer), which only decode now and
 * then, so for those an empty result still falls back to the cached labels.
 */
export function hasServerLabels(raw: unknown): boolean {
  return (
    Boolean(raw) && typeof raw === 'object' && Array.isArray((raw as { labels?: unknown }).labels)
  );
}

export function coerceLabelList(value: unknown): string[] {
  const normalizeLabel = (label: unknown) => {
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
  const buffered = decodeLabelBuffer(value);
  if (buffered !== null) return buffered;
  return [];
}

export function hasFromValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface DraftLike {
  to?: unknown[];
  cc?: unknown[];
  bcc?: unknown[];
  subject?: string;
  body?: string;
  from?: string;
  account?: string;
  isPlainText?: boolean;
  attachments?: Array<{
    name?: string;
    filename?: string;
    contentType?: string;
    content?: string;
  }>;
  folder?: string;
  serverId?: string | null;
  replyTo?: string;
  inReplyTo?: string | null;
  references?: string | string[] | null;
}

export function hasMeaningfulDraft(draft: DraftLike): boolean {
  return !!(
    (draft.to && draft.to.length > 0) ||
    (draft.cc && draft.cc.length > 0) ||
    (draft.bcc && draft.bcc.length > 0) ||
    (draft.subject && draft.subject.trim()) ||
    (draft.body && draft.body.trim())
  );
}

export function buildDraftPayload(draft: DraftLike) {
  return {
    from: draft.from || draft.account || '',
    to: draft.to || [],
    cc: draft.cc || [],
    bcc: draft.bcc || [],
    // as draft-service.js sends them, so a draft saved here still answers
    // the message it replies to
    replyTo: draft.replyTo || undefined,
    inReplyTo: draft.inReplyTo || undefined,
    references: draft.references || undefined,
    subject: draft.subject || '',
    html: draft.isPlainText ? undefined : draft.body || '',
    text: draft.isPlainText ? draft.body || '' : undefined,
    attachments: (draft.attachments || []).map((att) => ({
      filename: att.name || att.filename,
      contentType: att.contentType,
      content: att.content,
      encoding: 'base64',
    })),
    has_attachment: Array.isArray(draft.attachments) && draft.attachments.length > 0,
    folder: draft.folder || 'Drafts',
  };
}

export function parseResultList<T = unknown>(
  res:
    | {
        Result?: { List?: T[] } | T[];
      }
    | T[]
    | null
    | undefined,
): T[] {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  const inner = (res as { Result?: { List?: T[] } | T[] }).Result;
  if (Array.isArray(inner)) return inner;
  if (inner && Array.isArray((inner as { List?: T[] }).List)) {
    return (inner as { List: T[] }).List;
  }
  return [];
}

export function isPgpContent(raw: unknown): boolean {
  if (!raw || typeof raw !== 'string') return false;
  if (raw.includes('-----BEGIN PGP MESSAGE-----')) return true;
  if (raw.includes('multipart/encrypted') && raw.includes('application/pgp-encrypted')) {
    return true;
  }
  return false;
}

export interface HeaderLike {
  id?: string;
  has_attachment?: boolean;
}

export interface CachedBodyLike {
  body?: string | null;
  attachments?: unknown[];
  raw?: string | null;
  pgpLocked?: boolean;
  // Set on bodies saved with their attachment list worked out. A message the
  // server flags as having attachments can still have none to list (a
  // signature part, a PGP key): without the mark it was downloaded again on
  // every launch.
  attachmentsResolved?: boolean;
}

// ── Body records on phones ──────────────────────────────────────────────────
// A cached body kept the server's whole response as `meta`: the full raw
// message (every attachment again, base64) and the parsed copy's html, text and
// attachment content, next to the body and the attachments it already holds.
// On a phone that made a body with one photo tens of megabytes, every copy of
// which was opened, cloned and decoded each time it was read. What the reader
// takes from `meta` is the headers; the original message, when asked for, is
// downloaded (viewOriginal, downloadOriginal and the spam report fetch it when
// `rawOmitted` is set).

/** Attachments over this size are not kept in a phone's body cache. */
export const MOBILE_CACHED_ATTACHMENT_MAX_BYTES = 1_000_000;
const MAX_RAW_HEADER_CHARS = 64 * 1024;

/** The header section of a raw RFC822 message */
export function rawHeaderSection(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  const ends = [crlf, lf].filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) : raw.length;
  return raw.slice(0, Math.min(end, MAX_RAW_HEADER_CHARS));
}

/**
 * `meta` for a phone's body cache: the raw message reduced to its headers, and
 * the parsed copy without its body and attachment content.
 */
// Copies of the whole original message, under the names the code reads them by
const RAW_MESSAGE_KEYS = [
  'raw',
  'Raw',
  'eml',
  'rawEml',
  'rawBody',
  'original',
  'originalMessage',
  'rawMessage',
];
// Copies of the body the record already holds
const BODY_COPY_KEYS = ['html', 'Html', 'text', 'Text', 'textAsHtml', 'Plain'];

// Attachment details without their content
function withoutContent(attachments: unknown): unknown {
  if (!Array.isArray(attachments)) return attachments;
  return attachments.map((att) => {
    if (!att || typeof att !== 'object') return att;
    const info = { ...(att as Record<string, unknown>) };
    delete info.content;
    return info;
  });
}

// Without the body copies, and attachments without their content
function withoutBodyCopies(record: Record<string, unknown>): Record<string, unknown> {
  const out = { ...record };
  for (const key of BODY_COPY_KEYS) delete out[key];
  if ('attachments' in out) out.attachments = withoutContent(out.attachments);
  return out;
}

export function slimBodyMeta(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const out = withoutBodyCopies(meta as Record<string, unknown>);
  let source = '';
  for (const key of RAW_MESSAGE_KEYS) {
    if (!(key in out)) continue;
    if (!source && typeof out[key] === 'string') source = out[key] as string;
    delete out[key];
  }
  if (source) {
    out.rawOmitted = true;
    if (!out.rawHeaders) out.rawHeaders = rawHeaderSection(source);
  }
  const parsed = out.nodemailer;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    out.nodemailer = withoutBodyCopies(parsed as Record<string, unknown>);
  }
  return out;
}

interface CachedAttachment {
  href?: string;
  url?: string;
  size?: number;
  disposition?: string;
  contentId?: string;
  needsDownload?: boolean;
  [key: string]: unknown;
}

/**
 * A phone's body cache keeps attachments up to MOBILE_CACHED_ATTACHMENT_MAX_BYTES
 * as data URLs; bigger ones are listed without their content and downloaded
 * when opened (mailService.downloadAttachment falls back to the server).
 * Inline images stay: the body shows them.
 */
export function slimCachedAttachments<T extends CachedAttachment>(
  attachments: T[],
  maxBytes = MOBILE_CACHED_ATTACHMENT_MAX_BYTES,
): T[] {
  if (!Array.isArray(attachments)) return attachments;
  return attachments.map((att) => {
    if (!att || typeof att !== 'object') return att;
    const href = typeof att.href === 'string' ? att.href : '';
    if (!href.startsWith('data:')) return att;
    const inline = att.disposition === 'inline' || Boolean(att.contentId);
    if (inline) return att;
    // Base64 is 4 bytes per 3; the declared size can be missing or wrong
    const bytes = Math.max(Number(att.size) || 0, Math.floor((href.length * 3) / 4));
    if (bytes <= maxBytes) return att;
    const { href: _href, ...rest } = att;
    return { ...rest, needsDownload: true } as T;
  });
}

/**
 * What the body prefetch needs to know about a cached body, without the body.
 * The db worker works this out one record at a time, so deciding what to
 * download never copies hundreds of full bodies (each with its raw message and
 * attachments) between workers.
 */
export interface CachedBodyStatus {
  hasBody: boolean;
  bodyIsPgp: boolean;
  attachmentCount: number;
  attachmentsResolved: boolean;
  pgpLocked: boolean;
  rawIsPgp: boolean;
}

export function cachedBodyStatus(
  record: CachedBodyLike | null | undefined,
): CachedBodyStatus | null {
  if (!record) return null;
  const body = typeof record.body === 'string' ? record.body : '';
  return {
    hasBody: Boolean(body),
    bodyIsPgp: Boolean(body) && isPgpContent(body),
    attachmentCount: Array.isArray(record.attachments) ? record.attachments.length : 0,
    attachmentsResolved: record.attachmentsResolved === true,
    pgpLocked: Boolean(record.pgpLocked),
    rawIsPgp: typeof record.raw === 'string' && isPgpContent(record.raw),
  };
}

function isBodyStatus(value: unknown): value is CachedBodyStatus {
  return Boolean(value) && typeof (value as CachedBodyStatus).hasBody === 'boolean';
}

/** A body cached still PGP-encrypted, waiting for keys that can open it */
export function isPgpLockedStatus(status: CachedBodyStatus | null | undefined): boolean {
  return Boolean(status && !status.hasBody && status.pgpLocked && status.rawIsPgp);
}

/**
 * Determine which messages still need their body fetched.
 * A body is re-fetched if:
 *   - not cached,
 *   - cached body is PGP armored (stale / needs decryption refresh), OR
 *   - message has attachments but none are cached, unless the body was saved
 *     with its attachments already worked out (there were none to list).
 * Takes cached bodies or their statuses (see cachedBodyStatus).
 */
export function worklistFromHeaders<H extends HeaderLike>(
  headers: H[],
  bodies: Array<CachedBodyLike | CachedBodyStatus | null | undefined>,
  maxMessages?: number,
): H[] {
  const worklist: H[] = [];
  const limit = maxMessages ?? headers.length;
  headers.slice(0, limit).forEach((msg, idx) => {
    const entry = bodies[idx];
    const status = isBodyStatus(entry) ? entry : cachedBodyStatus(entry as CachedBodyLike);
    if (!status?.hasBody || status.bodyIsPgp) {
      worklist.push(msg);
      return;
    }
    if (msg?.has_attachment && !status.attachmentCount && !status.attachmentsResolved) {
      worklist.push(msg);
    }
  });
  return worklist;
}

// ── Backfill loop control ──────────────────────────────────────────────────
// The historical-message backfill is a self-re-queuing loop: the worker runs a
// batch and the controller enqueues the next one until the worker says it's
// done. These two pure helpers own the "should we keep going?" decision on each
// side so the loop can always terminate (and so it's unit-testable).

/** Consecutive zero-progress backfill batches the controller will re-queue
 *  before giving up — defence-in-depth against a worker that keeps returning
 *  `{ done: false }` without making progress. */
export const BACKFILL_NO_PROGRESS_CAP = 3;

/**
 * Whether a backfill batch should report itself "done" so the controller stops
 * re-queuing it. A batch that processed zero pages made no progress — its first
 * fetch threw before the network (unconfigured worker / auth / blip) — so
 * re-queuing would just spin a tight, network-less loop. Report done and let the
 * next metadata sync resume from the saved page. A batch is also done once
 * forward+backfill history is exhausted.
 */
export function backfillBatchDone({
  exhausted = false,
  pagesProcessed = 0,
}: { exhausted?: boolean; pagesProcessed?: number } = {}): boolean {
  return Boolean(exhausted) || pagesProcessed === 0;
}

/**
 * Controller-side decision for the next backfill batch. Re-queues only while the
 * worker reports `!done` AND batches keep processing pages; caps consecutive
 * zero-page batches so a worker that wrongly returns `{ done: false }` can't spin
 * the queue forever. NOTE progress is measured by `pagesProcessed`, not
 * `inserted`: a batch can legitimately walk through already-cached pages
 * (inserted: 0) while still moving toward older uncached history.
 */
export function nextBackfillDecision(
  result: { done?: boolean; pagesProcessed?: number } | null | undefined,
  noProgressStreak = 0,
): { requeue: boolean; noProgressStreak: number } {
  if (!result || result.done) return { requeue: false, noProgressStreak: 0 };
  if ((result.pagesProcessed || 0) > 0) return { requeue: true, noProgressStreak: 0 };
  const streak = noProgressStreak + 1;
  if (streak >= BACKFILL_NO_PROGRESS_CAP) return { requeue: false, noProgressStreak: 0 };
  return { requeue: true, noProgressStreak: streak };
}
