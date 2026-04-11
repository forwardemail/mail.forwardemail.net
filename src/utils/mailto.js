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
 * Split a comma- or semicolon-separated address list and percent-decode
 * each entry.  Per RFC 6068 §2, multiple addresses in the `to` header
 * (or the path portion) are separated by commas.
 */
const splitAddressList = (value = '') =>
  decodeRfc6068(value)
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
    other: {},
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
      result.subject = result.subject || value;
    } else if (key === 'body') {
      result.body = result.body ? `${result.body}\n${value}` : value;
    } else if (key === 'reply-to' || key === 'replyto') {
      result.replyTo = result.replyTo || value;
    } else if (key === 'in-reply-to' || key === 'inreplyto') {
      result.inReplyTo = result.inReplyTo || value;
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

export const mailtoToPrefill = (parsed = {}) => {
  const body = parsed.body || '';
  return {
    to: parsed.to || [],
    cc: parsed.cc || [],
    bcc: parsed.bcc || [],
    subject: parsed.subject || '',
    text: body,
    body,
    replyTo: parsed.replyTo || '',
    inReplyTo: parsed.inReplyTo || '',
    mailto: parsed,
  };
};
