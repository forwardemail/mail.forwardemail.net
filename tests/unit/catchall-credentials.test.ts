import { beforeEach, describe, expect, it } from 'vitest';
import {
  CATCHALL_ADDRESS_LIMIT,
  CATCHALL_CREDENTIALS_KEY,
  buildCatchallAuthHeader,
  forgetCatchallAddress,
  listCatchallAddresses,
  normalizeCatchallAddress,
  rememberCatchallAddress,
  getCatchallCredentialFor,
  listCatchallDomains,
  normalizeCatchallDomain,
  removeCatchallCredential,
  saveCatchallCredential,
} from '../../src/utils/catchall-credentials';
import { Local } from '../../src/utils/storage.js';

beforeEach(() => {
  Local.remove(CATCHALL_CREDENTIALS_KEY);
});

describe('normalizeCatchallDomain', () => {
  it('accepts the *@domain form the settings field shows, a bare domain, or an address', () => {
    expect(normalizeCatchallDomain('*@Example.COM')).toBe('example.com');
    expect(normalizeCatchallDomain(' example.com ')).toBe('example.com');
    expect(normalizeCatchallDomain('@mail.example.co.uk')).toBe('mail.example.co.uk');
    expect(normalizeCatchallDomain('sales@example.com')).toBe('example.com');
  });

  it('rejects things that are not a domain name', () => {
    for (const input of ['', '*@', 'localhost', 'exa mple.com', '-bad.com', 'example.', null]) {
      expect(normalizeCatchallDomain(input)).toBe('');
    }
  });
});

describe('catch-all credential storage', () => {
  it('saves one password per domain and replaces it on a second save', () => {
    expect(saveCatchallCredential('*@example.com', 'one')).toEqual({
      ok: true,
      domain: 'example.com',
    });
    saveCatchallCredential('example.org', 'other');
    saveCatchallCredential('EXAMPLE.com', 'two');

    expect(listCatchallDomains()).toEqual(['example.com', 'example.org']);
    expect(getCatchallCredentialFor('sales@example.com')?.password).toBe('two');
  });

  it('refuses a missing domain or password', () => {
    expect(saveCatchallCredential('nope', 'pw')).toMatchObject({ ok: false });
    expect(saveCatchallCredential('example.com', '')).toMatchObject({ ok: false });
    expect(listCatchallDomains()).toEqual([]);
  });

  it('removes a domain', () => {
    saveCatchallCredential('example.com', 'one');
    saveCatchallCredential('example.org', 'two');
    removeCatchallCredential('*@example.com');
    expect(listCatchallDomains()).toEqual(['example.org']);
  });

  it('reads as empty when the stored value is unreadable', () => {
    Local.set(CATCHALL_CREDENTIALS_KEY, 'not json');
    expect(listCatchallDomains()).toEqual([]);
    expect(buildCatchallAuthHeader('sales@example.com')).toBe('');
  });
});

describe('buildCatchallAuthHeader', () => {
  beforeEach(() => {
    saveCatchallCredential('example.com', 'secret');
  });

  it('logs in as the From address itself with the domain password', () => {
    expect(buildCatchallAuthHeader('Sales@Example.com')).toBe(
      `Basic ${btoa('sales@example.com:secret')}`,
    );
  });

  it('only matches the exact domain, not a subdomain or a lookalike', () => {
    expect(buildCatchallAuthHeader('a@mail.example.com')).toBe('');
    expect(buildCatchallAuthHeader('a@notexample.com')).toBe('');
    expect(buildCatchallAuthHeader('example.com')).toBe('');
  });
});

describe('remembered catch-all From addresses', () => {
  beforeEach(() => {
    saveCatchallCredential('example.com', 'secret');
  });

  it('keeps the newest first, once each, in any letter case', () => {
    rememberCatchallAddress('Sales@Example.com');
    rememberCatchallAddress('contact@example.com');
    rememberCatchallAddress('SALES@example.com');
    expect(listCatchallAddresses('example.com')).toEqual([
      'sales@example.com',
      'contact@example.com',
    ]);
  });

  it('only remembers addresses on a domain with a saved password', () => {
    expect(rememberCatchallAddress('someone@other.test')).toBe(false);
    expect(listCatchallAddresses()).toEqual([]);
  });

  it('survives a new password for the domain, and goes with the domain', () => {
    rememberCatchallAddress('contact@example.com');
    saveCatchallCredential('example.com', 'rotated');
    expect(listCatchallAddresses('example.com')).toEqual(['contact@example.com']);
    removeCatchallCredential('example.com');
    expect(listCatchallAddresses()).toEqual([]);
  });

  it('forgets one address and keeps the rest', () => {
    rememberCatchallAddress('a@example.com');
    rememberCatchallAddress('b@example.com');
    forgetCatchallAddress('A@example.com');
    expect(listCatchallAddresses('example.com')).toEqual(['b@example.com']);
  });

  it(`keeps at most ${CATCHALL_ADDRESS_LIMIT}`, () => {
    for (let i = 0; i < CATCHALL_ADDRESS_LIMIT + 5; i += 1) {
      rememberCatchallAddress(`a${i}@example.com`);
    }
    const kept = listCatchallAddresses('example.com');
    expect(kept).toHaveLength(CATCHALL_ADDRESS_LIMIT);
    expect(kept[0]).toBe(`a${CATCHALL_ADDRESS_LIMIT + 4}@example.com`);
  });

  it('normalizes a typed address, or the part before the @', () => {
    expect(normalizeCatchallAddress('Contact', 'example.com')).toBe('contact@example.com');
    expect(normalizeCatchallAddress(' Contact@Example.com ', 'example.com')).toBe(
      'contact@example.com',
    );
    expect(normalizeCatchallAddress('contact@other.test', 'example.com')).toBe('');
    for (const bad of ['', 'two words', 'a,b', '<x>', '@example.com']) {
      expect(normalizeCatchallAddress(bad, 'example.com')).toBe('');
    }
  });
});
