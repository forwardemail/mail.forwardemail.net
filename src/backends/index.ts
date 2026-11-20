/**
 * Which mail backend an account uses.
 *
 * The kind is stored on the account record. Records written before backends
 * existed have none and are Forward Email accounts.
 */

import { Accounts } from '../utils/storage';
import { normalizeAccount } from '../utils/account-scope';
import { isDemoMode } from '../utils/demo-mode';
import { DemoBackend } from './demo';
import { ForwardEmailBackend } from './forward-email';
import { ImapBackend } from './imap';
import { mailEngineAvailable } from './imap-engine';
import { BackendNotReadyError, type BackendKind, type MailBackend } from './types';

export * from './types';
export { ForwardEmailBackend } from './forward-email';
export { ImapBackend } from './imap';
export { DemoBackend } from './demo';
export { capabilitiesFor, FORWARD_EMAIL_CAPABILITIES, IMAP_CAPABILITIES } from './capabilities';

const KINDS: readonly BackendKind[] = ['forwardemail', 'imap', 'demo'];

export function backendKindForAccount(account?: string | null): BackendKind {
  // The demo is a mode of the whole app, not a stored account kind: while it
  // is on, no account's mail may reach a real server.
  if (isDemoMode()) return 'demo';
  const wanted = normalizeAccount(account);
  if (!wanted) return 'forwardemail';
  let accounts: Array<{ email?: string; kind?: unknown }> = [];
  try {
    accounts = Accounts.getAll() || [];
  } catch {
    accounts = [];
  }
  const record = accounts.find((a) => normalizeAccount(a?.email) === wanted);
  const kind = record?.kind;
  return KINDS.includes(kind as BackendKind) ? (kind as BackendKind) : 'forwardemail';
}

const backends = new Map<string, MailBackend>();

/**
 * The backend for an account, or null when this build has no backend for the
 * account's kind. Callers leave the work for later in that case; they never
 * fall back to another backend, which would act on the wrong server.
 */
export function getMailBackend(account: string): MailBackend | null {
  const kind = backendKindForAccount(account);
  const key = `${kind}:${normalizeAccount(account)}`;
  const existing = backends.get(key);
  if (existing) return existing;
  let backend: MailBackend;
  if (kind === 'demo') backend = new DemoBackend(account);
  else if (kind === 'forwardemail') backend = new ForwardEmailBackend(account);
  // The IMAP engine is part of the desktop app. Anywhere else an IMAP
  // account has no backend and its work waits.
  else if (kind === 'imap' && mailEngineAvailable()) backend = new ImapBackend(account);
  else return null;
  backends.set(key, backend);
  return backend;
}

/**
 * The backend for an account, for a caller that is about to send. Throws
 * BackendNotReadyError when there is none, as a call on a backend without
 * credentials does, so both cases reach the caller's one failure path.
 */
export function requireMailBackend(account: string): MailBackend {
  const backend = getMailBackend(account);
  if (!backend) throw new BackendNotReadyError(account);
  return backend;
}

/** Forget an account's backend, after it signs out or its settings change. */
export function resetMailBackend(account: string): void {
  const wanted = normalizeAccount(account);
  for (const key of [...backends.keys()]) {
    if (key.slice(key.indexOf(':') + 1) === wanted) backends.delete(key);
  }
}

/** Test seam: forget every backend made so far. */
export function resetMailBackendsForTests(): void {
  backends.clear();
}
