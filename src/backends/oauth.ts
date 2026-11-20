/**
 * Accounts signed in through their provider's own sign-in page (OAuth).
 *
 * Gmail and Microsoft 365 take no password over IMAP. The mail engine opens
 * the provider's page in the user's browser (src-tauri/src/mail/oauth.rs) and
 * hands back two tokens. The long-lived one is saved on the account record,
 * where a password would be. The short-lived one signs in to IMAP and SMTP,
 * lasts about an hour, and is only ever kept in memory.
 */

import { Accounts } from '../utils/storage';
import { normalizeAccount } from '../utils/account-scope';
import { invokeEngine, MailEngineError, onMailEngineReset } from './engine-bridge';
import type { ImapSettings, MailSecurity } from './imap-account';

export type OAuthProvider = 'google' | 'microsoft';

interface ServerPreset {
  label: string;
  imap: { host: string; port: number; security: MailSecurity };
  smtp: { host: string; port: number; security: MailSecurity };
}

/** Where each provider's mail servers are. Nobody should have to type these. */
export const OAUTH_SERVERS: Record<OAuthProvider, ServerPreset> = {
  google: {
    label: 'Google',
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
  },
  microsoft: {
    label: 'Microsoft',
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
  },
};

export const isOAuthProvider = (value: unknown): value is OAuthProvider =>
  value === 'google' || value === 'microsoft';

/** What is saved for an account signed in this way. */
export interface OAuthLink {
  provider: OAuthProvider;
  refreshToken: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  /** Seconds until the access token stops working. */
  expiresIn: number;
  email?: string | null;
}

/** The saved sign-in of an account, or null when it signs in with a password. */
export function oauthLinkFor(account?: string | null): OAuthLink | null {
  const wanted = normalizeAccount(account);
  if (!wanted) return null;
  let accounts: Array<{ email?: string; oauth?: unknown }> = [];
  try {
    accounts = Accounts.getAll() || [];
  } catch {
    return null;
  }
  const link = accounts.find((a) => normalizeAccount(a?.email) === wanted)?.oauth as
    | Partial<OAuthLink>
    | undefined;
  if (!link || !isOAuthProvider(link.provider) || typeof link.refreshToken !== 'string') {
    return null;
  }
  return link.refreshToken ? { provider: link.provider, refreshToken: link.refreshToken } : null;
}

/** The providers this build of the app can sign in with. */
export async function listOAuthProviders(): Promise<OAuthProvider[]> {
  try {
    const names = await invokeEngine<unknown[]>('oauth_providers', {});
    return (Array.isArray(names) ? names : []).filter(isOAuthProvider);
  } catch {
    // Not the desktop app, or an older engine: nothing to offer.
    return [];
  }
}

/** Open the provider's sign-in page and wait for the user to finish there. */
export function startOAuthSignIn(provider: OAuthProvider): Promise<OAuthTokens> {
  return invokeEngine<OAuthTokens>('oauth_sign_in', { provider });
}

// Asked for again this long before it runs out, so a token is never handed
// over with seconds to live.
const EARLY_MS = 2 * 60 * 1000;

interface Held {
  token: string;
  expiresAt: number;
}

const held = new Map<string, Held>();
const renewing = new Map<string, Promise<string>>();
onMailEngineReset(() => {
  held.clear();
  renewing.clear();
});

const key = (account: string) => account.toLowerCase();

/** Keep an access token that was just issued, so the first use needs no renewal. */
export function rememberAccessToken(account: string, tokens: OAuthTokens): void {
  if (!tokens?.accessToken) return;
  held.set(key(account), {
    token: tokens.accessToken,
    expiresAt: Date.now() + Math.max(0, Number(tokens.expiresIn) || 0) * 1000,
  });
}

/** Drop the access token held for an account: the server refused it, or the account is leaving. */
export function forgetAccessToken(account: string): void {
  held.delete(key(account));
}

/** Drop every access token. For when the app locks. */
export function forgetAllAccessTokens(): void {
  held.clear();
}

async function renew(account: string, link: OAuthLink): Promise<string> {
  const tokens = await invokeEngine<OAuthTokens>('oauth_refresh', {
    provider: link.provider,
    refreshToken: link.refreshToken,
  });
  // Some providers replace the long-lived token each time it is used. The
  // old one then stops working, so the new one has to be saved first.
  if (tokens.refreshToken && tokens.refreshToken !== link.refreshToken) {
    const saved = Accounts.setOAuth(account, {
      provider: link.provider,
      refreshToken: tokens.refreshToken,
    });
    if (!saved) {
      throw new MailEngineError(
        'auth',
        'The sign-in could not be saved. Unlock the app and try again.',
      );
    }
  }
  rememberAccessToken(account, tokens);
  return tokens.accessToken;
}

/**
 * A working access token for an account. Renewed when the one in memory is
 * missing or about to run out. Rejects with kind "auth" when the saved
 * sign-in no longer works and the user has to sign in again.
 */
export function accessTokenFor(account: string): Promise<string> {
  const current = held.get(key(account));
  if (current && current.expiresAt - EARLY_MS > Date.now()) return Promise.resolve(current.token);
  const link = oauthLinkFor(account);
  if (!link) {
    return Promise.reject(new MailEngineError('auth', 'This account has to sign in again'));
  }
  // Several commands can start at once; one renewal serves them all.
  let pending = renewing.get(key(account));
  if (!pending) {
    pending = renew(account, link).finally(() => {
      if (renewing.get(key(account)) === pending) renewing.delete(key(account));
    });
    renewing.set(key(account), pending);
  }
  return pending;
}

/**
 * Server settings as the engine takes them. For an account that signs in
 * with a token, the token goes where the password would be.
 */
export async function withCredentials<T extends ImapSettings>(
  account: string,
  settings: T,
): Promise<T> {
  if (settings.auth !== 'xoauth2') return settings;
  return { ...settings, password: await accessTokenFor(account) };
}
