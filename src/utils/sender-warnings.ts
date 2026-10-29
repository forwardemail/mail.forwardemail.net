/**
 * Signs that a message may not be from who it says, for a reader banner.
 *
 * Only strong signals, so the banner stays rare enough to be read:
 *
 * - The display name carries an email address on another domain, as in
 *   "PayPal <service@paypal.com>" <x@evil.test>. Clients that show only the
 *   name show the fake address.
 * - DMARC failed, as recorded by Forward Email's own mail servers. The
 *   Authentication-Results headers a sender writes are not believed: the
 *   server strips any that claim its authserv-id (RFC 8601 section 5), so a
 *   header naming forwardemail.net or a subdomain is the server's own verdict.
 * - The sender's domain is internationalized (an xn-- label), which is how
 *   look-alike domains such as pаypal.com (Cyrillic а) are written.
 *
 * A first message from a new sender is deliberately not one: most mail would
 * carry the banner and it would stop meaning anything.
 */
import { extractEmail } from './address';

export type SenderWarningKind = 'display-name' | 'dmarc-fail' | 'idn-domain';

export interface SenderWarning {
  kind: SenderWarningKind;
  message: string;
}

interface HeaderLine {
  key?: string;
  line?: string;
}

interface MessageLike {
  from?: unknown;
  nodemailer?: { headerLines?: HeaderLine[]; headers?: Record<string, unknown> } | null;
}

const TRUSTED_AUTHSERV = 'forwardemail.net';
const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@([A-Z0-9-]+(?:\.[A-Z0-9-]+)+)/gi;

const domainOf = (address: string) => address.split('@')[1]?.toLowerCase() || '';

const sameOrSubdomain = (a: string, b: string) =>
  a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** The From header's display name and address, from whichever shape it came in. */
function senderParts(message: MessageLike): { name: string; address: string } {
  const parsedFrom = (message.nodemailer?.headers?.from || null) as {
    value?: { name?: string; address?: string }[];
  } | null;
  const first = parsedFrom?.value?.[0];
  if (first?.address) {
    return { name: String(first.name || ''), address: first.address.toLowerCase() };
  }
  const raw = typeof message.from === 'string' ? message.from : '';
  const address = extractEmail(message.from as Parameters<typeof extractEmail>[0]).toLowerCase();
  const lt = raw.lastIndexOf('<');
  const name = lt > 0 ? raw.slice(0, lt).trim().replace(/^"|"$/g, '') : '';
  return { name, address };
}

/** Authentication-Results values added by Forward Email's servers. */
export function trustedAuthResults(lines: HeaderLine[] | undefined): string[] {
  if (!Array.isArray(lines)) return [];
  const out: string[] = [];
  for (const entry of lines) {
    const key = String(entry?.key || '').toLowerCase();
    if (key !== 'authentication-results' && key !== 'arc-authentication-results') continue;
    const line = String(entry?.line || '');
    const value = line
      .slice(line.indexOf(':') + 1)
      .replace(/\r?\n[ \t]+/g, ' ')
      .trim();
    const id = value.match(/^(?:i\s*=\s*\d+\s*;\s*)?([^;\s]+)/i)?.[1]?.toLowerCase() || '';
    if (id === TRUSTED_AUTHSERV || id.endsWith(`.${TRUSTED_AUTHSERV}`)) out.push(value);
  }
  return out;
}

export function getSenderWarnings(message: MessageLike | null | undefined): SenderWarning[] {
  if (!message) return [];
  const warnings: SenderWarning[] = [];
  const { name, address } = senderParts(message);
  const fromDomain = domainOf(address);

  // Mailing lists rewrite the sender as "jane@example.com via Group" <group@...>,
  // which is not an impersonation.
  if (fromDomain && name && !/\bvia\b/i.test(name)) {
    for (const match of name.matchAll(EMAIL_IN_TEXT)) {
      const shown = match[1].toLowerCase();
      if (!sameOrSubdomain(shown, fromDomain)) {
        warnings.push({
          kind: 'display-name',
          message: `The sender's name shows ${match[0]}, but the message came from ${address}.`,
        });
        break;
      }
    }
  }

  const verdicts = trustedAuthResults(message.nodemailer?.headerLines);
  if (verdicts.some((value) => /\bdmarc\s*=\s*fail\b/i.test(value))) {
    warnings.push({
      kind: 'dmarc-fail',
      message: `This message failed sender verification (DMARC), so it may not really be from ${fromDomain || 'the address shown'}.`,
    });
  }

  if (fromDomain.split('.').some((label) => label.startsWith('xn--'))) {
    warnings.push({
      kind: 'idn-domain',
      message: `The sender's domain (${fromDomain}) uses international characters, which can imitate a familiar domain.`,
    });
  }

  return warnings;
}
