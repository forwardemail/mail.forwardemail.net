import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPAM_REPORT_ADDRESS,
  base64EncodeUtf8,
  buildSpamReportEmail,
  formatAddressForReport,
  isValidReportAddress,
  resolveSpamReportAddress,
} from '../../src/utils/spam-report.js';

describe('resolveSpamReportAddress', () => {
  it('falls back to the default when unset', () => {
    expect(resolveSpamReportAddress('')).toBe(DEFAULT_SPAM_REPORT_ADDRESS);
    expect(resolveSpamReportAddress(null)).toBe(DEFAULT_SPAM_REPORT_ADDRESS);
    expect(resolveSpamReportAddress(undefined)).toBe(DEFAULT_SPAM_REPORT_ADDRESS);
  });

  it('falls back to the default when the stored value is not an email', () => {
    expect(resolveSpamReportAddress('not-an-email')).toBe(DEFAULT_SPAM_REPORT_ADDRESS);
    expect(resolveSpamReportAddress('foo@bar')).toBe(DEFAULT_SPAM_REPORT_ADDRESS);
  });

  it('uses a valid configured address', () => {
    expect(resolveSpamReportAddress(' spam@example.com ')).toBe('spam@example.com');
  });
});

describe('isValidReportAddress', () => {
  it('accepts plain addresses and rejects junk', () => {
    expect(isValidReportAddress('abuse@forwardemail.net')).toBe(true);
    expect(isValidReportAddress('a b@example.com')).toBe(false);
    expect(isValidReportAddress('')).toBe(false);
  });
});

describe('formatAddressForReport', () => {
  it('handles the common API from shapes', () => {
    expect(formatAddressForReport('Spammer <spam@example.com>')).toBe('Spammer <spam@example.com>');
    expect(formatAddressForReport({ name: 'Spammer', address: 'spam@example.com' })).toBe(
      'Spammer <spam@example.com>',
    );
    expect(formatAddressForReport({ email: 'spam@example.com' })).toBe('spam@example.com');
    expect(formatAddressForReport({ value: [{ address: 'spam@example.com' }] })).toBe(
      'spam@example.com',
    );
    expect(formatAddressForReport([{ address: 'a@b.co' }, { address: 'c@d.co' }])).toBe(
      'a@b.co, c@d.co',
    );
    expect(formatAddressForReport(null)).toBe('Unknown sender');
  });
});

describe('base64EncodeUtf8', () => {
  it('round-trips unicode content', () => {
    const text = 'Subject: héllo ✉️\r\n\r\nbody';
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(base64EncodeUtf8(text)), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(text);
  });

  it('handles large payloads without call-stack overflow', () => {
    const big = 'x'.repeat(300000);
    expect(base64EncodeUtf8(big).length).toBeGreaterThan(0);
  });
});

describe('buildSpamReportEmail', () => {
  const message = {
    subject: 'You won a prize',
    from: { name: 'Spammer', address: 'spam@example.com' },
    date: '2026-07-31T12:00:00Z',
  };

  it('attaches the raw message as original.eml when available', () => {
    const eml = 'From: spam@example.com\r\nSubject: You won a prize\r\n\r\nClick here';
    const payload = buildSpamReportEmail({
      reportAddress: '',
      fromAddress: 'me@example.com',
      message,
      eml,
      fallbackText: '',
    });

    expect(payload.to).toEqual([DEFAULT_SPAM_REPORT_ADDRESS]);
    expect(payload.from).toBe('me@example.com');
    expect(payload.subject).toBe('Fwd: You won a prize');
    expect(payload.save_sent).toBe(false);
    expect(payload.has_attachment).toBe(true);
    expect(payload.attachments).toHaveLength(1);
    const att = payload.attachments[0];
    expect(att.filename).toBe('original.eml');
    expect(att.contentType).toBe('message/rfc822');
    expect(att.encoding).toBe('base64');
    expect(atob(att.content)).toBe(eml);
    expect(payload.text).toContain('Spammer <spam@example.com>');
    expect(payload.text).toContain('attached as original.eml');
  });

  it('falls back to inline text when no raw source exists', () => {
    const payload = buildSpamReportEmail({
      reportAddress: 'abuse@corp.example',
      fromAddress: 'me@example.com',
      message,
      eml: null,
      fallbackText: 'Click here to claim',
    });

    expect(payload.to).toEqual(['abuse@corp.example']);
    expect(payload.attachments).toBeUndefined();
    expect(payload.has_attachment).toBeUndefined();
    expect(payload.text).toContain('Click here to claim');
    expect(payload.text).toContain('raw message was unavailable');
  });

  it('never saves a copy to the Sent folder', () => {
    const payload = buildSpamReportEmail({
      reportAddress: '',
      fromAddress: 'me@example.com',
      message: {},
      eml: 'raw',
      fallbackText: '',
    });
    expect(payload.save_sent).toBe(false);
    expect(payload.subject).toBe('Fwd: (No subject)');
  });
});
