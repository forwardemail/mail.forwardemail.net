/**
 * An account's custom outgoing (SMTP) server.
 *
 * Any account can have one. A Forward Email account without one sends through
 * the API as before. An account on a custom IMAP server has no API to send
 * through, so it cannot send until one is saved in Settings.
 *
 * The settings, password included, are a field on the account record, next to
 * the IMAP settings and covered by the same storage (imap-account.ts).
 */

import { Accounts } from '../utils/storage';
import { normalizeAccount } from '../utils/account-scope';
import { cleanImapSettings, imapSettingsFor, type ImapSettings } from './imap-account';

/** An outgoing server is described by the same fields as an incoming one. */
export type SmtpSettings = ImapSettings;

export const cleanSmtpSettings = (input: unknown): SmtpSettings | null => cleanImapSettings(input);

/** The stored outgoing server of an account, or null when it has none. */
export function smtpSettingsFor(account?: string | null): SmtpSettings | null {
  const wanted = normalizeAccount(account);
  if (!wanted) return null;
  let accounts: Array<{ email?: string; smtp?: unknown }> = [];
  try {
    accounts = Accounts.getAll() || [];
  } catch {
    return null;
  }
  const record = accounts.find((a) => normalizeAccount(a?.email) === wanted);
  return record?.smtp ? cleanSmtpSettings(record.smtp) : null;
}

/** Save an account's outgoing server, or clear it with null. */
export function saveSmtpSettings(account: string, settings: SmtpSettings | null): boolean {
  return Accounts.setSmtp(account, settings);
}

/**
 * How an account's mail goes out.
 *
 * - `forwardemail`: the Forward Email API
 * - `smtp`: the account's own outgoing server
 * - `none`: an account on a custom IMAP server with no outgoing server yet
 */
export type Transport = 'forwardemail' | 'smtp' | 'none';

export function transportFor(account?: string | null): Transport {
  if (smtpSettingsFor(account)) return 'smtp';
  return imapSettingsFor(account) ? 'none' : 'forwardemail';
}

// Accounts the main window said send through it. A compose window cannot
// always read the account list (WebView2 keeps storage per window).
const handedOver = new Set<string>();

/** Compose window: remember what the main window said (see compose-window.ts). */
export function setOutboxSenders(accounts: unknown): void {
  handedOver.clear();
  if (!Array.isArray(accounts)) return;
  for (const account of accounts) {
    const key = normalizeAccount(typeof account === 'string' ? account : '');
    if (key) handedOver.add(key);
  }
}

/** Every signed-in account that does not send through the Forward Email API. */
export function listOutboxSenders(): string[] {
  let accounts: Array<{ email?: string }> = [];
  try {
    accounts = Accounts.getAll() || [];
  } catch {
    return [];
  }
  return accounts
    .map((a) => a?.email || '')
    .filter((email) => email && transportFor(email) !== 'forwardemail');
}

/**
 * True when a message from this account has to be sent by the main window's
 * outbox. Only the main window may use the mail engine, so the composer
 * queues the message instead of sending it itself.
 */
export function sendsThroughOutbox(account?: string | null): boolean {
  return transportFor(account) !== 'forwardemail' || handedOver.has(normalizeAccount(account));
}

export const MISSING_OUTGOING_SERVER = (account: string): string =>
  `${account} has no outgoing server. Add one in Settings, then send again.`;
