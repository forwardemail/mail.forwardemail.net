import { normalizeEmail } from './address';
import { getAuthHeaderForAccount } from './auth';
import { buildCatchallAuthHeader } from './catchall-credentials';

/**
 * The compose From menu offers accounts signed in on this device, plus any
 * address on a domain with a saved catch-all password. The API accepts a From
 * address only from that alias's own credentials or its domain's catch-all
 * password, so an address is sendable exactly when we hold one of those.
 */
export interface SendableAccount {
  email: string;
  name?: string;
}

/**
 * Lists the active account first, then every other signed-in account that
 * `hasCredentials` vouches for (signed out, or locked behind App Lock, drops
 * out). Duplicates and blanks are skipped.
 */
export const listSendableAccounts = (
  accounts: Array<{ email?: string | null; name?: string | null }>,
  activeEmail: string,
  hasCredentials: (email: string) => boolean,
): SendableAccount[] => {
  const active = normalizeEmail(activeEmail);
  const out: SendableAccount[] = [];
  const seen = new Set<string>();
  // Keeps the stored spelling: credential lookups match it exactly.
  const push = (email: string, name?: string | null) => {
    const key = normalizeEmail(email);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const cleanName = String(name || '').trim();
    out.push(cleanName ? { email, name: cleanName } : { email });
  };

  const activeEntry = accounts.find((acct) => normalizeEmail(acct?.email || '') === active);
  if (active) push(activeEntry?.email || activeEmail, activeEntry?.name);
  for (const acct of accounts) {
    const email = acct?.email || '';
    if (!normalizeEmail(email) || normalizeEmail(email) === active) continue;
    if (!hasCredentials(email)) continue;
    push(email, acct?.name);
  }
  return out;
};

/** Builds the From header value, quoting the display name when there is one. */
export const formatFromHeader = (email: string, name?: string): string => {
  const cleanName = String(name || '')
    .replace(/["\\\r\n]/g, '')
    .trim();
  return cleanName ? `"${cleanName}" <${email}>` : email;
};

/** True when the server refused the From header, so the UI can say why. */
export const isFromHeaderRejection = (message: string): boolean =>
  /from header must (be equal to|end with)/i.test(message || '');

/**
 * How a send from `address` authenticates.
 *
 * - `active`: the active account; requests use the session as usual.
 * - `account`: another account signed in on this device, with its own
 *   credentials. Its Sent copy goes to that account's Sent folder.
 * - `catchall`: an address on a domain with a saved catch-all password. That
 *   login can only send, so the Sent copy goes to the active account's Sent
 *   folder, and the server-side schedule (which needs reading back and
 *   cancelling) is not available.
 *
 * Null when there are no usable credentials, e.g. signed out, or locked
 * behind App Lock. Callers must not fall back to the active account then.
 */
export type SenderAuth = { kind: 'active' } | { kind: 'account' | 'catchall'; authHeader: string };

export const resolveSenderAuth = (
  address: string | null | undefined,
  activeEmail: string,
  {
    accountAuth = getAuthHeaderForAccount,
    catchallAuth = buildCatchallAuthHeader,
  }: {
    accountAuth?: (email: string) => string;
    catchallAuth?: (email: string) => string;
  } = {},
): SenderAuth | null => {
  const key = normalizeEmail(address || '');
  if (!key || key === normalizeEmail(activeEmail)) return { kind: 'active' };
  const accountHeader = accountAuth(address as string);
  if (accountHeader) return { kind: 'account', authHeader: accountHeader };
  const catchallHeader = catchallAuth(address as string);
  if (catchallHeader) return { kind: 'catchall', authHeader: catchallHeader };
  return null;
};

/** Request options for a resolved sender ({} for the active session). */
export const senderRequestOptions = (sender: SenderAuth): { authHeader?: string } =>
  sender.kind === 'active' ? {} : { authHeader: sender.authHeader };

/** Why a send from `address` can't authenticate, for the composer and outbox. */
export const missingSenderMessage = (address: string): string =>
  `Can't send as ${address}: sign in to that account on this device again, or save its domain's catch-all password in Settings.`;
