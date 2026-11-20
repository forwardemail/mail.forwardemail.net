/**
 * Build the message an SMTP server is handed, from the fields the composer
 * posts to the Forward Email API.
 *
 * The API builds the message itself from those fields. An SMTP server takes
 * finished bytes, so for an account with its own outgoing server the client
 * builds them, with the same body builder the encrypted path uses
 * (pgp-mime.ts). An encrypted or signed message arrives already built in
 * `raw` and goes out as it is.
 */

import {
  buildInnerMime,
  encodeAddressList,
  encodeHeaderValue,
  stripHeaderControls,
  type MimeAttachment,
} from './pgp-mime';

const CRLF = '\r\n';
const LINE_LIMIT = 78;

export interface OutgoingEmail {
  from?: string;
  to?: string[] | string;
  cc?: string[] | string;
  bcc?: string[] | string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: MimeAttachment[];
  replyTo?: string;
  reply_to?: string;
  inReplyTo?: string;
  references?: string | string[];
  messageId?: string;
  date?: string | Date;
  /** A whole message built earlier (encrypted or signed). */
  raw?: string;
}

export interface BuiltMessage {
  /** The bare address in From. */
  from: string;
  /** Bare addresses of To, Cc and Bcc, without repeats. */
  recipients: string[];
  /** What the server is handed. No Bcc header. */
  raw: Uint8Array;
  /** What is kept in Sent. Names the Bcc recipients, for the sender only. */
  sentCopy: Uint8Array;
}

const list = (value: string[] | string | undefined): string[] =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);

/** The address out of `Name <addr>`, or the entry itself. */
export function bareAddress(entry: string): string {
  const clean = stripHeaderControls(entry).trim();
  const bracketed = /<([^<>]+)>\s*$/.exec(clean);
  return (bracketed ? bracketed[1] : clean).trim();
}

/** Wrap a header at its spaces so no line runs past the limit. */
function foldAtSpaces(line: string): string {
  if (line.length <= LINE_LIMIT) return line;
  const out: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current && current.length + 1 + word.length > LINE_LIMIT) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out.join(`${CRLF} `);
}

/**
 * A subject that is not plain ASCII, as a run of short encoded-words. One
 * long encoded-word cannot be wrapped, and a server may refuse the line.
 */
function subjectLine(subject: string): string {
  const clean = stripHeaderControls(subject);
  if (/^[\x20-\x7E]*$/.test(clean)) return foldAtSpaces(`Subject: ${clean}`);
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = '';
  let size = 0;
  // Whole characters only: an encoded-word must not split one.
  for (const char of Array.from(clean)) {
    const bytes = encoder.encode(char).length;
    // 42 bytes is 56 base64 characters: with the encoded-word wrapping and
    // "Subject: " on the first line, that stays inside the line limit.
    if (chunk && size + bytes > 42) {
      words.push(encodeHeaderValue(chunk));
      chunk = '';
      size = 0;
    }
    chunk += char;
    size += bytes;
  }
  if (chunk) words.push(encodeHeaderValue(chunk));
  return `Subject: ${words.join(`${CRLF} `)}`;
}

function addressLine(name: string, addresses: string[]): string {
  const entries = addresses.map((entry) => encodeAddressList([entry])).filter(Boolean);
  const oneLine = `${name}: ${entries.join(', ')}`;
  return oneLine.length <= LINE_LIMIT ? oneLine : `${name}: ${entries.join(`,${CRLF} `)}`;
}

function dateLine(value: string | Date | undefined): string {
  const given = value ? new Date(value) : new Date();
  const date = Number.isFinite(given.getTime()) ? given : new Date();
  return `Date: ${date.toUTCString().replace(/GMT$/, '+0000')}`;
}

function messageIdFor(email: OutgoingEmail, from: string): string {
  const given = stripHeaderControls(email.messageId).trim();
  if (given) return given.startsWith('<') ? given : `<${given}>`;
  const domain = from.split('@')[1] || 'localhost';
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return `<${random}@${domain}>`;
}

