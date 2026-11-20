/**
 * Turning what an IMAP server returns into the records the rest of the app
 * already reads. These are the same field names the Forward Email API uses,
 * so every row goes through normalizeMessageForCache like any other.
 */

import PostalMime from 'postal-mime';
import type { ServerRecord } from './types';

export interface ImapMessageRef {
  uidValidity: number;
  uid: number;
  folder: string;
}

const toBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string): string => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
};

/**
 * A message's id: folder, the folder's UIDVALIDITY and the UID. IMAP has no
 * other stable name for a message. It changes when the message moves. The
 * folder is encoded so the id is safe in a URL and in an element id.
 */
export function imapMessageId({ uidValidity, uid, folder }: ImapMessageRef): string {
  return `imap-${uidValidity}-${uid}-${toBase64Url(folder)}`;
}

export function parseImapMessageId(id: unknown): ImapMessageRef | null {
  const match = /^imap-(\d+)-(\d+)-([A-Za-z0-9_-]*)$/.exec(String(id ?? ''));
  if (!match) return null;
  const uidValidity = Number(match[1]);
  const uid = Number(match[2]);
  if (!Number.isSafeInteger(uidValidity) || !Number.isSafeInteger(uid) || uid < 1) return null;
  try {
    return { uidValidity, uid, folder: fromBase64Url(match[3]) };
  } catch {
    return null;
  }
}

export const base64ToBytes = (text: string): Uint8Array =>
  Uint8Array.from(atob(text || ''), (c) => c.charCodeAt(0));

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface ParsedAddress {
  name?: string;
  address?: string;
  group?: ParsedAddress[];
}

/** Addresses in the shape the API returns them: a list and its display text. */
function addressField(input: ParsedAddress | ParsedAddress[] | undefined) {
  const flat: Array<{ name: string; address: string }> = [];
  const add = (entry: ParsedAddress | undefined) => {
    if (!entry) return;
    if (Array.isArray(entry.group)) {
      entry.group.forEach(add);
      return;
    }
    if (entry.address) flat.push({ name: entry.name || '', address: entry.address });
  };
  (Array.isArray(input) ? input : [input]).forEach(add);
  if (!flat.length) return undefined;
  return {
    value: flat,
    text: flat.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
  };
}

export interface ParsedHeader {
  subject: string;
  from?: ReturnType<typeof addressField>;
  to?: ReturnType<typeof addressField>;
  cc?: ReturnType<typeof addressField>;
  bcc?: ReturnType<typeof addressField>;
  replyTo?: ReturnType<typeof addressField>;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  date: string | null;
  /** Header name (lower case) to its value. A repeated header keeps its first value. */
  headers: Record<string, string>;
}

/** Parse a header block with the parser that also reads message bodies. */
export async function parseHeaderBlock(bytes: Uint8Array): Promise<ParsedHeader> {
  const mail = await new PostalMime().parse(bytes);
  const headers: Record<string, string> = {};
  for (const header of mail.headers || []) {
    const key = String(header.key || '').toLowerCase();
    if (key && !(key in headers)) headers[key] = String(header.value ?? '');
  }
  return {
    subject: mail.subject || '',
    from: addressField(mail.from as ParsedAddress),
    to: addressField(mail.to as ParsedAddress[]),
    cc: addressField(mail.cc as ParsedAddress[]),
    bcc: addressField(mail.bcc as ParsedAddress[]),
    replyTo: addressField(mail.replyTo as ParsedAddress[]),
    messageId: mail.messageId || null,
    inReplyTo: mail.inReplyTo || null,
    references: mail.references || null,
    date: mail.date || null,
    headers,
  };
}

/**
 * A raw message's header block: everything up to and including its first
 * blank line. The parser needs the blank line to know the headers ended.
 */
export function headerBytes(raw: Uint8Array): Uint8Array {
  for (let i = 0; i + 1 < raw.length; i += 1) {
    if (raw[i] !== 0x0a) continue;
    if (raw[i + 1] === 0x0a) return raw.subarray(0, i + 2);
    if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a) return raw.subarray(0, i + 3);
  }
  return raw;
}

export interface EngineRow {
  uid: number;
  flags: string[];
  size?: number | null;
  internalDate?: string | null;
  header: string;
}

/** Keywords are the labels. System flags start with a backslash. */
export const keywordsOf = (flags: string[]): string[] =>
  flags.filter((flag) => flag && !flag.startsWith('\\'));

/**
 * A multipart/mixed message nearly always carries an attachment. The exact
 * answer needs the message's structure, which the list does not fetch.
 */
const looksLikeAttachment = (contentType: string | undefined): boolean =>
  /^\s*multipart\/mixed\b/i.test(contentType || '');

