import { Local } from './storage.js';

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
