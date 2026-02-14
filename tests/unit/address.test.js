import { describe, it, expect } from 'vitest';
import {
  recipientsToList,
  extractAddressList,
  getReplyToList,
  toDisplayAddress,
  displayAddresses,
  extractEmail,
  normalizeEmail,
  dedupeAddresses,
  extractDisplayName,
  isValidEmail,
} from '../../src/utils/address.ts';

describe('recipientsToList', () => {
  it('returns empty array for null/undefined', () => {
    expect(recipientsToList(null)).toEqual([]);
    expect(recipientsToList(undefined)).toEqual([]);
    expect(recipientsToList('')).toEqual([]);
  });

  it('wraps a string in an array', () => {
    expect(recipientsToList('alice@example.com')).toEqual(['alice@example.com']);
  });

  it('wraps an object in an array', () => {
    const addr = { name: 'Alice', address: 'alice@example.com' };
    expect(recipientsToList(addr)).toEqual([addr]);
  });

  it('passes through arrays and filters falsy', () => {
    const list = [{ address: 'a@b.com' }, null, { address: 'c@d.com' }];
    expect(recipientsToList(list)).toHaveLength(2);
  });
});

describe('extractAddressList', () => {
  it('returns empty array for null message', () => {
    expect(extractAddressList(null, 'from')).toEqual([]);
    expect(extractAddressList(undefined, 'from')).toEqual([]);
  });

  it('extracts from nodemailer value array', () => {
    const msg = {
      nodemailer: {
        from: { value: [{ name: 'Alice', address: 'alice@x.com' }] },
      },
    };
    const result = extractAddressList(msg, 'from');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: 'Alice', address: 'alice@x.com' });
  });

  it('extracts from nodemailer text field', () => {
    const msg = {
      nodemailer: {
        from: { text: 'Alice <alice@x.com>' },
      },
    };
    const result = extractAddressList(msg, 'from');
    expect(result).toEqual(['Alice <alice@x.com>']);
  });

  it('extracts from headers object', () => {
    const msg = {
      nodemailer: {
        headers: { from: 'bob@example.com' },
      },
    };
    const result = extractAddressList(msg, 'from');
    expect(result).toEqual(['bob@example.com']);
  });

  it('extracts from raw headers string', () => {
    const msg = {
      raw: 'From: carol@example.com\r\nTo: dave@example.com',
    };
    const result = extractAddressList(msg, 'from');
    expect(result).toEqual(['carol@example.com']);
  });

  it('extracts from envelope for from field', () => {
    const msg = {
      nodemailer: {
        envelope: { from: 'env@example.com', to: ['r1@x.com', 'r2@x.com'] },
      },
    };
    expect(extractAddressList(msg, 'from')).toEqual(['env@example.com']);
    expect(extractAddressList(msg, 'to')).toEqual(['r1@x.com', 'r2@x.com']);
  });

  it('falls back to direct message fields', () => {
    const msg = { from: 'direct@example.com' };
    expect(extractAddressList(msg, 'from')).toEqual(['direct@example.com']);
  });

  it('falls back to capitalized direct fields', () => {
    const msg = { From: 'Direct@example.com' };
    expect(extractAddressList(msg, 'from')).toEqual(['Direct@example.com']);
  });

  it('handles headerLines format', () => {
    const msg = {
      headerLines: [{ key: 'from', line: 'From: headerline@x.com' }],
    };
    expect(extractAddressList(msg, 'from')).toEqual(['headerline@x.com']);
  });
});

describe('getReplyToList', () => {
  it('extracts replyTo field', () => {
    const msg = { replyTo: 'reply@example.com' };
    expect(getReplyToList(msg)).toEqual(['reply@example.com']);
  });

  it('falls back to reply_to', () => {
    const msg = { reply_to: 'reply2@example.com' };
    expect(getReplyToList(msg)).toEqual(['reply2@example.com']);
  });

  it('returns empty for no reply-to', () => {
    expect(getReplyToList({})).toEqual([]);
    expect(getReplyToList(null)).toEqual([]);
  });
});

describe('toDisplayAddress', () => {
  it('returns empty for null/undefined', () => {
    expect(toDisplayAddress(null)).toBe('');
    expect(toDisplayAddress(undefined)).toBe('');
  });

  it('returns string as-is', () => {
    expect(toDisplayAddress('alice@example.com')).toBe('alice@example.com');
  });

  it('formats name + address object', () => {
    expect(toDisplayAddress({ name: 'Alice', address: 'alice@x.com' })).toBe('Alice <alice@x.com>');
  });

  it('returns just name when no address', () => {
    expect(toDisplayAddress({ name: 'Alice' })).toBe('Alice');
  });

  it('returns just address when no name', () => {
    expect(toDisplayAddress({ address: 'alice@x.com' })).toBe('alice@x.com');
  });

  it('handles Display/Email capitalization', () => {
    expect(toDisplayAddress({ Display: 'Bob', Email: 'bob@x.com' })).toBe('Bob <bob@x.com>');
  });

  it('unwraps first element of array', () => {
    expect(toDisplayAddress([{ name: 'Carol', address: 'c@x.com' }])).toBe('Carol <c@x.com>');
  });

  it('unwraps value array', () => {
    expect(toDisplayAddress({ value: [{ name: 'Dave', address: 'd@x.com' }] })).toBe(
      'Dave <d@x.com>',
    );
  });
});

