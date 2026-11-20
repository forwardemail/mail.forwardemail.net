/**
 * Suggested server settings for an email address.
 *
 * The mail engine does the looking (src-tauri/src/mail/autoconfig.rs). It is
 * given the address and nothing else, and asks the domain's own settings
 * file, Thunderbird's public directory, and the domain's DNS records. The
 * directory is told the mail domain, never the address.
 *
 * The answer fills an editable form. Nothing is connected to until the user
 * signs in.
 */

import { invokeEngine } from './engine-bridge';
import { OAUTH_SERVERS, type OAuthProvider } from './oauth';
import type { MailSecurity } from './imap-account';

export interface SuggestedServer {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
}

export type SuggestionSource = 'domain' | 'directory' | 'provider' | 'dns';

export interface MailSuggestion {
  source: SuggestionSource;
  imap: SuggestedServer | null;
  smtp: SuggestedServer | null;
  /**
   * Set when the incoming server belongs to a provider that signs in through
   * its own page. A password typed into the form will usually be refused
   * there.
   */
  signInWith: OAuthProvider | null;
}

const SOURCES: SuggestionSource[] = ['domain', 'directory', 'provider', 'dns'];

function cleanServer(input: unknown): SuggestedServer | null {
  const raw = (input || {}) as Record<string, unknown>;
  const host = String(raw.host ?? '')
    .trim()
    .toLowerCase();
  const port = Number(raw.port);
  const security = raw.security;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (security !== 'tls' && security !== 'starttls') return null;
  return { host, port, security, username: String(raw.username ?? '').trim() };
}

function providerFor(host: string | undefined): OAuthProvider | null {
  if (!host) return null;
  const match = (Object.keys(OAUTH_SERVERS) as OAuthProvider[]).find(
    (provider) => OAUTH_SERVERS[provider].imap.host === host,
  );
  return match ?? null;
}

/**
 * Look up the settings for an address. Resolves with null when nothing is
 * published for it. Rejects with a MailEngineError when the lookup could not
 * be run (not a full address, or too many lookups in a minute).
 */
export async function findMailSettings(email: string): Promise<MailSuggestion | null> {
  const answer = await invokeEngine<Record<string, unknown> | null>('mail_autoconfig', {
    email: String(email || '').trim(),
  });
  if (!answer) return null;
  const imap = cleanServer(answer.imap);
  const smtp = cleanServer(answer.smtp);
  if (!imap && !smtp) return null;
  const source = SOURCES.includes(answer.source as SuggestionSource)
    ? (answer.source as SuggestionSource)
    : 'dns';
  return { source, imap, smtp, signInWith: providerFor(imap?.host) };
}

/** One line for the form saying where a suggestion came from. */
export function suggestionSourceText(suggestion: MailSuggestion, email: string): string {
  const domain = String(email || '')
    .trim()
    .split('@')
    .pop();
  switch (suggestion.source) {
    case 'domain':
      return `Settings published by ${domain}.`;
    case 'directory':
      return `Settings from Thunderbird's public directory.`;
    case 'provider':
      return `Settings for the provider that hosts mail for ${domain}.`;
    default:
      return `Server names from the DNS records of ${domain}. Check them before signing in.`;
  }
}
