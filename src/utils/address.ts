/*
 * Email address parsing and formatting utilities
 */

import { decodeMimeHeader } from './mime-utils.js';

const decodeDisplayText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return decodeMimeHeader(value).trim();
};

export interface AddressObject {
  name?: string;
  Name?: string;
  address?: string;
  Address?: string;
  email?: string;
  Email?: string;
  display?: string;
  Display?: string;
  text?: string;
  Text?: string;
  value?: string | AddressObject | AddressObject[];
}

export interface MessageHeaders {
  from?: string | AddressObject | AddressObject[];
  From?: string | AddressObject | AddressObject[];
  to?: string | AddressObject | AddressObject[];
  To?: string | AddressObject | AddressObject[];
  cc?: string | AddressObject | AddressObject[];
  Cc?: string | AddressObject | AddressObject[];
  bcc?: string | AddressObject | AddressObject[];
  Bcc?: string | AddressObject | AddressObject[];
  replyTo?: string | AddressObject | AddressObject[];
  reply_to?: string | AddressObject | AddressObject[];
  'reply-to'?: string | AddressObject | AddressObject[];
  [key: string]: unknown;
}

export interface MessageWithHeaders {
  nodemailer?: {
    from?: AddressObject | { value: AddressObject[]; text?: string };
    to?: AddressObject | { value: AddressObject[]; text?: string };
    cc?: AddressObject | { value: AddressObject[]; text?: string };
    bcc?: AddressObject | { value: AddressObject[]; text?: string };
    headers?: Record<string, string>;
    headerLines?: Array<{ key?: string; line?: string }>;
    envelope?: { from?: string; to?: string[] };
    [key: string]: unknown;
  };
  headers?: Record<string, string> | string;
  header?: Record<string, string>;
  headerLines?: Array<{ key?: string; line?: string }>;
  envelope?: { from?: string; to?: string[] };
  raw?: string;
  [key: string]: unknown;
}

type AddressInput = string | AddressObject | AddressObject[] | null | undefined;

/**
 * Split a comma-separated address string into individual addresses,
 * respecting quoted strings and angle brackets.
 * e.g. "jake@x.com, Vicky <vicky@x.com>" → ["jake@x.com", "Vicky <vicky@x.com>"]
 */
