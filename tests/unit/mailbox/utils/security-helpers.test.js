import { describe, it, expect } from 'vitest';
import {
  getMailedBy,
  getSignedBy,
  getSecurityParts,
} from '../../../../src/svelte/mailbox/utils/security-helpers';

describe('security-helpers', () => {
  describe('getMailedBy', () => {
    it('extracts domain from received header', () => {
      const msg = {
        nodemailer: {
          headers: {
            received: 'from mail.example.com by mx.google.com with SMTP id abc123',
          },
        },
      };

      const result = getMailedBy(msg);

      expect(result).toBe('mx.google.com');
    });

    it('handles array of received headers', () => {
      const msg = {
        nodemailer: {
          headers: {
            received: [
              'from mail.example.com by mx.google.com with SMTP',
              'from another.com by relay.example.com',
            ],
          },
        },
      };

      const result = getMailedBy(msg);

      expect(result).toBe('mx.google.com');
    });

    it('falls back to DKIM signature domain', () => {
      const msg = {
        nodemailer: {
          headers: {
            'dkim-signature': {
              params: {
                d: 'example.com',
              },
            },
          },
        },
      };

      const result = getMailedBy(msg);

      expect(result).toBe('example.com');
    });

    it('returns null for message without headers', () => {
      expect(getMailedBy({})).toBeNull();
      expect(getMailedBy(null)).toBeNull();
    });

    it('returns null when no relevant headers found', () => {
      const msg = {
        nodemailer: {
          headers: {},
        },
      };

      expect(getMailedBy(msg)).toBeNull();
    });
  });

  describe('getSignedBy', () => {
    it('extracts DKIM signature domain', () => {
      const msg = {
        nodemailer: {
          headers: {
            'dkim-signature': {
              params: {
                d: 'example.com',
              },
            },
          },
        },
      };

      const result = getSignedBy(msg);

      expect(result).toBe('example.com');
    });

    it('returns null for message without DKIM', () => {
      const msg = {
        nodemailer: {
          headers: {},
        },
      };

      expect(getSignedBy(msg)).toBeNull();
    });

    it('returns null for message without headers', () => {
      expect(getSignedBy({})).toBeNull();
      expect(getSignedBy(null)).toBeNull();
    });
  });

  describe('getSecurityParts', () => {
    // A message as the API returns it: parsed headers plus the header lines
    // as they were received, newest first.
    const message = (lines, headers = {}) => ({
      nodemailer: {
        headers,
        headerLines: lines.map(([key, value]) => ({
          key: key.toLowerCase(),
          line: `${key}: ${value}`,
        })),
      },
    });
    const tones = (msg) =>
      Object.fromEntries(getSecurityParts(msg).map((part) => [part.label, part.tone]));
    const texts = (msg) => getSecurityParts(msg).map((part) => part.text);

    it('shows each result in its own tone, so a DKIM failure is not green', () => {
      // mail.forwardemail.net issue #150
      const msg = message([
        [
          'Authentication-Results',
          'mx1.forwardemail.net; dkim=fail header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=none header.from=example.com',
        ],
      ]);

      expect(texts(msg)).toEqual(['SPF: Pass', 'DKIM: Fail', 'DMARC: None']);
      expect(tones(msg)).toEqual({ SPF: 'pass', DKIM: 'fail', DMARC: 'caution' });
    });

    it('treats a soft fail or a lookup error as a caution, and a permanent error as a failure', () => {
      const msg = message([
        [
          'Authentication-Results',
          'mx2.forwardemail.net; spf=softfail; dkim=permerror; dmarc=temperror',
        ],
      ]);

      expect(tones(msg)).toEqual({ SPF: 'caution', DKIM: 'fail', DMARC: 'caution' });
    });

    it('does not believe results a sender wrote under another server name', () => {
      const msg = message(
        [
          ['Authentication-Results', 'mx.evil.test; spf=pass; dkim=pass; dmarc=pass'],
          ['ARC-Authentication-Results', 'i=1; forwardemail.net.evil.test; dmarc=pass'],
          ['Authentication-Results', 'mx1.forwardemail.net; spf=fail; dkim=none; dmarc=fail'],
        ],
        // what the parser makes of the first header, which used to be shown
        { 'authentication-results': 'mx.evil.test; spf=pass; dkim=pass; dmarc=pass' },
      );

      expect(texts(msg)).toEqual(['SPF: Fail', 'DKIM: None', 'DMARC: Fail']);
    });

    it('shows no results when the server recorded none, whatever the sender claims', () => {
      const msg = message(
        [['Authentication-Results', 'mx.evil.test; spf=pass; dkim=pass; dmarc=pass']],
        { 'authentication-results': 'mx.evil.test; spf=pass; dkim=pass; dmarc=pass' },
      );

      expect(getSecurityParts(msg)).toEqual([]);
    });

    it('reads the server verdict from an ARC header', () => {
      const msg = message([
        [
          'ARC-Authentication-Results',
          'i=1; mx1.forwardemail.net; dkim=pass header.d=example.com; spf=pass; dmarc=pass',
        ],
      ]);

      expect(tones(msg)).toEqual({ SPF: 'pass', DKIM: 'pass', DMARC: 'pass' });
    });

    it('counts a message as signed when one of several DKIM signatures verifies', () => {
      const msg = message([
        [
          'Authentication-Results',
          'mx1.forwardemail.net; dkim=fail header.d=list.example; dkim=pass header.d=example.com',
        ],
      ]);

      expect(texts(msg)).toEqual(['DKIM: Pass']);
    });

    it('says a message is signed, without a colour, when there is no verdict on it', () => {
      const msg = message([], { 'dkim-signature': 'v=1; d=example.com; s=key' });

      expect(getSecurityParts(msg)).toEqual([
        { label: 'DKIM', text: 'DKIM: Signed', tone: 'neutral' },
      ]);
    });

    it('names the TLS version from the Received header, in the plain tone', () => {
      const msg = message([], {
        received: ['by mx1.forwardemail.net with ESMTPS (version=TLSv1.3 cipher=TLS_AES_256)'],
      });

      expect(getSecurityParts(msg)).toEqual([
        { label: 'Encryption', text: 'Standard encryption (TLSv1.3)', tone: 'neutral' },
      ]);
    });

    it('has nothing to show for a message without headers', () => {
      expect(getSecurityParts({})).toEqual([]);
      expect(getSecurityParts(null)).toEqual([]);
    });
  });
});
