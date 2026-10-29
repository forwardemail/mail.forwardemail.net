/**
 * Build the RFC 3156 PGP/MIME message the API sends as a raw body.
 *
 * The composer normally posts structured fields (to/subject/html/text) and lets
 * the server build the MIME. That cannot work for encryption: the ciphertext
 * has to cover the body and attachments as one MIME tree, and the server must
 * not see the plaintext. So the client builds the whole RFC 5322 message and
 * posts it as `raw`.
 *
 * Nothing here talks to OpenPGP. It takes the armored ciphertext and wraps it,
 * which keeps the structure unit-testable without a crypto dependency.
 */

export interface MimeAttachment {
  filename?: string;
  name?: string;
  contentType?: string;
  /** Base64 content, as the composer already holds it. */
  content?: string;
  cid?: string;
}

export interface MessageParts {
  text?: string;
  html?: string;
  attachments?: MimeAttachment[];
}

export interface OuterHeaders {
  from: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  replyTo?: string;
  date?: Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}

const CRLF = '\r\n';

let boundarySeq = 0;

/** Boundary that cannot collide with base64 or quoted-printable content. */
export function makeBoundary(prefix = 'fe'): string {
  boundarySeq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `--=_${prefix}_${Date.now().toString(36)}_${boundarySeq}_${rand}`;
}

/**
 * Collapse CR, LF and every other C0/C1 control into a single space.
 *
 * Header values come from the composer, drafts and mailto: links. A raw CR or
 * LF would end the current header and let the value add its own (a hidden
 * Bcc, a second Content-Type, or a blank line that ends the header block).
 */
export function stripHeaderControls(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ');
}

/** The declared type on one line when it starts with a plain type/subtype, else octet-stream. */
function safeContentType(value: unknown): string {
  const clean = stripHeaderControls(value).trim();
  const declared = clean.split(/[;,\s]/)[0];
  return /^[\w.+-]+\/[\w.+-]+$/.test(declared) ? clean : 'application/octet-stream';
}