export async function rowToRecord(
  row: EngineRow,
  folder: string,
  uidValidity: number,
): Promise<ServerRecord> {
  const parsed = await parseHeaderBlock(base64ToBytes(row.header));
  const flags = Array.isArray(row.flags) ? row.flags : [];
  return {
    id: imapMessageId({ uidValidity, uid: row.uid, folder }),
    uid: row.uid,
    folder,
    flags,
    labels: keywordsOf(flags),
    internal_date: row.internalDate || undefined,
    header_date: parsed.date || undefined,
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    replyTo: parsed.replyTo,
    header_message_id: parsed.messageId,
    in_reply_to: parsed.inReplyTo,
    references: parsed.references,
    has_attachment: looksLikeAttachment(parsed.headers['content-type']),
    size: row.size ?? undefined,
  };
}

/** The metadata block the reader expects next to a message's source. */
export function metaFromHeader(parsed: ParsedHeader): ServerRecord {
  return {
    headers: parsed.headers,
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    replyTo: parsed.replyTo,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    date: parsed.date,
  };
}

export interface EngineFolder {
  path: string;
  delimiter?: string | null;
  specialUse?: string | null;
  selectable: boolean;
  total?: number | null;
  unseen?: number | null;
  uidValidity?: number | null;
  uidNext?: number | null;
}

const SPECIAL_USE: Record<string, string> = {
  sent: '\\Sent',
  trash: '\\Trash',
  drafts: '\\Drafts',
  junk: '\\Junk',
  archive: '\\Archive',
  all: '\\All',
  flagged: '\\Flagged',
};

/**
 * The app shows folder paths with "/" between levels. A server that uses
 * another separator (often ".") has its paths shown with "/" and turned back
 * before a command is sent.
 */
export const toClientPath = (serverPath: string, delimiter: string): string =>
  delimiter && delimiter !== '/' ? serverPath.split(delimiter).join('/') : serverPath;

export const toServerPath = (clientPath: string, delimiter: string): string =>
  delimiter && delimiter !== '/' ? clientPath.split('/').join(delimiter) : clientPath;

export function folderToRecord(folder: EngineFolder): ServerRecord {
  const delimiter = folder.delimiter || '/';
  const path = toClientPath(folder.path, delimiter);
  // INBOX is the one name IMAP treats without regard to case.
  const shown = path.toUpperCase() === 'INBOX' ? 'INBOX' : path;
  return {
    // IMAP names a folder by its path and nothing else.
    id: shown,
    path: shown,
    name: shown.split('/').pop() || shown,
    ...(folder.specialUse && SPECIAL_USE[folder.specialUse]
      ? { specialUse: SPECIAL_USE[folder.specialUse] }
      : {}),
    ...(typeof folder.total === 'number' ? { total: folder.total } : {}),
    ...(typeof folder.unseen === 'number' ? { unseen_count: folder.unseen } : {}),
    ...(typeof folder.uidValidity === 'number' ? { uid_validity: folder.uidValidity } : {}),
    ...(typeof folder.uidNext === 'number' ? { uid_next: folder.uidNext } : {}),
  };
}

/**
 * What the mail engine puts in place of a part it did not download
 * (MARKER in src-tauri/src/mail/lean.rs): the part's section number, its
 * size on the server and its transfer encoding.
 */
export interface LeanPart {
  section: string;
  size: number;
  encoding: string;
}

const LEAN_MARKER = /^fe-part-not-downloaded (\d+(?:\.\d+)*) (\d+) ([a-z0-9-]+)\s*$/;

/** Reads the marker out of an attachment's content, or null for a real attachment. */
export function leanPartOf(content: unknown): LeanPart | null {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
    const bytes =
      content instanceof ArrayBuffer
        ? new Uint8Array(content)
        : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    // A real attachment is rarely this short, and never needs decoding to tell.
    if (bytes.byteLength > 120) return null;
    text = new TextDecoder().decode(bytes);
  }
  if (!text || text.length > 120) return null;
  const match = LEAN_MARKER.exec(text);
  return match ? { section: match[1], size: Number(match[2]), encoding: match[3] } : null;
}

function decodeQuotedPrintable(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  const hex = (c: number) =>
    c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte !== 61 /* = */) {
      out[n++] = byte;
      continue;
    }
    // "=" at the end of a line joins it to the next one.
    if (bytes[i + 1] === 13 && bytes[i + 2] === 10) {
      i += 2;
      continue;
    }
    if (bytes[i + 1] === 10) {
      i += 1;
      continue;
    }
    const high = hex(bytes[i + 1]);
    const low = hex(bytes[i + 2]);
    if (high >= 0 && low >= 0) {
      out[n++] = high * 16 + low;
      i += 2;
    } else {
      out[n++] = byte;
    }
  }
  return out.subarray(0, n);
}

/** A part as the server holds it, turned into the file's own bytes. */
export function decodePart(bytes: Uint8Array, encoding: string): Uint8Array {
  const kind = String(encoding || '').toLowerCase();
  if (kind === 'base64') {
    return base64ToBytes(new TextDecoder().decode(bytes).replace(/[^A-Za-z0-9+/=]/g, ''));
  }
  if (kind === 'quoted-printable') return decodeQuotedPrintable(bytes);
  return bytes;
}
