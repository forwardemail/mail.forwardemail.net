/**
 * Thread → Prompt Context
 *
 * Formats the currently-selected message + body into an `<email>` block the
 * model can treat as untrusted data. Used by the Ask AI panel when the user
 * has a thread open and wants the AI to act on it (summarize, draft reply).
 *
 * Delimiter discipline comes from `src/ai/prompts/system.ts` — see
 * `wrapEmailContent` there. Combining those delimiters with this formatter
 * is how we resist prompt injection from hostile email content.
 */

import { wrapEmailContent, type AIFeature } from '../prompts/system';
import { renderMarkdownSafe } from '../markdown';

export interface ThreadContextMessage {
  id?: string | null;
  subject?: string | null;
  from?: string | null;
  to?: string | string[] | null;
  cc?: string | string[] | null;
  date?: number | string | null;
  snippet?: string | null;
}

export interface ThreadContextInput {
  message: ThreadContextMessage | null;
  body?: string | null;
}

export interface ThreadContextOutput {
  /** Formatted string to embed in the user message (already wrapped in `<email>`). */
  promptText: string;
  /** Small human-readable label for the context chip ("Alice → you · 2h ago"). */
  chip: string;
  /** True when there is enough context to include. */
  hasContext: boolean;
  /** Bytes in the formatted prompt — used by the ai.worker budget check. */
  approximateBytes: number;
}

const MAX_BODY_CHARS = 12_000;

/**
 * Collapse message HTML into plain text. Intentionally not a full HTML parser —
 * the body will be wrapped in `<email>` delimiters and sent to the model, so
 * overly-clever HTML processing has no user-visible benefit. Strips script /
 * style, converts common block boundaries to spaces, unescapes a few entities.
 */
const htmlToPlainText = (html: string): string =>
  String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|blockquote|pre)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&[#\w]+;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const looksLikeHtml = (s: string): boolean => /<\/?[a-z][^>]*>/i.test(s);

/**
 * Coerce a message address field into an array of strings. The upstream
 * loader may deliver any of:
 *   - `"alice@x.com, bob@x.com"`
 *   - `["alice@x.com", "bob@x.com"]`
 *   - `[{ name: "Alice", address: "alice@x.com" }]`  (object form from parsers)
 *   - `{ name: "Alice", address: "alice@x.com" }`    (single-object form)
 * All branches end up as `string[]` so `extractName` etc. don't explode.
 */
const asArray = (v: unknown): string[] => {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.map(toAddressString).filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = toAddressString(v);
  return single ? [single] : [];
};

const toAddressString = (v: unknown): string => {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') {
    const obj = v as { name?: unknown; address?: unknown; email?: unknown };
    const addr =
      typeof obj.address === 'string'
        ? obj.address
        : typeof obj.email === 'string'
          ? obj.email
          : '';
    const name = typeof obj.name === 'string' ? obj.name : '';
    if (name && addr) return `${name} <${addr}>`;
    return (addr || name).trim();
  }
  return '';
};

const formatDate = (d: number | string | null | undefined): string => {
  if (d === null || d === undefined) return '';
  const ms = typeof d === 'number' ? d : Date.parse(d);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
};

const extractName = (address: unknown): string => {
  const str = toAddressString(address);
  if (!str) return 'unknown';
  const m = str.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return (m?.[1] ?? str).trim();
};

export const buildThreadContext = (
  feature: AIFeature,
  input: ThreadContextInput,
): ThreadContextOutput => {
  const { message, body } = input;
  if (!message) {
    return { promptText: '', chip: '', hasContext: false, approximateBytes: 0 };
  }

  const fromName = message.from ? extractName(String(message.from)) : 'unknown sender';
  const toArr = asArray(message.to);
  const ccArr = asArray(message.cc);
  const subject = (message.subject || '(no subject)').trim();
  const date = formatDate(message.date);

  let plain = '';
  if (body && body.length > 0) {
    plain = looksLikeHtml(body) ? htmlToPlainText(body) : body.trim();
  } else if (message.snippet) {
    plain = message.snippet.trim();
  }

  let truncated = false;
  if (plain.length > MAX_BODY_CHARS) {
    plain = plain.slice(0, MAX_BODY_CHARS);
    truncated = true;
  }

  const header: string[] = [];
  header.push(`Subject: ${subject}`);
  header.push(`From: ${message.from ?? 'unknown'}`);
  if (toArr.length) header.push(`To: ${toArr.join(', ')}`);
  if (ccArr.length) header.push(`Cc: ${ccArr.join(', ')}`);
  if (date) header.push(`Date: ${date}`);

  const bodySection = plain
    ? `\n\n${plain}${truncated ? '\n\n[…message truncated…]' : ''}`
    : '\n\n(no body available)';

  const content = header.join('\n') + bodySection;
  const promptText = wrapEmailContent(feature, content);

  const chip = buildChip(fromName, toArr, date);

  return {
    promptText,
    chip,
    hasContext: true,
    approximateBytes: promptText.length,
  };
};

const buildChip = (fromName: string, toArr: string[], dateIso: string): string => {
  const parts: string[] = [];
  parts.push(fromName);
  if (toArr.length)
    parts.push(`→ ${toArr.length === 1 ? extractName(toArr[0]) : `${toArr.length} recipients`}`);
  if (dateIso) parts.push(`· ${formatRelative(Date.parse(dateIso))}`);
  return parts.join(' ');
};

const formatRelative = (ms: number): string => {
  if (!Number.isFinite(ms)) return '';
  const delta = Date.now() - ms;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
};

export interface FullThreadInput {
  messages: Array<{ message: ThreadContextMessage; body?: string | null }>;
  truncated?: boolean;
  totalAvailable?: number;
}

