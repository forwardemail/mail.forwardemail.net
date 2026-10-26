import { dedupeAddresses } from './address';

/**
 * Percent-decode a single value per RFC 3986 / RFC 6068.
 *
 * Unlike application/x-www-form-urlencoded (used by URLSearchParams),
 * RFC 6068 treats `+` as a **literal** plus sign — only `%20` represents
 * a space.  We therefore use `decodeURIComponent` directly without any
 * `+`-to-space substitution.
 */
const decodeRfc6068 = (value = '') => {
  if (!value) return '';
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
};

/**
 * Header-bound values (addresses, subject, reply-to) must stay on one line: a
 * percent-encoded CR/LF (`%0D%0A`) would otherwise reach the raw PGP/MIME
 * headers and add a hidden Bcc or any other header. The body keeps its lines.
 */
// eslint-disable-next-line no-control-regex
const stripControls = (value = '') => String(value).replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ');

/** A single RFC 5322 msg-id such as `<abc@example.com>`, or ''. */
const toMsgId = (value = '') => {
  const trimmed = String(value).trim();
  // eslint-disable-next-line no-control-regex
  return /^<[^<>\s\u0000-\u001F\u007F-\u009F]+>$/.test(trimmed) ? trimmed : '';
};

/**
 * Split a comma- or semicolon-separated address list and percent-decode
 * each entry.  Per RFC 6068 §2, multiple addresses in the `to` header
 * (or the path portion) are separated by commas.
 */
const splitAddressList = (value = '') =>
  stripControls(decodeRfc6068(value))
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Parse the query component of a mailto URI per RFC 6068 §2.
 *
 * RFC 6068 uses standard percent-encoding (RFC 3986), **not**
 * application/x-www-form-urlencoded.  `URLSearchParams` must not be used
 * here because it converts `+` to spaces, which violates the RFC.
 *
 * Returns an array of `[key, value]` pairs (keys lowercased).
 */
const parseMailtoQuery = (queryPart = '') => {
  const pairs = [];
  if (!queryPart) return pairs;
  for (const segment of queryPart.split('&')) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx === -1) continue;
    const key = decodeRfc6068(segment.slice(0, eqIdx)).toLowerCase();
    const value = decodeRfc6068(segment.slice(eqIdx + 1));
    pairs.push([key, value]);
  }
  return pairs;
};

export const parseMailto = (input = '') => {
  const result = {
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: '',
    replyTo: '',
    inReplyTo: '',
    raw: input || '',
    // (keys come from the link: "__proto__" or "constructor" must not reach
    // Object.prototype)
    other: Object.create(null),
  };

  if (!input) return result;
  const raw = String(input).trim();
  const normalized = raw.toLowerCase().startsWith('mailto:') ? raw.slice(7) : raw;

  const queryIndex = normalized.indexOf('?');
  const addressPart = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? '' : normalized.slice(queryIndex + 1);

  if (addressPart) {
    result.to.push(...splitAddressList(addressPart));
  }

  for (const [key, value] of parseMailtoQuery(queryPart)) {
    if (key === 'to') {
      result.to.push(...splitAddressList(value));
    } else if (key === 'cc') {
      result.cc.push(...splitAddressList(value));
    } else if (key === 'bcc') {
      result.bcc.push(...splitAddressList(value));
    } else if (key === 'subject') {
      result.subject = result.subject || stripControls(value).trim();
    } else if (key === 'body') {
      result.body = result.body ? `${result.body}\n${value}` : value;
    } else if (key === 'reply-to' || key === 'replyto') {
      result.replyTo = result.replyTo || stripControls(value).trim();
    } else if (key === 'in-reply-to' || key === 'inreplyto') {
      result.inReplyTo = result.inReplyTo || toMsgId(value);
    } else {
      if (!result.other[key]) result.other[key] = [];
      result.other[key].push(value);
    }
  }

  result.to = dedupeAddresses(result.to);
  result.cc = dedupeAddresses(result.cc);
  result.bcc = dedupeAddresses(result.bcc);

  return result;
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * RFC 6068 bodies are plain text. Compose treats `body` as editor HTML, so a
 * link such as `mailto:x@y?body=<a href=...>` used to arrive as live markup.
 * Escape it and keep the line structure as paragraphs and line breaks.
 */
export const mailtoBodyToHtml = (text = '') => {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return '';
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
};

export const mailtoToPrefill = (parsed = {}) => {
  const text = parsed.body || '';
  return {
    to: parsed.to || [],
    cc: parsed.cc || [],
    bcc: parsed.bcc || [],
    subject: parsed.subject || '',
    text,
    body: mailtoBodyToHtml(text),
    replyTo: parsed.replyTo || '',
    inReplyTo: parsed.inReplyTo || '',
    mailto: parsed,
  };
};

/**
 * Compose prefill for text shared from another app (Android ACTION_SEND).
 * Any app can send it, and the text is plain text like a mailto body, so it is
 * escaped the same way instead of being parsed as editor HTML.
 */
export const shareToPrefill = (data = {}) => {
  const text = typeof data?.text === 'string' ? data.text : '';
  const subject = typeof data?.subject === 'string' ? stripControls(data.subject).trim() : '';
  return { subject, text, body: mailtoBodyToHtml(text) };
};
