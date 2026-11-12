import { Local } from './storage.js';

/**
 * Domain-wide catch-all passwords, saved on this device for every account.
 *
 * A catch-all password (generated on the domain's Advanced Settings page)
 * lets the client send from any address on that domain. The API accepts it
 * only on POST /v1/emails, as a send-only login, so it can never read a
 * mailbox. The Sent copy is filed with the active account's own credentials.
 *
 * Stored under a sensitive key, so App Lock encrypts it at rest and it reads
 * as empty while the app is locked. It is not a portable setting, so QR
 * pairing does not copy it to another device.
 */
export interface CatchallCredential {
  domain: string;
  password: string;
  /**
   * Addresses on the domain sent from before, or added in Settings, newest
   * first: the compose From menu offers them so they need not be typed again.
   */
  addresses: string[];
}

/** How many From addresses are kept per domain. */
export const CATCHALL_ADDRESS_LIMIT = 20;

const LOCAL_PART_PATTERN = /^[^\s@<>(),;:"[\]\\]+$/;

export const CATCHALL_CREDENTIALS_KEY = 'catchall_credentials';

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * Turns what the user typed into a bare lowercase domain. Accepts the
 * `*@example.com` form the settings field shows, a leading `@`, or a full
 * address. Returns '' when the result is not a domain name.
 */
export const normalizeCatchallDomain = (input: string | null | undefined): string => {
  const value = String(input ?? '')
    .trim()
    .toLowerCase();
  const at = value.lastIndexOf('@');
  const domain = (at >= 0 ? value.slice(at + 1) : value).replace(/\.$/, '');
  return DOMAIN_PATTERN.test(domain) ? domain : '';
};

/**
 * A lowercase address on `domain` (or on any domain when none is given), or
 * '' when the input is not one. Accepts just the part before the @ when a
 * domain is given.
 */
export const normalizeCatchallAddress = (input: unknown, domain?: string): string => {
  const value = String(input ?? '')
    .trim()
    .toLowerCase();
  const at = value.lastIndexOf('@');
  const local = at >= 0 ? value.slice(0, at) : value;
  const host = at >= 0 ? normalizeCatchallDomain(value.slice(at + 1)) : domain || '';
  if (!local || !host || !LOCAL_PART_PATTERN.test(local) || local.length > 64) return '';
  if (domain && host !== normalizeCatchallDomain(domain)) return '';
  return `${local}@${host}`;
};

const domainOf = (address: string | null | undefined): string => {
  const value = String(address ?? '').trim();
  const at = value.lastIndexOf('@');
  return at > 0 ? normalizeCatchallDomain(value.slice(at + 1)) : '';
};

export const listCatchallCredentials = (): CatchallCredential[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Local.get(CATCHALL_CREDENTIALS_KEY) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CatchallCredential[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const domain = normalizeCatchallDomain(entry?.domain);
    const password = typeof entry?.password === 'string' ? entry.password : '';
    if (!domain || !password || seen.has(domain)) continue;
    seen.add(domain);
    const addresses: string[] = [];
    for (const value of Array.isArray(entry?.addresses) ? entry.addresses : []) {
      const address = normalizeCatchallAddress(value, domain);
      if (address && !addresses.includes(address)) addresses.push(address);
    }
    out.push({ domain, password, addresses: addresses.slice(0, CATCHALL_ADDRESS_LIMIT) });
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
};

export const listCatchallDomains = (): string[] =>
  listCatchallCredentials().map((entry) => entry.domain);

const write = (list: CatchallCredential[]): boolean =>
  Local.set(CATCHALL_CREDENTIALS_KEY, JSON.stringify(list));

/** Adds a domain's password, or replaces the one already saved for it. */
export const saveCatchallCredential = (
  domainInput: string,
  password: string,
): { ok: true; domain: string } | { ok: false; error: string } => {
  const domain = normalizeCatchallDomain(domainInput);
  if (!domain) return { ok: false, error: 'Enter a domain name, like example.com' };
  if (!password) return { ok: false, error: 'Enter the catch-all password' };
  const list = listCatchallCredentials();
  // A new password for a saved domain keeps the addresses already remembered.
  const addresses = list.find((entry) => entry.domain === domain)?.addresses || [];
  const rest = list.filter((entry) => entry.domain !== domain);
  if (!write([...rest, { domain, password, addresses }])) {
    return { ok: false, error: 'Could not save the password on this device' };
  }
  return { ok: true, domain };
};

export const removeCatchallCredential = (domainInput: string): void => {
  const domain = normalizeCatchallDomain(domainInput);
  const list = listCatchallCredentials();
  const rest = list.filter((entry) => entry.domain !== domain);
  if (rest.length === list.length) return;
  if (rest.length) write(rest);
  else Local.remove(CATCHALL_CREDENTIALS_KEY);
};

/** The saved catch-all password for an address's domain, if there is one. */
export const getCatchallCredentialFor = (
  address: string | null | undefined,
): CatchallCredential | null => {
  const domain = domainOf(address);
  if (!domain) return null;
  return listCatchallCredentials().find((entry) => entry.domain === domain) || null;
};

/**
 * Basic auth header that sends as `address` with its domain's catch-all
 * password, or '' when none is saved. The username is the From address
 * itself, which the server accepts with the domain password.
 */
export const buildCatchallAuthHeader = (address: string | null | undefined): string => {
  const credential = getCatchallCredentialFor(address);
  if (!credential) return '';
  const username = String(address).trim().toLowerCase();
  try {
    return `Basic ${btoa(`${username}:${credential.password}`)}`;
  } catch {
    // btoa only takes Latin-1; generated passwords are ASCII
    return '';
  }
};

/** The remembered From addresses for one domain, or for every domain. */
export const listCatchallAddresses = (domainInput?: string): string[] => {
  const domain = domainInput ? normalizeCatchallDomain(domainInput) : '';
  return listCatchallCredentials()
    .filter((entry) => !domain || entry.domain === domain)
    .flatMap((entry) => entry.addresses);
};

const updateAddresses = (
  address: string,
  change: (addresses: string[], normalized: string) => string[],
): boolean => {
  const credential = getCatchallCredentialFor(address);
  if (!credential) return false;
  const normalized = normalizeCatchallAddress(address, credential.domain);
  if (!normalized) return false;
  const list = listCatchallCredentials();
  const next = list.map((entry) =>
    entry.domain === credential.domain
      ? {
          ...entry,
          addresses: change(entry.addresses, normalized).slice(0, CATCHALL_ADDRESS_LIMIT),
        }
      : entry,
  );
  return write(next);
};

/**
 * Remembers an address sent from with a catch-all password, newest first,
 * so the From menu offers it next time. Nothing happens for an address
 * whose domain has no saved password.
 */
export const rememberCatchallAddress = (address: string): boolean =>
  updateAddresses(address, (addresses, normalized) => [
    normalized,
    ...addresses.filter((entry) => entry !== normalized),
  ]);

/** Forgets one remembered From address. */
export const forgetCatchallAddress = (address: string): boolean =>
  updateAddresses(address, (addresses, normalized) =>
    addresses.filter((entry) => entry !== normalized),
  );
