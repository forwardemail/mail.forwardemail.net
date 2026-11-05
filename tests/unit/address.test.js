import { describe, it, expect } from 'vitest';
import PostalMime from 'postal-mime';
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

  it('recognizes nodemailer.from as a plain AddressObject (no value/text)', () => {
    const lower = { nodemailer: { from: { name: 'Alice', address: 'alice@x.com' } } };
    const upper = { nodemailer: { from: { Name: 'Bob', Address: 'bob@x.com' } } };
    const email = { nodemailer: { from: { email: 'carol@x.com' } } };
    expect(extractAddressList(lower, 'from')).toEqual([{ name: 'Alice', address: 'alice@x.com' }]);
    expect(extractAddressList(upper, 'from')).toEqual([{ Name: 'Bob', Address: 'bob@x.com' }]);
    expect(extractAddressList(email, 'from')).toEqual([{ email: 'carol@x.com' }]);
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

  it('decodes MIME-encoded display names in string headers', () => {
    expect(toDisplayAddress('=?UTF-8?Q?Foobar_H=C3=A4gerstr=C3=B6m?= <foobar@foo.se>')).toBe(
      'Foobar Hägerström <foobar@foo.se>',
    );
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

  it('decodes MIME-encoded object display names', () => {
    expect(
      toDisplayAddress({
        Display: '=?UTF-8?Q?Foobar_H=C3=A4gerstr=C3=B6m?=',
        Email: 'foobar@foo.se',
      }),
    ).toBe('Foobar Hägerström <foobar@foo.se>');
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

  // The reader's From is "Name <address>" as toDisplayAddress writes it, so a
  // display name holding an address of its own must not stand in for the
  // sender's (Block sender, image trust and the own-mail check read this).
  it('takes the address, not one written in the display name', () => {
    const from = toDisplayAddress({
      name: 'PayPal <service@paypal.example>',
      address: 'x@evil.test',
    });
    expect(normalizeEmail(from)).toBe('x@evil.test');
    expect(extractEmail(from)).toBe('x@evil.test');
    expect(normalizeEmail('"<Me@Example.org>" <X@Evil.test>')).toBe('x@evil.test');
    expect(normalizeEmail('Ann <ann@example.com> <>')).toBe('ann@example.com');
  });

  // Raw header values reach this too, so neither can a comment or quoted text
  // after the address.
  it('takes the address a mail parser takes, not one in a comment or quotes', async () => {
    for (const header of [
      '<a@x.test> (via <list@y.test>)',
      '<attacker@evil.test> (<trusted@bank.test>)',
      '<a@x.test> ("<list@y.test>")',
      'Ann (<b@y.test>) <ann@example.com>',
      'Ann <ann@example.com> (Ann)',
      '"Ann \\"<b@y.test>\\"" <ann@example.com>',
      '"Ann \\\\" <ann@example.com>',
      '"PayPal <service@paypal.example>" <x@evil.test>',
      '"<Me@Example.org>" <X@Evil.test>',
      'Ann <ann@example.com> <>',
      'Ann <<ann@example.com>',
      'Alice <alice@example.com>',
    ]) {
      const { from } = await PostalMime.parse(`From: ${header}\r\n\r\n`);
      expect(normalizeEmail(header), header).toBe(from.address.toLowerCase());
    }
    // Comments nest (RFC 5322), which this parser does not follow.
    expect(normalizeEmail('Ann (team (ops) <b@y.test>) <ann@example.com>')).toBe('ann@example.com');
  });
});

describe('addresses the app builds from a parsed From', () => {
  // The display name is stored unquoted, so a quote or parenthesis in it must
  // not hide the address that follows.
  it('takes the address after a name with an unclosed quote or parenthesis', () => {
    for (const name of [
      'PayPal <service@paypal.com> "',
      'PayPal <service@paypal.com> (',
      'Bob :(',
      'Screen 27" Deals',
    ]) {
      const from = toDisplayAddress({ name, address: 'x@evil.test' });
      expect(normalizeEmail(from), from).toBe('x@evil.test');
      expect(extractEmail(from), from).toBe('x@evil.test');
    }
  });

  it('takes the address when a quote in the name pairs with one in the address', () => {
    for (const [name, address] of [
      ['PayPal <service@paypal.com> "', '"a\\"b"@evil.test'],
      ['PayPal <service@paypal.com> (', '"a)\\""@evil.test'],
      ['"PayPal <service@paypal.com>', '"x"@evil.test'],
    ]) {
      const from = toDisplayAddress({ name, address });
      expect(normalizeEmail(from), from).not.toBe('service@paypal.com');
      expect(extractEmail(from), from).not.toBe('service@paypal.com');
    }
  });
});

describe('addresses with a quoted local part', () => {
  // A quoted local part can hold "<...>" or ">", so the address of a string
  // the app built is read from the end, skipping quoted text.
  it('reads a quoted local part that holds "<...>" as the address', () => {
    for (const address of [
      '"<me@example.com>"@evil.test',
      '"a>b"@evil.test',
      '"a <b@c.test>"@evil.test',
    ]) {
      for (const name of ['Boss', 'PayPal <service@paypal.example>', 'x "', '(']) {
        const from = toDisplayAddress({ name, address });
        expect(normalizeEmail(from), from).toBe(address.toLowerCase());
        expect(extractEmail(from), from).toBe(address.toLowerCase());
      }
    }
  });

  it('takes the address a mail parser takes when a stray ">" ends the header', async () => {
    for (const header of ['<a@x.test> "<b@y.test>">', 'Ann <ann@example.com> ("<b@y.test>")>']) {
      const { from } = await PostalMime.parse(`From: ${header}\r\n\r\n`);
      expect(normalizeEmail(header), header).toBe(from.address.toLowerCase());
    }
  });
});

describe('lists with a name the app stored unquoted', () => {
  it('splits after a name with a quote that never closes', () => {
    expect(recipientsToList('Screen 27" Deals <deals@x.test>, User <user@example.com>')).toEqual([
      'Screen 27" Deals <deals@x.test>',
      'User <user@example.com>',
    ]);
    expect(recipientsToList('"Doe, J" <j@x.test>, k@x.test')).toEqual([
      '"Doe, J" <j@x.test>',
      'k@x.test',
    ]);
  });

  it('checks a long address in linear time', () => {
    const long = 'a@' + 'b.'.repeat(200000) + '@x';
    const start = performance.now();
    expect(isValidEmail(long)).toBe(false);
    expect(isValidEmail('a@' + 'b.'.repeat(200000) + 'x')).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
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

  it('decodes MIME-encoded display names', () => {
    expect(extractDisplayName('=?UTF-8?Q?Foobar_H=C3=A4gerstr=C3=B6m?= <foobar@foo.se>')).toBe(
      'Foobar Hägerström',
    );
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

  it('returns empty string for null/undefined', () => {
    expect(extractDisplayName(null)).toBe('');
    expect(extractDisplayName(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(extractDisplayName('')).toBe('');
    expect(extractDisplayName([])).toBe('');
    expect(extractDisplayName({})).toBe('');
  });

  it('falls back to Sender: header when From: is absent', () => {
    const msg = {
      nodemailer: {
        headers: { sender: 'Bot <bot@example.com>' },
      },
    };
    expect(extractAddressList(msg, 'from')).toEqual(['Bot <bot@example.com>']);
  });

  it('does not fall back to Sender for non-from fields', () => {
    const msg = {
      nodemailer: { headers: { sender: 'Bot <bot@example.com>' } },
    };
    expect(extractAddressList(msg, 'to')).toEqual([]);
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

describe('address parsing of hostile headers', () => {
  // the regular expressions the linear scans replace, for comparison
  const previousDisplayName = (value) => {
    const raw = value.trim();
    if (!raw) return '';
    const match = raw.match(/^["']?([^"'<]+)["']?\s*<(.+)>$/);
    if (match) return match[1].trim() || match[2].trim();
    return raw.trim();
  };
  // The address is the last "<...>" (it used to be the first, which a display
  // name could supply)
  const previousNormalize = (raw) => {
    if (!raw) return '';
    const match = [...raw.matchAll(/<([^<>]+)>/g)].pop();
    return (match ? match[1] : raw).trim().toLowerCase();
  };

  it('parses as the regular expressions do', () => {
    const alphabet = ['"', "'", '<', '>', ' ', 'a', 'B', '@', '\n', '\t'];
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 20000; i++) {
      let value = '';
      const length = Math.floor(random() * 14);
      for (let j = 0; j < length; j++) value += alphabet[Math.floor(random() * alphabet.length)];
      expect(extractDisplayName(value)).toBe(previousDisplayName(value));
      // The address scan skips quoted text, which the expression did not.
      if (!value.includes('"')) expect(normalizeEmail(value)).toBe(previousNormalize(value));
    }
  });

  it('handles long runs of spaces and angle brackets quickly', () => {
    const values = [
      `a${' '.repeat(40000)}x`,
      '<'.repeat(40000),
      `"${' '.repeat(40000)}`,
      `a ${'<'.repeat(40000)}>`,
    ];
    const start = performance.now();
    for (const value of values) {
      extractDisplayName(value);
      normalizeEmail(value);
    }
    expect(performance.now() - start).toBeLessThan(200);
  });
});