/** Bytes of a message that was built earlier, with CRLF line endings. */
const rawBytes = (raw: string): Uint8Array =>
  new TextEncoder().encode(raw.replace(/\r\n|\r|\n/g, CRLF));

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Move pictures written into the HTML as data: addresses out into parts of
 * their own, named by Content-ID.
 *
 * The editor inserts a picture as a data: address. Gmail and Outlook do not
 * draw those, so the person reading would see a broken image.
 */
export function embedDataImages(
  html: string,
  domain: string,
): { html: string; images: MimeAttachment[] } {
  const images: MimeAttachment[] = [];
  const cidByContent = new Map<string, string>();
  const stamp = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const out = html.replace(
    /(<img\b[^>]*?\ssrc\s*=\s*)(["'])data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)\2/gi,
    (_match, before: string, quote: string, type: string, data: string) => {
      const content = data.replace(/\s+/g, '');
      const key = `${type.toLowerCase()} ${content}`;
      let cid = cidByContent.get(key);
      if (!cid) {
        const number = images.length + 1;
        cid = `image${number}.${stamp}@${domain || 'localhost'}`;
        cidByContent.set(key, cid);
        images.push({
          filename: `image-${number}.${IMAGE_EXTENSIONS[type.toLowerCase()] || 'img'}`,
          contentType: type.toLowerCase(),
          content,
          cid,
        });
      }
      return `${before}${quote}cid:${cid}${quote}`;
    },
  );
  return { html: out, images };
}

export interface BuildOptions {
  /** A draft may have nobody to go to yet. It is saved, never sent. */
  draft?: boolean;
}

export function buildMimeMessage(
  email: OutgoingEmail,
  { draft = false }: BuildOptions = {},
): BuiltMessage {
  const from = bareAddress(String(email.from ?? ''));
  if (!from.includes('@')) throw new Error('The message has no From address');
  const to = list(email.to);
  const cc = list(email.cc);
  const bcc = list(email.bcc);
  const recipients = Array.from(new Set([...to, ...cc, ...bcc].map(bareAddress).filter(Boolean)));
  if (!recipients.length && !draft) throw new Error('The message has no recipients');

  if (email.raw) {
    const raw = rawBytes(email.raw);
    return { from, recipients, raw, sentCopy: raw };
  }

  const headers: string[] = [
    'MIME-Version: 1.0',
    dateLine(email.date),
    addressLine('From', [String(email.from)]),
  ];
  if (to.length) headers.push(addressLine('To', to));
  if (cc.length) headers.push(addressLine('Cc', cc));
  const replyTo = String(email.replyTo || email.reply_to || '').trim();
  if (replyTo) headers.push(addressLine('Reply-To', [replyTo]));
  headers.push(subjectLine(email.subject || ''));
  headers.push(`Message-ID: ${messageIdFor(email, from)}`);
  const inReplyTo = stripHeaderControls(email.inReplyTo).trim();
  if (inReplyTo) headers.push(foldAtSpaces(`In-Reply-To: ${inReplyTo}`));
  const references = stripHeaderControls(
    Array.isArray(email.references) ? email.references.join(' ') : email.references,
  ).trim();
  if (references) headers.push(foldAtSpaces(`References: ${references}`));

  // A draft keeps its pictures in the HTML, so it opens in the editor again
  // exactly as it was saved.
  const pictures =
    email.html && !draft
      ? embedDataImages(email.html, from.split('@')[1] || '')
      : { html: email.html, images: [] };
  const body = buildInnerMime({
    text: email.text,
    // A message with no body at all still needs a part to carry.
    ...(pictures.html ? { html: pictures.html } : {}),
    attachments: [...pictures.images, ...(email.attachments || [])],
  });

  const encoder = new TextEncoder();
  const assemble = (lines: string[]) => encoder.encode(`${lines.join(CRLF)}${CRLF}${body}${CRLF}`);
  const raw = assemble(headers);
  if (!bcc.length) return { from, recipients, raw, sentCopy: raw };

  // After Cc, or after To, or after From when the message is Bcc only.
  const anchor = ['Cc: ', 'To: ', 'From: ']
    .map((prefix) => headers.findIndex((line) => line.startsWith(prefix)))
    .find((index) => index >= 0) as number;
  const withBcc = [...headers];
  withBcc.splice(anchor + 1, 0, addressLine('Bcc', bcc));
  return { from, recipients, raw, sentCopy: assemble(withBcc) };
}
