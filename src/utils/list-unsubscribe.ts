/**
 * Read a message's List-Unsubscribe header (RFC 2369, with RFC 8058 one-click).
 *
 * The header is sender-supplied, so only two kinds of target are used: an
 * https URL, opened in the system browser after the user confirms, and a
 * mailto address, which gets a short unsubscribe email from the user's own
 * account. Anything else (http, javascript:, data:, custom schemes) is
 * ignored.
 *
 * A one-click POST (RFC 8058) is not sent from here: the app's CSP allows
 * connections to the Forward Email API only, so an https target opens in the
 * browser instead.
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
  /** The sender declared RFC 8058 one-click support */
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
  const oneClick = Boolean(url) && /List-Unsubscribe\s*=\s*One-Click/i.test(post);

  return { ...(url ? { url } : {}), ...(mail ? { mail } : {}), oneClick };
}
