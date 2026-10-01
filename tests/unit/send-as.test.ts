import { describe, it, expect } from 'vitest';
import {
  formatFromHeader,
  isFromHeaderRejection,
  listSendableAccounts,
} from '../../src/utils/send-as';

describe('listSendableAccounts', () => {
  const accounts = [
    { email: 'other@example.org', name: 'Other' },
    { email: 'Mailbox@example.com', name: 'Me' },
    { email: 'locked@example.net' },
    { email: '' },
    { email: 'other@example.org' },
  ];
  const withCreds = new Set(['other@example.org']);

  it('puts the active account first and keeps accounts we can authenticate as', () => {
    expect(
      listSendableAccounts(accounts, 'mailbox@example.com', (email) => withCreds.has(email)),
    ).toEqual([
      { email: 'Mailbox@example.com', name: 'Me' },
      { email: 'other@example.org', name: 'Other' },
    ]);
  });

  it('drops accounts without usable credentials, e.g. signed out or locked', () => {
    const list = listSendableAccounts(accounts, 'mailbox@example.com', () => false);
    expect(list.map((a) => a.email)).toEqual(['Mailbox@example.com']);
  });

  it('always offers the active account, even when it is missing from the list', () => {
    expect(listSendableAccounts([], 'solo@example.com', () => true)).toEqual([
      { email: 'solo@example.com' },
    ]);
  });
});

describe('formatFromHeader', () => {
  it('quotes the display name and strips characters that would break the header', () => {
    expect(formatFromHeader('a@example.com', 'Acme "Sales"')).toBe('"Acme Sales" <a@example.com>');
    expect(formatFromHeader('a@example.com', 'x\r\nBcc: evil@x.com')).toBe(
      '"xBcc: evil@x.com" <a@example.com>',
    );
  });

  it('returns the bare address without a name', () => {
    expect(formatFromHeader('a@example.com', '  ')).toBe('a@example.com');
  });
});

describe('isFromHeaderRejection', () => {
  it('recognizes both server phrasings', () => {
    expect(
      isFromHeaderRejection('From header must be equal to mailbox@example.com (or) you can use'),
    ).toBe(true);
    expect(isFromHeaderRejection('From header must end with @example.com')).toBe(true);
    expect(isFromHeaderRejection('Rate limit exceeded')).toBe(false);
  });
});