/** A quoted-string parameter value: no controls, quotes or backslashes. */
function safeParamValue(value: string): string {
  return stripHeaderControls(value).replace(/["\\]/g, '').trim();
}

/**
 * Encode a header value per RFC 2047 when it is not plain ASCII.
 *
 * Without this, an accented name or an emoji subject would be emitted as raw
 * UTF-8 bytes in a header, which many receivers render as mojibake.
 */
export function encodeHeaderValue(value: string): string {
  const str = stripHeaderControls(value);
  if (!str) return '';
  if (/^[\x20-\x7E]*$/.test(str)) return str;
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/** Encode an address list, leaving the addr-spec alone and encoding display names. */
export function encodeAddressList(addresses: string[] | undefined): string {
  return (addresses || [])
    .map((entry) => {
      const clean = stripHeaderControls(entry);
      const match = clean.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
      if (!match) return clean.trim();
      const [, name, addr] = match;
      if (!name) return addr;
      const stripped = name.replace(/^"|"$/g, '').replace(/\\"/g, '"');
      const encoded = encodeHeaderValue(stripped);
      // An RFC 2047 encoded-word is already a single token. A plain name that
      // holds any RFC 5322 special (a comma, period, parenthesis...) has to be
      // re-quoted, or "Doe, Jane <j@e.com>" parses as two mailboxes.
      const needsQuotes = encoded === stripped && /[()<>[\]:;@\\,."]/.test(stripped);
      const display = needsQuotes ? `"${stripped.replace(/(["\\])/g, '\\$1')}"` : encoded;
      return `${display} <${addr}>`;
    })
    .filter(Boolean)
    .join(', ');
}

/** Split base64 into the 76-character lines RFC 2045 requires. */
export function wrapBase64(content: string): string {
  const clean = String(content || '').replace(/\s+/g, '');
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += 76) lines.push(clean.slice(i, i + 76));
  return lines.join(CRLF);
}

function base64OfUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return wrapBase64(btoa(binary));
}

/**
 * Build the MIME tree that gets encrypted: the body, plus attachments.
 *
 * Bodies are base64'd rather than sent as-is so no line of user text can be
 * mistaken for a boundary or get mangled by line-ending rewriting.
 */
export function buildInnerMime(parts: MessageParts): string {
  const attachments = (parts.attachments || []).filter((a) => a?.content);
  const hasText = Boolean(parts.text);
  const hasHtml = Boolean(parts.html);

  const bodySection = (): string => {
    const textPart = () =>
      [
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64OfUtf8(parts.text || ''),
      ].join(CRLF);
    const htmlPart = () =>
      [
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64OfUtf8(parts.html || ''),
      ].join(CRLF);

    if (hasText && hasHtml) {
      const alt = makeBoundary('alt');
      return [
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        '',
        `--${alt}`,
        textPart(),
        `--${alt}`,
        htmlPart(),
        `--${alt}--`,
      ].join(CRLF);
    }
    return hasHtml ? htmlPart() : textPart();
  };

  if (!attachments.length) return bodySection();

  const mixed = makeBoundary('mix');
  const chunks: string[] = [`Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`];
  chunks.push(bodySection());

  for (const att of attachments) {
    const filename = safeParamValue(att.filename || att.name || '') || 'attachment';
    const type = safeContentType(att.contentType);
    const cid = stripHeaderControls(att.cid || '').replace(/[<>\s]/g, '');
    chunks.push(`--${mixed}`);
    chunks.push(
      [
        `Content-Type: ${type}; name="${filename}"`,
        'Content-Transfer-Encoding: base64',
        cid ? `Content-ID: <${cid}>` : null,
        `Content-Disposition: ${cid ? 'inline' : 'attachment'}; filename="${filename}"`,
        '',
        wrapBase64(att.content || ''),
      ]
        .filter((line) => line !== null)
        .join(CRLF),
    );
  }
  chunks.push(`--${mixed}--`);
  return chunks.join(CRLF);
}

/**
 * Wrap armored ciphertext in the multipart/encrypted envelope and add the
 * outer headers.
 *
 * The Subject stays in the clear: RFC 3156 has no way to hide it, and every
 * mail client expects to read it without a key. Callers that want it hidden
 * must replace it before calling.
 */
function outerHeaderLines(headers: OuterHeaders): string[] {
  const date = headers.date || new Date();
  const lines: string[] = [
    'MIME-Version: 1.0',
    `Date: ${date.toUTCString().replace(/GMT$/, '+0000')}`,
    `From: ${encodeAddressList([headers.from])}`,
  ];
  if (headers.to?.length) lines.push(`To: ${encodeAddressList(headers.to)}`);
  if (headers.cc?.length) lines.push(`Cc: ${encodeAddressList(headers.cc)}`);
  if (headers.replyTo) lines.push(`Reply-To: ${encodeAddressList([headers.replyTo])}`);
  lines.push(`Subject: ${encodeHeaderValue(headers.subject || '')}`);
  const messageId = stripHeaderControls(headers.messageId).trim();
  const inReplyTo = stripHeaderControls(headers.inReplyTo).trim();
  const references = stripHeaderControls(headers.references).trim();
  if (messageId) lines.push(`Message-ID: ${messageId}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  return lines;
}

export function buildPgpMimeMessage(armored: string, headers: OuterHeaders): string {
  const boundary = makeBoundary('pgp');
  const lines = outerHeaderLines(headers);

  lines.push(
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
    '',
    'This is an OpenPGP/MIME encrypted message (RFC 3156).',
    '',
    `--${boundary}`,
    'Content-Type: application/pgp-encrypted',
    'Content-Description: PGP/MIME version identification',
    '',
    'Version: 1',
    '',
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"',
    '',
    String(armored || '')
      .replace(/\r?\n/g, CRLF)
      .trim(),
    '',
    `--${boundary}--`,
    '',
  );

  return lines.join(CRLF);
}

/**
 * Wrap a MIME entity and its detached signature in the multipart/signed
 * envelope (RFC 3156 section 5) and add the outer headers.
 *
 * `entity` must be the exact text that was signed, CRLF line endings
 * included: receivers check the signature over the first part's bytes as they
 * appear between the boundaries. buildInnerMime base64-encodes every body, so
 * no line has the trailing whitespace transports would strip.
 */
export function buildPgpSignedMessage(
  entity: string,
  armoredSignature: string,
  micalg: string,
  headers: OuterHeaders,
): string {
  const boundary = makeBoundary('sig');
  const safeMicalg = /^pgp-[a-z0-9-]+$/.test(micalg) ? micalg : 'pgp-sha256';
  const lines = outerHeaderLines(headers);
  lines.push(
    `Content-Type: multipart/signed; micalg="${safeMicalg}"; protocol="application/pgp-signature"; boundary="${boundary}"`,
    '',
    'This is an OpenPGP/MIME signed message (RFC 3156).',
    `--${boundary}`,
    entity.replace(/\r?\n/g, CRLF),
    `--${boundary}`,
    'Content-Type: application/pgp-signature; name="signature.asc"',
    'Content-Description: OpenPGP digital signature',
    'Content-Disposition: attachment; filename="signature.asc"',
    '',
    String(armoredSignature || '')
      .replace(/\r?\n/g, CRLF)
      .trim(),
    '',
    `--${boundary}--`,
    '',
  );
  return lines.join(CRLF);
}
