import { beforeEach, describe, expect, it } from 'vitest';
import {
  CATCHALL_CREDENTIALS_KEY,
  buildCatchallAuthHeader,
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
