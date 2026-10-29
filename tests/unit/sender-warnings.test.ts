import { describe, expect, it } from 'vitest';
import { getSenderWarnings, trustedAuthResults } from '../../src/utils/sender-warnings';

const message = ({
  name = '',
  address = 'news@example.com',
  auth = [] as [string, string][],
} = {}) => ({
  from: name ? `"${name}" <${address}>` : address,
  nodemailer: {
    headers: { from: { value: [{ name, address }] } },
    headerLines: auth.map(([key, value]) => ({ key, line: `${key}: ${value}` })),
  },
});

const kinds = (m: unknown) =>
  getSenderWarnings(m as Parameters<typeof getSenderWarnings>[0]).map((w) => w.kind);

describe('getSenderWarnings', () => {
  it('says nothing about an ordinary message', () => {
    expect(kinds(message({ name: 'Example News' }))).toEqual([]);
    expect(kinds(null)).toEqual([]);
    expect(kinds({ from: 'someone@example.com' })).toEqual([]);
  });

  it('flags a display name showing another domain’s address', () => {
    const m = message({ name: 'PayPal <service@paypal.com>', address: 'x@evil.test' });
    const warnings = getSenderWarnings(m);
    expect(warnings.map((w) => w.kind)).toEqual(['display-name']);
    expect(warnings[0].message).toContain('service@paypal.com');
    expect(warnings[0].message).toContain('x@evil.test');
  });

  it('accepts an address in the name on the same domain or a subdomain', () => {
    expect(kinds(message({ name: 'help@example.com', address: 'help@example.com' }))).toEqual([]);
    expect(
      kinds(message({ name: 'jane@mail.example.com', address: 'bounce@example.com' })),
    ).toEqual([]);
  });

  it('accepts the "via" rewrite mailing lists use', () => {
    expect(
      kinds(message({ name: 'jane@example.org via Team', address: 'team@googlegroups.com' })),
    ).toEqual([]);
  });

  it('believes a DMARC failure only from Forward Email’s own servers', () => {
    const own = message({
      auth: [['authentication-results', 'mx1.forwardemail.net; dkim=none; spf=fail; dmarc=fail']],
    });
    expect(kinds(own)).toEqual(['dmarc-fail']);

    const arc = message({
      auth: [['arc-authentication-results', 'i=1; mx2.forwardemail.net; dmarc=fail header.from=x']],
    });
    expect(kinds(arc)).toEqual(['dmarc-fail']);

    // Written by the sender or a third party: not believed either way
    const forged = message({
      auth: [
        ['authentication-results', 'mx.evil.test; dmarc=fail'],
        ['authentication-results', 'forwardemail.net.evil.test; dmarc=fail'],
      ],
    });
    expect(kinds(forged)).toEqual([]);

    expect(
      kinds(message({ auth: [['authentication-results', 'mx1.forwardemail.net; dmarc=pass']] })),
    ).toEqual([]);
  });

  it('flags an internationalized sender domain', () => {
    expect(kinds(message({ address: 'service@xn--pypal-4ve.com' }))).toEqual(['idn-domain']);
  });
});

describe('trustedAuthResults', () => {
  it('keeps only headers whose authserv-id is forwardemail.net or a subdomain', () => {
    expect(
      trustedAuthResults([
        { key: 'authentication-results', line: 'Authentication-Results: forwardemail.net; a' },
        { key: 'authentication-results', line: 'Authentication-Results: mx1.forwardemail.net; b' },
        { key: 'authentication-results', line: 'Authentication-Results: notforwardemail.net; c' },
        { key: 'received', line: 'Received: from mx1.forwardemail.net' },
      ]),
    ).toEqual(['forwardemail.net; a', 'mx1.forwardemail.net; b']);
  });
});
