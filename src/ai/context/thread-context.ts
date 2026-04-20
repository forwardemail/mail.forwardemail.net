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

const asArray = (v: string | string[] | null | undefined): string[] => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
};

const formatDate = (d: number | string | null | undefined): string => {
  if (d === null || d === undefined) return '';
  const ms = typeof d === 'number' ? d : Date.parse(d);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
};

const extractName = (address: string): string => {
  const m = address.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return (m?.[1] ?? address).trim();
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

export interface ReplyPrefill {
  to: string[];
  subject: string;
  inReplyTo?: string;
  references?: string;
  body: string;
}

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
  return {
    to,
    subject: prefixed,
    inReplyTo,
    body: draft,
  };
};