const splitAddressString = (str: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && str[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (!inQuotes && ch === '<') {
      inAngle++;
      current += ch;
    } else if (!inQuotes && ch === '>' && inAngle > 0) {
      inAngle--;
      current += ch;
    } else if (!inQuotes && inAngle === 0 && ch === ',') {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
};

export const recipientsToList = (value: AddressInput): (string | AddressObject)[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.includes(',')) {
    return splitAddressString(value).filter(Boolean);
  }
  return [value].filter(Boolean);
};

export const extractAddressList = (
  msg: MessageWithHeaders | null | undefined,
  field: string,
): (string | AddressObject)[] => {
  if (!msg) return [];
  const escapeRegExp = (value: string): string =>
    String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const findHeaderValue = (
    headers: Record<string, string> | string | undefined,
    headerField: string,
  ): string => {
    if (!headers) return '';
    if (typeof headers === 'string') {
      const match = headers.match(
        new RegExp(`^${escapeRegExp(headerField)}:\\s*([^\\r\\n]*(?:\\r?\\n[\\t ].*)*)`, 'im'),
      );
      if (!match) return '';
      return match[1].replace(/\r?\n[\t ]+/g, ' ').trim();
    }
    if (typeof headers === 'object') {
      if (headers[headerField]) return headers[headerField];
      const lower = headerField.toLowerCase();
      if (headers[lower]) return headers[lower];
      const matchKey = Object.keys(headers).find((key) => key.toLowerCase() === lower);
      return matchKey ? headers[matchKey] : '';
    }
    return '';
  };

  const findHeaderLineValue = (
    lines: Array<{ key?: string; line?: string }> | undefined,
    headerField: string,
  ): string => {
    if (!Array.isArray(lines)) return '';
    const lower = headerField.toLowerCase();
    const matched = lines.find((line) => {
      const key = String(line?.key || '').toLowerCase();
      if (key) return key === lower;
      const lineText = String(line?.line || '').toLowerCase();
      return lineText.startsWith(`${lower}:`);
    });
    if (!matched?.line) return '';
    return String(matched.line)
      .replace(new RegExp(`^${escapeRegExp(headerField)}:\\s*`, 'i'), '')
      .trim();
  };

  const normalizeHeaderValue = (value: unknown): (string | AddressObject)[] => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object' && value !== null) {
      const obj = value as AddressObject;
      if (Array.isArray(obj.value) && obj.value.length) return obj.value as AddressObject[];
      if (obj.text || obj.Text) return [obj.text || obj.Text] as string[];
      if (
        obj.name ||
        obj.Name ||
        obj.address ||
        obj.Address ||
        obj.email ||
        obj.Email ||
        obj.Display
      ) {
        return [obj];
      }
      if (typeof obj.value === 'string' && obj.value.trim()) return [obj.value];
    }
    return recipientsToList(value as AddressInput);
  };

  const nmVal = msg?.nodemailer?.[field] as AddressObject | undefined;
  if (nmVal) {
    if (
      Array.isArray((nmVal as { value?: AddressObject[] }).value) &&
      (nmVal as { value?: AddressObject[] }).value!.length
    ) {
      return (nmVal as { value: AddressObject[] }).value;
    }
    if (
      typeof (nmVal as { text?: string }).text === 'string' &&
      (nmVal as { text?: string }).text!.trim()
    ) {
      return [(nmVal as { text: string }).text];
    }
    // nmVal is a plain AddressObject ({ name, address } / { Name, Address } /
    // { email } / etc.) — no value[] or text string. Normalize it directly
    // instead of falling through to header lookup, which can fail on messages
    // whose structured headers weren't populated server-side.
    const normalized = normalizeHeaderValue(nmVal);
    if (normalized.length) return normalized;
  }

  const headerField = field === 'replyTo' || field === 'reply_to' ? 'reply-to' : field;
  const headerValue =
    findHeaderValue(msg?.nodemailer?.headers, headerField) ||
    findHeaderValue(msg?.headers as Record<string, string> | string | undefined, headerField) ||
    findHeaderValue(msg?.header, headerField);
  if (headerValue) {
    const normalized = normalizeHeaderValue(headerValue);
    if (normalized.length) return normalized;
  }

  const headerLineValue =
    findHeaderLineValue(msg?.nodemailer?.headerLines, headerField) ||
    findHeaderLineValue(msg?.headerLines, headerField);
  if (headerLineValue) {
    const normalized = normalizeHeaderValue(headerLineValue);
    if (normalized.length) return normalized;
  }

  const rawHeaderValue = findHeaderValue(msg?.raw, headerField);
  if (rawHeaderValue) {
    const normalized = normalizeHeaderValue(rawHeaderValue);
    if (normalized.length) return normalized;
  }

  const env = msg?.nodemailer?.envelope;
  if (env) {
    if (field === 'from' && env.from) return [env.from];
    if ((field === 'to' || field === 'recipients') && Array.isArray(env.to)) return env.to;
  }

  const bareEnv = msg?.envelope;
  if (bareEnv) {
    if (field === 'from' && bareEnv.from) return [bareEnv.from];
    if ((field === 'to' || field === 'recipients') && Array.isArray(bareEnv.to)) return bareEnv.to;
  }

  const altField = field ? `${field[0].toUpperCase()}${field.slice(1)}` : field;
  const upperField = field ? field.toUpperCase() : field;
  const directValue =
    msg?.[field] ??
    (altField ? msg?.[altField] : undefined) ??
    (upperField ? msg?.[upperField] : undefined);
  if (directValue) return normalizeHeaderValue(directValue);

  const alt = msg?.[`${field}_address`];
  if (Array.isArray(alt)) return alt as (string | AddressObject)[];
  if (alt) return recipientsToList(alt as AddressInput);
  if (msg?.[field]) return recipientsToList(msg[field] as AddressInput);
  return [];
};

export const getReplyToList = (
  msg: MessageWithHeaders | null | undefined,
): (string | AddressObject)[] => {
  const replyTo = extractAddressList(msg, 'replyTo');
  if (replyTo.length) return replyTo;
  return extractAddressList(msg, 'reply_to');
};

export const toDisplayAddress = (addr: AddressInput): string => {
  if (!addr) return '';
  if (typeof addr === 'string') return decodeDisplayText(addr);
  if (Array.isArray(addr)) {
    if (addr[0]) return toDisplayAddress(addr[0]);
    return '';
  }
  const obj = addr as AddressObject;
  if (Array.isArray(obj.value) && obj.value[0])
    return toDisplayAddress(obj.value[0] as AddressObject);
  const name = decodeDisplayText(obj.name || obj.Name || obj.display || obj.Display || '');
  const address = obj.address || obj.Address || obj.email || obj.Email || '';
  if (name && address) {
    return `${name} <${address}>`;
  }
  if (name) return name;
  if (address) return address;
  if (typeof obj.value === 'string') return decodeDisplayText(obj.value);
  return decodeDisplayText(
    obj.address || obj.email || (typeof obj.value === 'string' ? obj.value : '') || obj.text || '',
  );
};

