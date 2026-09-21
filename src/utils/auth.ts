import { Local, Accounts } from './storage.js';

export interface AuthOptions {
  allowApiKey?: boolean;
  required?: boolean;
}

// Encrypted localStorage values start with this prefix (crypto-store.js).
// If sessionStorage was cleared and the localStorage fallback returns an
// encrypted blob, we must treat the credential as missing rather than
// sending garbage to the API (which would produce 401s).
const ENCRYPTED_PREFIX = '\x00ENC\x01';

/**
 * Return true when a credential value looks usable (non-empty, not an
 * encrypted blob, and — for alias_auth — contains the expected "email:password"
 * colon separator).
 */
const isValidCredential = (value: string | null | undefined, expectColon = false): boolean => {
  if (!value) return false;
  if (value.startsWith(ENCRYPTED_PREFIX)) return false;
  // Basic sanity: alias_auth must contain at least one colon (email:password)
  if (expectColon && !value.includes(':')) return false;
  return true;
};

const buildBasicHeader = (value: string | null): string => (value ? `Basic ${btoa(value)}` : '');

export const buildAliasAuthHeader = (
  aliasAuth: string | null | undefined,
  { required = false }: { required?: boolean } = {},
): string => {
  if (aliasAuth && isValidCredential(aliasAuth, true)) return buildBasicHeader(aliasAuth);
  if (required) throw new Error('Authorization required. Please sign in again.');
  return '';
};

export const buildApiKeyAuthHeader = (apiKey: string | null | undefined): string =>
  buildBasicHeader(apiKey && isValidCredential(apiKey) ? `${apiKey}:` : '');

/**
 * Auth header for one specific account, independent of which account is active.
 *
 * Requests that were started for account A but complete after the user has
 * switched to B must still authenticate as A. Reading the active credentials at
 * send time is what let B's mail get fetched and then filed under A. Returns an
 * empty string when the account has no usable credentials (signed out, or its
 * stored credential is an encrypted blob while the app is locked); callers
 * should skip the request rather than fall back to the active account.
 */
export const getAuthHeaderForAccount = (email: string | null | undefined): string => {
  const active = Local.get('email');
  if (!email || email === 'default' || email === active) {
    return getAuthHeader({ allowApiKey: true });
  }
  let accounts: Array<{ email?: string; aliasAuth?: string | null; apiKey?: string | null }> = [];
  try {
    accounts = Accounts.getAll() || [];
  } catch {
    accounts = [];
  }
  const match = accounts.find((a) => a?.email === email);
  if (!match) return '';
  if (isValidCredential(match.aliasAuth, true)) return buildAliasAuthHeader(match.aliasAuth);
  if (isValidCredential(match.apiKey)) return buildApiKeyAuthHeader(match.apiKey);
  return '';
};

export const getAuthHeader = ({
  allowApiKey = true,
  required = false,
}: AuthOptions = {}): string => {
  const aliasAuth = Local.get('alias_auth');
  if (isValidCredential(aliasAuth, true)) return buildAliasAuthHeader(aliasAuth, { required });
  if (allowApiKey) {
    const apiKey = Local.get('api_key');
    if (isValidCredential(apiKey)) {
      const header = buildApiKeyAuthHeader(apiKey);
      if (header) return header;
    }
  }
  if (required) throw new Error('Authorization required. Please sign in again.');
  return '';
};
