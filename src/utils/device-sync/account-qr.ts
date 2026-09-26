/**
 * Account setup QR codes shown by forwardemail.net when an alias password is
 * generated. These are the codes meant for other mail apps, and the pairing
 * scanner accepts them too so a phone user can point our app at whichever one
 * is in front of them.
 *
 * Two formats exist:
 *
 * - Thunderbird Mobile settings import. A JSON array carrying the IMAP and SMTP
 *   settings with the username and password in the clear, so it is read
 *   entirely offline.
 * - Apple configuration profile link. An https URL to a signed .mobileconfig
 *   whose `p` parameter is encrypted with a key only the server holds, so the
 *   credentials only exist in the profile the link downloads.
 *
 * Neither carries PGP keys or settings. They feed the normal sign-in path, not
 * the pairing bundle import.
 */
import { config } from '../../config';

export type AccountCredentials = { email: string; password: string };

export type AccountQr =
  | ({ kind: 'thunderbird' } & AccountCredentials)
  | { kind: 'apple-profile'; email: string; url: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isEmail = (value: unknown): value is string =>
  typeof value === 'string' && EMAIL_RE.test(value);

/**
 * Hosts a profile link may point at. A scanned code decides which server we
 * download credentials from and then sign in with, so an arbitrary host would
 * let a planted QR sign the phone into an account someone else controls.
 */
export function allowedProfileHosts(apiBase: string = config.apiBase): Set<string> {
  const hosts = new Set(['forwardemail.net', 'www.forwardemail.net']);
  try {
    const { hostname } = new URL(apiBase);
    hosts.add(hostname.replace(/^api\./, ''));
  } catch {
    // A malformed apiBase just leaves the production hosts.
  }
  return hosts;
}

/**
 * Thunderbird's import format, as built by forwardemail.net:
 * [1, [1, 1], [0, imapHost, imapPort, tls, auth, username, email, password],
 *  [[[0, smtpHost, smtpPort, tls, auth, username, password], [email, name]]]]
 */
function parseThunderbird(text: string): AccountQr | null {
  if (!text.startsWith('[')) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data[0] !== 1 || !Array.isArray(data[2])) return null;
  const incoming = data[2];
  const username = incoming[5];
  const password = incoming[7];
  if (!isEmail(username) || typeof password !== 'string' || !password) return null;
  return { kind: 'thunderbird', email: username, password };
}

function parseAppleProfileUrl(text: string, hosts: Set<string>): AccountQr | null {
  if (!/^https:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !hosts.has(url.hostname)) return null;
  const match = /^\/c\/([^/]+)\.mobileconfig$/.exec(url.pathname);
  if (!match) return null;
  let email: string;
  try {
    email = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!isEmail(email) || !url.searchParams.get('a') || !url.searchParams.get('p')) return null;
  return { kind: 'apple-profile', email, url: url.toString() };
}

/** Returns null for anything that is not one of the account setup codes. */
export function parseAccountQr(
  text: string | null | undefined,
  hosts: Set<string> = allowedProfileHosts(),
): AccountQr | null {
  const value = (text || '').trim();
  if (!value) return null;
  return parseThunderbird(value) || parseAppleProfileUrl(value, hosts);
}

const indexOfBytes = (haystack: Uint8Array, needle: Uint8Array, from = 0): number => {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
};

const plistValue = (node: Element | null | undefined): unknown => {
  if (!node) return undefined;
  switch (node.tagName) {
    case 'string':
    case 'integer':
      return node.textContent ?? '';
    case 'true':
      return true;
    case 'false':
      return false;
    case 'array':
      return Array.from(node.children).map(plistValue);
    case 'dict': {
      const out: Record<string, unknown> = {};
      const children = Array.from(node.children);
      for (let i = 0; i < children.length - 1; i += 2) {
        if (children[i].tagName === 'key') {
          out[children[i].textContent ?? ''] = plistValue(children[i + 1]);
        }
      }
      return out;
    }
    default:
      return undefined;
  }
};

/**
 * Pull the mail account out of a .mobileconfig. Production profiles are CMS
 * signed, but the signed content is stored verbatim inside the DER, so the
 * plist can be sliced out by its XML markers without a PKCS#7 parser. We do
 * not verify the signature here; the host allowlist and TLS are what tie the
 * profile to our server.
 */
export function readMobileconfigCredentials(bytes: Uint8Array): AccountCredentials | null {
  const encoder = new TextEncoder();
  const start = indexOfBytes(bytes, encoder.encode('<?xml'));
  if (start < 0) return null;
  const endMarker = encoder.encode('</plist>');
  const end = indexOfBytes(bytes, endMarker, start);
  if (end < 0) return null;

  const xml = new TextDecoder().decode(bytes.subarray(start, end + endMarker.length));
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;

  const root = plistValue(doc.documentElement?.firstElementChild) as
    | { PayloadContent?: unknown }
    | undefined;
  const payloads = Array.isArray(root?.PayloadContent) ? root.PayloadContent : [];
  const mail = payloads.find(
    (p): p is Record<string, unknown> =>
      !!p &&
      typeof p === 'object' &&
      (p as Record<string, unknown>).PayloadType === 'com.apple.mail.managed',
  );
  if (!mail) return null;

  const email = mail.IncomingMailServerUsername ?? mail.EmailAddress;
  const password = mail.IncomingPassword;
  if (!isEmail(email) || typeof password !== 'string' || !password) return null;
  return { email, password };
}

/**
 * Download the profile a link points at and read its credentials. The server
 * answers every bad or stale link with a bare 404 (so links cannot be probed),
 * which is almost always a password that has since been regenerated.
 */
export async function fetchAppleProfileCredentials(
  qr: Extract<AccountQr, { kind: 'apple-profile' }>,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountCredentials> {
  let response: Response;
  try {
    response = await fetchImpl(qr.url, { credentials: 'omit', redirect: 'error' });
  } catch {
    // A network failure and the server's 404 look the same here: the 404 page
    // carries no CORS header, so the browser reports both as a failed fetch.
    throw new Error(
      'Could not read that code. Check your connection, or scan the Thunderbird Mobile code instead.',
    );
  }
  if (!response.ok) {
    throw new Error(
      'That code is no longer valid. The password may have been regenerated; get a new code.',
    );
  }
  const creds = readMobileconfigCredentials(new Uint8Array(await response.arrayBuffer()));
  if (!creds) throw new Error('That code could not be read. Try scanning again.');
  if (creds.email.toLowerCase() !== qr.email.toLowerCase()) {
    throw new Error('That code did not match its account. Get a new code and try again.');
  }
  return creds;
}
