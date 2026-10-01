import { normalizeEmail } from './address';

/**
 * The compose From menu only offers accounts signed in on this device. The API
 * accepts a From address only from that alias's own credentials, so an address
 * is sendable exactly when we hold credentials for it.
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