/**
 * Format an entire thread (multiple messages) into a single prompt block. Each
 * message is wrapped in its own `<email>` delimiter so the model knows where
 * one ends and the next begins; all are wrapped in an outer `<thread>` block
 * so the model can reason about conversation order.
 *
 * When `truncated` is true, a marker is prepended telling the model earlier
 * messages exist but were dropped to fit the context budget. The chip
 * summarizes "N messages · oldest to newest".
 */
export const buildFullThreadContext = (
  feature: AIFeature,
  input: FullThreadInput,
): ThreadContextOutput => {
  if (!input.messages.length) {
    return { promptText: '', chip: '', hasContext: false, approximateBytes: 0 };
  }

  const blocks: string[] = [];
  if (input.truncated) {
    const dropped = (input.totalAvailable ?? 0) - input.messages.length;
    blocks.push(
      `[…${dropped > 0 ? `${dropped} older messages` : 'older messages'} omitted to fit context budget. Use search tools to retrieve them if needed.]`,
    );
  }

  input.messages.forEach(({ message, body }, index) => {
    const header: string[] = [];
    header.push(`Subject: ${(message.subject || '(no subject)').trim()}`);
    header.push(`From: ${message.from ?? 'unknown'}`);
    const toArr = asArray(message.to);
    if (toArr.length) header.push(`To: ${toArr.join(', ')}`);
    const ccArr = asArray(message.cc);
    if (ccArr.length) header.push(`Cc: ${ccArr.join(', ')}`);
    const date = formatDate(message.date);
    if (date) header.push(`Date: ${date}`);

    let plain = '';
    if (body && body.length > 0) {
      plain = looksLikeHtml(body) ? htmlToPlainText(body) : body.trim();
    } else if (message.snippet) {
      plain = message.snippet.trim();
    }
    let truncated = false;
    if (plain.length > MAX_BODY_CHARS) {
      plain = plain.slice(0, MAX_BODY_CHARS);
      truncated = true;
    }

    const msgContent =
      header.join('\n') +
      (plain
        ? `\n\n${plain}${truncated ? '\n\n[…message truncated…]' : ''}`
        : '\n\n(no body available)');

    blocks.push(
      `Message ${index + 1} of ${input.messages.length}:\n${wrapEmailContent(feature, msgContent)}`,
    );
  });

  const content = blocks.join('\n\n');
  const promptText = `<thread>\n${content}\n</thread>`;

  const firstFrom = input.messages[0]?.message.from
    ? extractName(String(input.messages[0].message.from))
    : 'unknown';
  const latest = input.messages[input.messages.length - 1]?.message;
  const relative = latest?.date ? formatRelative(Date.parse(formatDate(latest.date))) : '';
  const chipSuffix = input.truncated
    ? ` (${input.messages.length} of ${input.totalAvailable ?? '?'})`
    : ` (${input.messages.length})`;
  const chip = [firstFrom, '→ thread', chipSuffix.trim(), relative && `· ${relative}`]
    .filter(Boolean)
    .join(' ');

  return { promptText, chip, hasContext: true, approximateBytes: promptText.length };
};

export interface ReplyPrefill {
  to: string[];
  subject: string;
  inReplyTo?: string;
  references?: string;
  /** Cleaned markdown draft — fine for plain-text composers. */
  body: string;
  /** Rendered HTML for TipTap so lists, bold, etc. survive the handoff. */
  html: string;
}

// "Here is/Here's [a|the|my|...] draft/reply/suggested/proposed …:"
const DRAFT_PREAMBLE_RE =
  /^\s*here(?:['’]s|\s+is)\s+(?:a|an|the|my|your)?\s*(?:draft|reply|suggested|proposed)\b[^:\n]*:\s*/i;
// Markdown horizontal rule at start/end. Requires whitespace (or EOS) after
// the rule so `___emphasis` and similar tokens at the start of real content
// aren't accidentally treated as a rule.
const LEADING_HR_RE = /^\s*(?:[-*_][ \t]*){3,}(?:\s+|$)/;
const TRAILING_HR_RE = /(?:^|\s)(?:[-*_][ \t]*){3,}\s*$/;

/**
 * Strip meta-commentary Claude sometimes prepends to draft output despite the
 * system prompt asking for the body alone — e.g. "Here is a draft reply body:"
 * followed by a `---` separator. Without this the preamble ends up in the
 * user's actual email when they hit "Open as draft".
 */
export const cleanDraftOutput = (raw: string): string => {
  if (!raw) return '';
  let out = raw.trim();
  // Apply repeatedly — occasionally Claude stacks "Here's a draft reply:\n---\n"
  // and the HR is exposed only after the preamble is removed.
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out.replace(DRAFT_PREAMBLE_RE, '').trim();
    out = out.replace(LEADING_HR_RE, '').trim();
    out = out.replace(TRAILING_HR_RE, '').trim();
    if (out === before) break;
  }
  return out;
};

/**
 * Build a Compose prefill from the selected message and an AI-drafted body.
 * The subject is prefixed with `Re:` if not already; recipients default to the
 * original sender (reply-to-author semantics, not reply-all — keep it explicit).
 */
export const buildReplyPrefill = (
  message: ThreadContextMessage | null,
  draft: string,
): ReplyPrefill => {
  const subject = message?.subject?.trim() ?? '';
  const prefixed = /^re:/i.test(subject) ? subject : subject ? `Re: ${subject}` : 'Re:';
  const to = message?.from ? [String(message.from)] : [];
  const inReplyTo = (message as { message_id?: string } | null)?.message_id;
  const cleaned = cleanDraftOutput(draft);
  return {
    to,
    subject: prefixed,
    inReplyTo,
    body: cleaned,
    html: renderMarkdownSafe(cleaned),
  };
};
