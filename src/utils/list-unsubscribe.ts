/**
 * Read a message's List-Unsubscribe header (RFC 2369, with RFC 8058 one-click).
 *
 * The header is sender-supplied, so only two kinds of target are used: an
 * https URL, opened in the system browser after the user confirms, and a
 * mailto address, which gets a short unsubscribe email from the user's own
 * account. Anything else (http, javascript:, data:, custom schemes) is
 * ignored.
 *
 * A one-click POST (RFC 8058) is sent by the service worker, outside the
 * page's CSP, which allows connections to the Forward Email API only (see
 * `sendOneClickUnsubscribe` and public/sw-sync.js). Only to an https URL on
 * a public host name (`isOneClickUrl`), and only from the web app: the
 * desktop and mobile apps have no service worker, so they use the email or
 * the page instead.
 *
 * The raw header line is preferred over the parsed `list` object, which keeps
 * only one URL and one address per header.
 */
import { parseMailto } from './mailto.js';

export interface UnsubscribeOptions {
  /** https URL to open in the browser */
  url?: string;
  /** Address to send an unsubscribe email to, with what the sender asked for */
  mail?: { to: string; subject: string; body: string };
  /** The sender declared RFC 8058 one-click support, for a URL it may be sent to */
  oneClick: boolean;
}

interface HeaderLine {
  key?: string;
  line?: string;
}

interface NodemailerLike {
  headerLines?: HeaderLine[];
  headers?: Record<string, unknown>;
}

const MAX_HEADER = 4096;

// (longer URLs are not worth sending a request to)
const MAX_ONE_CLICK_URL = 2048;

// Names that only resolve on the user's own network (RFC 6761, .arpa and
// the ones routers use)
const LOCAL_NAMES =
  /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|private|arpa)$/;

/**
 * Whether a one-click POST may be sent to this URL from the user's device:
 * https on the default port, without credentials, to a public host name.
 * Never an IP address or a local name, which could reach a device on the
 * user's own network. (The same rule is in public/sw-sync.js, which sends it.)
 */
export function isOneClickUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > MAX_ONE_CLICK_URL) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  const labels = host.split('.');
  const tld = labels.at(-1) || '';
  return (
    labels.length >= 2 &&
    labels.every((label) => label.length > 0) &&
    !host.includes(':') &&
    !host.startsWith('[') &&
    /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld) &&
    !LOCAL_NAMES.test(host)
  );
}

function headerLineValue(lines: HeaderLine[] | undefined, name: string): string {
  if (!Array.isArray(lines)) return '';
  const found = lines.find((l) => String(l?.key || '').toLowerCase() === name);
  const line = String(found?.line || '');
  const colon = line.indexOf(':');
  return colon === -1 ? '' : line.slice(colon + 1).slice(0, MAX_HEADER);
}

/** The `<...>` entries of a List-Unsubscribe value, unfolded. */
export function listUnsubscribeTargets(value: string): string[] {
  const out: string[] = [];
  const unfolded = String(value || '').replace(/\r?\n[ \t]+/g, ' ');
  for (const match of unfolded.matchAll(/<\s*([^<>\s]+)\s*>/g)) {
    out.push(match[1]);
  }
  return out;
}

function safeHttpsUrl(candidate: string): string {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !url.hostname) return '';
    // Credentials in an unsubscribe link have no legitimate use
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function mailTarget(candidate: string): UnsubscribeOptions['mail'] | undefined {
  if (!/^mailto:/i.test(candidate)) return undefined;
  const parsed = parseMailto(candidate);
  const to = parsed.to?.[0];
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return undefined;
  return {
    to,
    subject: (parsed.subject || 'unsubscribe').slice(0, 200),
    body: (parsed.body || 'unsubscribe').slice(0, 1000),
  };
}

export function getUnsubscribeOptions(nodemailer: unknown): UnsubscribeOptions | null {
  const source = (nodemailer || {}) as NodemailerLike;
  const headers = (source.headers || {}) as Record<string, unknown>;
  const list = (headers.list || {}) as Record<string, Record<string, string> | undefined>;

  let targets = listUnsubscribeTargets(headerLineValue(source.headerLines, 'list-unsubscribe'));
  if (!targets.length) {
    const raw = headers['list-unsubscribe'];
    if (typeof raw === 'string') targets = listUnsubscribeTargets(raw);
  }
  if (!targets.length && list.unsubscribe) {
    const { url, mail } = list.unsubscribe;
    if (url) targets.push(url);
    if (mail) targets.push(`mailto:${mail}`);
  }

  let url = '';
  let mail: UnsubscribeOptions['mail'];
  for (const target of targets) {
    if (!url) url = safeHttpsUrl(target);
    if (!mail) mail = mailTarget(target);
  }
  if (!url && !mail) return null;

  const post =
    headerLineValue(source.headerLines, 'list-unsubscribe-post') ||
    String(list['unsubscribe-post']?.name || headers['list-unsubscribe-post'] || '');
  const oneClick =
    Boolean(url) && isOneClickUrl(url) && /List-Unsubscribe\s*=\s*One-Click/i.test(post);

  return { ...(url ? { url } : {}), ...(mail ? { mail } : {}), oneClick };
}

/** Whether the one-click POST can be sent from here (see `sendOneClickUnsubscribe`). */
export function canSendOneClick(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);
}

/**
 * Send the one-click POST (RFC 8058) through the service worker, which
 * sends it without cookies or a referrer (public/sw-sync.js). Resolves with
 * whether it was sent; `false` when there is no service worker, it refused,
 * or the list's server could not be reached.
 */
export function sendOneClickUnsubscribe(url: string, timeoutMs = 20_000): Promise<boolean> {
  const controller =
    typeof navigator === 'undefined' ? null : navigator.serviceWorker?.controller || null;
  if (!controller || !isOneClickUrl(url)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = (event) => finish(event.data?.ok === true);
    controller.postMessage({ type: 'one-click-unsubscribe', url }, [channel.port2]);
  });
}
