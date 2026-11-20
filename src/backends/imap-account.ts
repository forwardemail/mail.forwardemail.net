/**
 * What is stored for an account on a custom IMAP server.
 *
 * The settings, password included, are fields on the account record, so they
 * are covered by whatever covers a Forward Email password: the App Lock vault
 * when it is on, otherwise the device seal on desktop.
 */

import { Accounts } from '../utils/storage';
import { normalizeAccount } from '../utils/account-scope';

export type MailSecurity = 'tls' | 'starttls';
export type MailAuth = 'password' | 'xoauth2';

export interface ImapSettings {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  /** Empty for an account that signs in with a token (see oauth.ts). */
  password: string;
  /** 'xoauth2' when a token signs in instead of a password. */
  auth?: MailAuth;
  /** The user said this server is on their own network. */
  allowLocal?: boolean;
}

const isSecurity = (value: unknown): value is MailSecurity =>
  value === 'tls' || value === 'starttls';

/** Settings as typed into a form, cleaned up, or null when they cannot be used. */
export function cleanImapSettings(input: unknown): ImapSettings | null {
  const raw = (input || {}) as Record<string, unknown>;
  const host = String(raw.host ?? '').trim();
  const port = Number(raw.port);
  const username = String(raw.username ?? '').trim();
  const password = typeof raw.password === 'string' ? raw.password : '';
  const tokenSignIn = raw.auth === 'xoauth2';
  // A token is fetched each time the account connects, so there is none to save.
  if (!host || !username || (!password && !tokenSignIn)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!isSecurity(raw.security)) return null;
  return {
    host,
    port,
    security: raw.security,
    username,
    password,
    ...(tokenSignIn ? { auth: 'xoauth2' as const } : {}),
    ...(raw.allowLocal === true ? { allowLocal: true } : {}),
  };
}

/** The stored IMAP settings of an account, or null when it has none. */
export function imapSettingsFor(account?: string | null): ImapSettings | null {
  const wanted = normalizeAccount(account);
  if (!wanted) return null;
  let accounts: Array<{ email?: string; kind?: unknown; imap?: unknown }> = [];
  try {
    accounts = Accounts.getAll() || [];
  } catch {
    return null;
  }
  const record = accounts.find((a) => normalizeAccount(a?.email) === wanted);
  if (!record || record.kind !== 'imap') return null;
  return cleanImapSettings(record.imap);
}

/** Every signed-in account whose mail is on a custom IMAP server. */
export function listImapAccounts(): string[] {
  let accounts: Array<{ email?: string }> = [];
  try {
    accounts = Accounts.getAll() || [];
  } catch {
    return [];
  }
  return accounts.map((a) => a?.email || '').filter((email) => email && imapSettingsFor(email));
}

/**
 * False when every account signed in on this device is on a custom mail
 * server. The app then has no business with Forward Email's servers, and the
 * calls it makes there with no account (the connectivity check, the socket
 * that announces new releases) are left out.
 *
 * True with nobody signed in: the sign-in page is Forward Email's by default.
 */
export function anyForwardEmailAccount(): boolean {
  let accounts: Array<{ email?: string; kind?: unknown }> = [];
  try {
    accounts = Accounts.getAll() || [];
  } catch {
    return true;
  }
  const signedIn = accounts.filter((a) => a?.email);
  return !signedIn.length || signedIn.some((a) => !imapSettingsFor(a.email));
}
