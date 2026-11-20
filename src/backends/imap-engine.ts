/**
 * The bridge to the Rust mail engine (src-tauri/src/mail).
 *
 * Rust issues a handle when an account signs in and every other command takes
 * that handle. The handle lives for the life of the app process, so it is
 * opened again after a restart, and after Rust forgets it.
 */

import { invokeEngine, MailEngineError, onMailEngineReset } from './engine-bridge';
import { imapSettingsFor, type ImapSettings } from './imap-account';
import { forgetAccessToken, withCredentials } from './oauth';

export {
  invokeEngine,
  MailEngineError,
  mailEngineAvailable,
  onMailEngineReset,
  setMailEngineForTests,
} from './engine-bridge';

/** Check settings by signing in and out again. Nothing is kept. */
export function testImapSettings(imap: ImapSettings): Promise<void> {
  return invokeEngine<void>('mail_test', { imap });
}

const handles = new Map<string, Promise<string>>();
onMailEngineReset(() => handles.clear());

function handleFor(account: string): Promise<string> {
  const key = account.toLowerCase();
  let pending = handles.get(key);
  if (!pending) {
    const imap = imapSettingsFor(account);
    if (!imap) {
      return Promise.reject(
        new MailEngineError('auth', 'This account has no saved server settings'),
      );
    }
    // An account signed in through its provider's page has no password: a
    // current access token goes in its place.
    pending = withCredentials(account, imap).then((settings) =>
      invokeEngine<string>('mail_open', { imap: settings }),
    );
    handles.set(key, pending);
    // A failed sign-in is not remembered, so the next call tries again.
    pending.catch(() => {
      if (handles.get(key) === pending) handles.delete(key);
    });
  }
  return pending;
}

/** The engine's handle for an account, signing in first when needed. */
export const mailHandleFor = (account: string): Promise<string> => handleFor(account);

/** The account a handle was issued for, or null for one this page did not open. */
export async function accountForMailHandle(handle: string): Promise<string | null> {
  for (const [account, pending] of handles) {
    if ((await pending.catch(() => null)) === handle) return account;
  }
  return null;
}

/** Run an engine command as an account, signing in first when needed. */
export async function mailCommand<T>(
  account: string,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const key = account.toLowerCase();
  for (let attempt = 0; ; attempt += 1) {
    const pending = handleFor(account);
    try {
      const handle = await pending;
      return await invokeEngine<T>(cmd, { ...args, handle });
    } catch (err) {
      const kind = err instanceof MailEngineError ? err.kind : '';
      // Rust no longer knows the handle (the app process restarted under a
      // page that did not). Sign in again once.
      const stale = kind === 'handle';
      // An access token lasts about an hour. The server refuses an old one
      // the next time the connection is made: get a new one and sign in again.
      const expired = kind === 'auth' && imapSettingsFor(account)?.auth === 'xoauth2';
      if ((!stale && !expired) || attempt > 0) throw err;
      if (expired) forgetAccessToken(account);
      if (handles.get(key) === pending) handles.delete(key);
    }
  }
}

/** Sign an account out of the engine, which drops its password from memory. */
export async function closeMailAccount(account: string): Promise<void> {
  const key = account.toLowerCase();
  const pending = handles.get(key);
  if (!pending) return;
  handles.delete(key);
  try {
    const handle = await pending;
    await invokeEngine<void>('mail_close', { handle });
  } catch {
    // Nothing to close.
  }
}

/** Sign every account out of the engine. For when the app locks. */
export async function closeAllMailAccounts(): Promise<void> {
  await Promise.all([...handles.keys()].map((account) => closeMailAccount(account)));
}