export const displayAddresses = (list: (string | AddressObject)[] | null | undefined): string[] =>
  (list || []).map((addr) => toDisplayAddress(addr)).filter(Boolean);

export const extractEmail = (address: AddressInput): string => {
  if (!address) return '';
  if (Array.isArray(address)) {
    for (const item of address) {
      const extracted = extractEmail(item);
      if (extracted) return extracted;
    }
    return '';
  }
  if (typeof address === 'object') {
    const obj = address as AddressObject;
    if (Array.isArray(obj.value) && obj.value[0]) {
      return extractEmail(obj.value[0] as AddressObject);
    }
  }
  return normalizeEmail(address);
};

export const normalizeEmail = (value: AddressInput = ''): string => {
  if (!value) return '';
  let raw: string = '';
  if (Array.isArray(value)) {
    return normalizeEmail(value[0] || '');
  }
  if (typeof value === 'object') {
    const obj = value as AddressObject;
    raw =
      obj.email ||
      obj.Email ||
      obj.address ||
      obj.Address ||
      (typeof obj.value === 'string' ? obj.value : '') ||
      '';
  } else {
    raw = value;
  }
  if (typeof raw !== 'string') return '';
  const match = raw.match(/<([^>]+)>/);
  const email = (match ? match[1] : raw).trim().toLowerCase();
  return email;
};

export const dedupeAddresses = (list: (string | AddressObject)[] = []): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  list.forEach((addr) => {
    const display = toDisplayAddress(addr);
    const norm = normalizeEmail(addr);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(display || norm);
    }
  });
  return out;
};

/**
 * Extract display name from email address
 * - "Shaun Warman" <shaunw.dev@gmail.com> -> "Shaun Warman"
 * - <shaunw.dev@gmail.com> -> "shaunw.dev@gmail.com"
 * - shaunw.dev@gmail.com -> "shaunw.dev@gmail.com"
 */
export const extractDisplayName = (from: AddressInput): string => {
  const normalizeFrom = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return decodeDisplayText(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = normalizeFrom(item);
        if (candidate) return candidate;
      }
      return '';
    }
    if (typeof value === 'object' && value !== null) {
      const obj = value as AddressObject;
      if (obj.Display) {
        const display = decodeDisplayText(obj.Display);
        return obj.Email ? `${display} <${obj.Email}>` : display;
      }
      if (obj.Name || obj.Address || obj.Email) {
        const name = decodeDisplayText(obj.Name || '');
        const address = obj.Address || obj.Email || '';
        if (name && address) return `${name} <${address}>`;
        return name || address || '';
      }
      if (obj.text) return decodeDisplayText(obj.text);
      if (Array.isArray(obj.value) && obj.value[0]) {
        return normalizeFrom(obj.value[0]);
      }
      if (obj.name || obj.address || obj.email || obj.Name || obj.Address || obj.Email) {
        const name = decodeDisplayText(obj.name || obj.Name || '');
        const address = obj.address || obj.Address || obj.email || obj.Email || '';
        if (name && address) {
          return `${name} <${address}>`;
        }
        return name || address || '';
      }
      if (typeof obj.value === 'string') return decodeDisplayText(obj.value);
    }
    return '';
  };

  const raw = normalizeFrom(from);
  if (!raw || typeof raw !== 'string') {
    return 'Unknown sender';
  }

  // Match pattern: "Name" <email> or Name <email>
  const match = raw.match(/^["']?([^"'<]+)["']?\s*<(.+)>$/);

  if (match) {
    const name = match[1].trim();
    const email = match[2].trim();

    // If name exists and is not empty, use it
    if (name && name.length > 0) {
      return name;
    }

    // Otherwise use email
    return email;
  }

  // No angle brackets, just return as-is (likely just an email)
  return raw.trim();
};

/**
 * Validate email address format
 * Basic validation - checks for user@domain.tld pattern
 */
export const isValidEmail = (email: string): boolean => {
  if (!email || typeof email !== 'string') return false;
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  // Basic email regex - allows standard email formats
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(normalized);
};
