/**
 * Take a received RFC 3156 multipart/signed message apart for checking.
 *
 * The signature covers the first body part exactly as it appears between the
 * boundary lines, its own headers included, with CRLF line endings. So the
 * part is cut out of the raw message text rather than rebuilt from a parsed
 * tree: any re-encoding (a header unfolded, a line ending changed) would make
 * a genuine signature fail.
 */

export interface SignedParts {
  /** The signed body part, CRLF line endings, without the delimiter CRLFs. */
  signed: string;
  /** The armored detached signature. */
  signature: string;
}

const CRLF = '\r\n';

/** The top-level header block and body, split at the first blank line. */
function splitHeaderBody(raw: string): { headers: string; body: string } | null {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return null;
  return { headers: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

/** The value of one header in a header block, unfolded. */
function headerValue(headers: string, name: string): string {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}[ \\t]*:[ \\t]*(.*)$`, 'im');
  return re.exec(unfolded)?.[1]?.trim() || '';
}

function param(value: string, name: string): string {
  const re = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
  const m = re.exec(value);
  return (m?.[1] ?? m?.[2] ?? '').trim();
}

/** True when the headers declare an OpenPGP multipart/signed message. */
export function isPgpSignedContentType(contentType: string): boolean {
  return (
    /^\s*multipart\/signed\b/i.test(contentType) &&
    /application\/pgp-signature/i.test(param(contentType, 'protocol'))
  );
}

export function splitSignedMime(raw: string): SignedParts | null {
  if (!raw || typeof raw !== 'string') return null;
  // One line-ending convention throughout, the one signatures are made over
  const text = raw.replace(/\r?\n/g, CRLF);
  const top = splitHeaderBody(text);
  if (!top) return null;
  const contentType = headerValue(top.headers, 'content-type');
  if (!isPgpSignedContentType(contentType)) return null;
  const boundary = param(contentType, 'boundary');
  if (!boundary) return null;

  const body = `${CRLF}${top.body}`;
  const delimiter = `${CRLF}--${boundary}`;
  const firstAt = body.indexOf(delimiter);
  if (firstAt === -1) return null;
  // Past the delimiter line itself (transport padding is allowed after it)
  const firstLineEnd = body.indexOf(CRLF, firstAt + delimiter.length);
  if (firstLineEnd === -1) return null;
  const signedStart = firstLineEnd + CRLF.length;
  const secondAt = body.indexOf(delimiter, signedStart);
  if (secondAt === -1) return null;

  const signed = body.slice(signedStart, secondAt);
  const rest = body.slice(secondAt + delimiter.length);
  const signature = /-----BEGIN PGP SIGNATURE-----[\s\S]+?-----END PGP SIGNATURE-----/.exec(
    rest,
  )?.[0];
  if (!signed || !signature) return null;
  return { signed, signature };
}

/**
 * Whether a message, as the API parsed it (`nodemailer`), is PGP signed-only.
 * Reads the raw header line first; the parsed header keeps value and params
 * apart.
 */
export function isPgpSignedNodemailer(nodemailer: unknown): boolean {
  const source = (nodemailer || {}) as {
    headerLines?: { key?: string; line?: string }[];
    headers?: Record<string, unknown>;
  };
  const line = (source.headerLines || []).find(
    (l) => String(l?.key || '').toLowerCase() === 'content-type',
  )?.line;
  if (line) return isPgpSignedContentType(line.slice(line.indexOf(':') + 1));
  const parsed = source.headers?.['content-type'] as
    | { value?: string; params?: Record<string, string> }
    | string
    | undefined;
  if (typeof parsed === 'string') return isPgpSignedContentType(parsed);
  if (!parsed?.value) return false;
  const params = Object.entries(parsed.params || {})
    .map(([k, v]) => `; ${k}="${v}"`)
    .join('');
  return isPgpSignedContentType(`${parsed.value}${params}`);
}