describe('displayAddresses', () => {
  it('maps list of mixed types to display strings', () => {
    const list = ['alice@x.com', { name: 'Bob', address: 'bob@x.com' }];
    expect(displayAddresses(list)).toEqual(['alice@x.com', 'Bob <bob@x.com>']);
  });

  it('returns empty array for null', () => {
    expect(displayAddresses(null)).toEqual([]);
    expect(displayAddresses(undefined)).toEqual([]);
  });
});

describe('extractEmail', () => {
  it('extracts email from angle bracket format', () => {
    expect(extractEmail('Alice <alice@example.com>')).toBe('alice@example.com');
  });

  it('normalizes plain email', () => {
    expect(extractEmail('BOB@Example.COM')).toBe('bob@example.com');
  });

  it('extracts from object', () => {
    expect(extractEmail({ email: 'carol@x.com' })).toBe('carol@x.com');
    expect(extractEmail({ Email: 'Dave@X.com' })).toBe('dave@x.com');
    expect(extractEmail({ address: 'eve@x.com' })).toBe('eve@x.com');
  });

  it('extracts from array (first match)', () => {
    expect(extractEmail([{ email: 'first@x.com' }, { email: 'second@x.com' }])).toBe('first@x.com');
  });

  it('returns empty for null/undefined', () => {
    expect(extractEmail(null)).toBe('');
    expect(extractEmail(undefined)).toBe('');
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
  });

  it('extracts from angle brackets', () => {
    expect(normalizeEmail('Alice <alice@example.com>')).toBe('alice@example.com');
  });

  it('extracts from object fields', () => {
    expect(normalizeEmail({ email: 'A@B.com' })).toBe('a@b.com');
    expect(normalizeEmail({ address: 'C@D.com' })).toBe('c@d.com');
    expect(normalizeEmail({ value: 'E@F.com' })).toBe('e@f.com');
  });

  it('handles arrays recursively', () => {
    expect(normalizeEmail(['X@Y.com'])).toBe('x@y.com');
  });

  it('returns empty for null/undefined', () => {
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail('')).toBe('');
  });
});

describe('dedupeAddresses', () => {
  it('removes duplicate emails', () => {
    const list = ['alice@x.com', 'Alice <alice@x.com>', 'bob@x.com'];
    const result = dedupeAddresses(list);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('alice@x.com');
    expect(result[1]).toBe('bob@x.com');
  });

  it('handles mixed object and string entries', () => {
    const list = [{ name: 'Alice', address: 'alice@x.com' }, 'alice@x.com'];
    const result = dedupeAddresses(list);
    expect(result).toHaveLength(1);
  });

  it('returns empty for empty input', () => {
    expect(dedupeAddresses([])).toEqual([]);
  });
});

describe('extractDisplayName', () => {
  it('extracts name from "Name <email>" format', () => {
    expect(extractDisplayName('Shaun Warman <shaun@example.com>')).toBe('Shaun Warman');
  });

  it('extracts name from quoted format', () => {
    expect(extractDisplayName('"John Doe" <john@example.com>')).toBe('John Doe');
  });

  it('returns raw string when only angle-bracketed email', () => {
    // No name part before <>, regex doesn't match, returns as-is
    expect(extractDisplayName('<alice@example.com>')).toBe('<alice@example.com>');
  });

  it('returns plain email as-is', () => {
    expect(extractDisplayName('bob@example.com')).toBe('bob@example.com');
  });

  it('handles AddressObject with Display/Email', () => {
    expect(extractDisplayName({ Display: 'Carol', Email: 'carol@x.com' })).toBe('Carol');
  });

  it('handles AddressObject with name/address', () => {
    expect(extractDisplayName({ name: 'Dave', address: 'dave@x.com' })).toBe('Dave');
  });

  it('handles AddressObject with Name/Address', () => {
    expect(extractDisplayName({ Name: 'Eve', Address: 'eve@x.com' })).toBe('Eve');
  });

  it('handles array of address objects', () => {
    expect(extractDisplayName([{ name: 'First', address: 'first@x.com' }])).toBe('First');
  });

  it('returns "Unknown sender" for null/undefined', () => {
    expect(extractDisplayName(null)).toBe('Unknown sender');
    expect(extractDisplayName(undefined)).toBe('Unknown sender');
  });

  it('returns "Unknown sender" for empty string', () => {
    expect(extractDisplayName('')).toBe('Unknown sender');
  });
});

describe('isValidEmail', () => {
  it('validates standard email addresses', () => {
    expect(isValidEmail('alice@example.com')).toBe(true);
    expect(isValidEmail('user+tag@domain.co.uk')).toBe(true);
    expect(isValidEmail('test.name@subdomain.example.com')).toBe(true);
  });

  it('extracts from angle brackets before validating', () => {
    expect(isValidEmail('Alice <alice@example.com>')).toBe(true);
  });

  it('rejects invalid emails', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('@missing-user.com')).toBe(false);
    expect(isValidEmail('missing-domain@')).toBe(false);
    expect(isValidEmail('no-tld@domain')).toBe(false);
  });

  it('rejects null/undefined/empty', () => {
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});
