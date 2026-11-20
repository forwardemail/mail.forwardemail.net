/**
 * Sending through the Rust mail engine (src-tauri/src/mail/smtp.rs).
 *
 * As with IMAP, Rust is told the server once and hands back a handle. A send
 * names the handle, never a server, so a send cannot be pointed somewhere
 * else.
 */

import { invokeEngine, MailEngineError, onMailEngineReset } from './engine-bridge';
import { forgetAccessToken, withCredentials } from './oauth';
import { bytesToBase64 } from './imap-mapping';
import { smtpSettingsFor, type SmtpSettings } from './smtp-account';

/** Check settings by signing in and out again. Nothing is kept. */
export function testSmtpSettings(smtp: SmtpSettings): Promise<void> {
  return invokeEngine<void>('smtp_test', { smtp });
}

const handles = new Map<string, Promise<string>>();
onMailEngineReset(() => handles.clear());

function handleFor(account: string): Promise<string> {
  const key = account.toLowerCase();
  let pending = handles.get(key);
  if (!pending) {
    const smtp = smtpSettingsFor(account);
    if (!smtp) {
      return Promise.reject(new MailEngineError('input', 'This account has no outgoing server'));
    }
    pending = withCredentials(account, smtp).then((settings) =>
      invokeEngine<string>('smtp_open', { smtp: settings }),
    );
    handles.set(key, pending);
    pending.catch(() => {
      if (handles.get(key) === pending) handles.delete(key);
    });
  }
  return pending;
}

export interface SmtpEnvelope {
  /** The bare address the message is sent as. */
  from: string;
  /** Bare addresses of everyone it goes to, Bcc included. */
  recipients: string[];
  /** The whole message. */
  raw: Uint8Array;
}

/** Send one message through an account's outgoing server. */
export async function smtpSend(account: string, envelope: SmtpEnvelope): Promise<void> {
  const key = account.toLowerCase();
  const args = {
    from: envelope.from,
    recipients: envelope.recipients,
    message: bytesToBase64(envelope.raw),
  };
  for (let attempt = 0; ; attempt += 1) {
    const pending = handleFor(account);
    try {
      const handle = await pending;
      return await invokeEngine<void>('smtp_send', { ...args, handle });
    } catch (err) {
      const kind = err instanceof MailEngineError ? err.kind : '';
      // Rust forgot the handle (the app process restarted under this page).
      const stale = kind === 'handle';
      // The access token ran out since the server was remembered.
      const expired = kind === 'auth' && smtpSettingsFor(account)?.auth === 'xoauth2';
      // Either way nothing was sent: the server is signed in to before a
      // message is handed over. Opening it again and sending once is safe.
      if ((!stale && !expired) || attempt > 0) throw err;
      if (expired) forgetAccessToken(account);
      if (handles.get(key) === pending) handles.delete(key);
    }
  }
}

/** Forget an account's outgoing server in the engine, password included. */
export async function closeSmtpAccount(account: string): Promise<void> {
  const key = account.toLowerCase();
  const pending = handles.get(key);
  if (!pending) return;
  handles.delete(key);
  try {
    const handle = await pending;
    await invokeEngine<void>('smtp_close', { handle });
  } catch {
    // Nothing to close.
  }
}

/** Forget every outgoing server in the engine. For when the app locks. */
export async function closeAllSmtpAccounts(): Promise<void> {
  await Promise.all([...handles.keys()].map((account) => closeSmtpAccount(account)));
}
