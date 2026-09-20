/**
 * PGP/MIME structure. The server passes `raw` through untouched, so anything
 * malformed here goes out on the wire and is unreadable at the far end with no
 * second chance to fix it.
 */
import { describe, expect, it } from 'vitest';
import {
  buildInnerMime,
  buildPgpMimeMessage,
  encodeAddressList,
  encodeHeaderValue,
  makeBoundary,
  wrapBase64,
} from '../../src/utils/pgp-mime';

const decodeB64 = (value: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(value.replace(/\s+/g, '')), (c) => c.charCodeAt(0)),
  );

describe('encodeHeaderValue', () => {
  it('leaves plain ASCII alone', () => {
    expect(encodeHeaderValue('Invoice 42')).toBe('Invoice 42');
  });

  it('RFC 2047 encodes non-ASCII so it is not sent as raw bytes', () => {
    const out = encodeHeaderValue('Rückfrage');
    expect(out).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeB64(out.slice('=?UTF-8?B?'.length, -2))).toBe('Rückfrage');
  });

  it('encodes emoji, which are multi-byte and break naive header writers', () => {
    const out = encodeHeaderValue('ship it 🚀');
    expect(out).toMatch(/^=\?UTF-8\?B\?/);
  });
});

describe('encodeAddressList', () => {
  it('keeps a bare address untouched', () => {
    expect(encodeAddressList(['a@b.com'])).toBe('a@b.com');
  });

  it('encodes the display name but never the addr-spec', () => {
    const out = encodeAddressList(['Jörg <jorg@example.com>']);
    expect(out).toContain('<jorg@example.com>');
    expect(out).toMatch(/^=\?UTF-8\?B\?/);
  });

  it('joins several addresses with commas', () => {
    expect(encodeAddressList(['a@b.com', 'c@d.com'])).toBe('a@b.com, c@d.com');
  });

  it('keeps a display name containing specials quoted', () => {
    // Bare, "Doe, Jane <j@e.com>" parses as two mailboxes: "Doe" and
    // "Jane <j@e.com>". The comma is what forces the quotes.
    expect(encodeAddressList(['"Doe, Jane" <j@e.com>'])).toBe('"Doe, Jane" <j@e.com>');
    expect(encodeAddressList(['J. Doe <j@e.com>'])).toBe('"J. Doe" <j@e.com>');
  });

  it('leaves a plain display name unquoted', () => {
    expect(encodeAddressList(['Jane Doe <j@e.com>'])).toBe('Jane Doe <j@e.com>');
  });

  it('escapes a quote inside a quoted name rather than ending the string early', () => {
    expect(encodeAddressList(['Jane "JD" Doe, Esq <j@e.com>'])).toBe(
      '"Jane \\"JD\\" Doe, Esq" <j@e.com>',
    );
  });
});

describe('wrapBase64', () => {
  it('wraps at the 76 characters RFC 2045 allows', () => {
    const lines = wrapBase64('a'.repeat(200)).split('\r\n');
    expect(lines[0]).toHaveLength(76);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(76);
  });

  it('strips existing whitespace before rewrapping', () => {
    expect(wrapBase64('ab\ncd ef')).toBe('abcdef');
  });
});

describe('makeBoundary', () => {
  it('never repeats, so nested parts cannot collide', () => {
    const seen = new Set(Array.from({ length: 50 }, () => makeBoundary()));
    expect(seen.size).toBe(50);
  });
});

describe('buildInnerMime', () => {
  it('base64-encodes a text body so no line can imitate a boundary', () => {
    const out = buildInnerMime({ text: '--=_fe_boundary_lookalike' });
    expect(out).toContain('Content-Type: text/plain; charset=utf-8');
    expect(out).toContain('Content-Transfer-Encoding: base64');
    const body = out.split('\r\n\r\n')[1];
    expect(decodeB64(body)).toBe('--=_fe_boundary_lookalike');
  });

  it('round-trips non-ASCII bodies', () => {
    const out = buildInnerMime({ text: 'Grüße 🚀' });
    expect(decodeB64(out.split('\r\n\r\n')[1])).toBe('Grüße 🚀');
  });

  it('uses multipart/alternative when both bodies are present', () => {
    const out = buildInnerMime({ text: 'plain', html: '<p>rich</p>' });
    expect(out).toContain('multipart/alternative');
    expect(out).toContain('text/plain');
    expect(out).toContain('text/html');
    // Plain must come first: clients render the last part they understand.
    expect(out.indexOf('text/plain')).toBeLessThan(out.indexOf('text/html'));
  });

  it('emits a single part when only one body exists', () => {
    expect(buildInnerMime({ html: '<p>x</p>' })).not.toContain('multipart/alternative');
  });

  it('wraps in multipart/mixed when there are attachments', () => {
    const out = buildInnerMime({
      text: 'see attached',
      attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', content: 'AAAA' }],
    });
    expect(out).toContain('multipart/mixed');
    expect(out).toContain('Content-Disposition: attachment; filename="a.pdf"');
  });

  it('marks a cid attachment inline so an embedded image still resolves', () => {
    const out = buildInnerMime({
      html: '<img src="cid:logo">',
      attachments: [{ filename: 'l.png', contentType: 'image/png', content: 'AA', cid: 'logo' }],
    });
    expect(out).toContain('Content-ID: <logo>');
    expect(out).toContain('Content-Disposition: inline');
  });

  it('ignores attachments with no content rather than emitting an empty part', () => {
    const out = buildInnerMime({ text: 'x', attachments: [{ filename: 'ghost.pdf' }] });
    expect(out).not.toContain('multipart/mixed');
  });

  it('strips quotes from a filename so the header cannot be broken out of', () => {
    const out = buildInnerMime({
      text: 'x',
      attachments: [{ filename: 'a"; evil="1.pdf', content: 'AA' }],
    });
    expect(out).not.toContain('a"; evil="1.pdf');
  });
});

describe('buildPgpMimeMessage', () => {
  const armored = '-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----';
  const headers = {
    from: 'me@example.com',
    to: ['you@example.com'],
    subject: 'Hello',
    date: new Date('2026-01-02T03:04:05Z'),
  };

  it('declares the RFC 3156 content type and protocol', () => {
    const out = buildPgpMimeMessage(armored, headers);
    expect(out).toContain('Content-Type: multipart/encrypted;');
    expect(out).toContain('protocol="application/pgp-encrypted"');
  });

  it('emits the version part before the ciphertext part, as the RFC requires', () => {
    const out = buildPgpMimeMessage(armored, headers);
    const versionAt = out.indexOf('application/pgp-encrypted');
    const cipherAt = out.indexOf('application/octet-stream');
    expect(versionAt).toBeGreaterThan(-1);
    expect(cipherAt).toBeGreaterThan(versionAt);
    expect(out).toContain('Version: 1');
  });

  it('uses one boundary consistently and closes it', () => {
    const out = buildPgpMimeMessage(armored, headers);
    const boundary = out.match(/boundary="([^"]+)"/)?.[1];
    expect(boundary).toBeTruthy();
    expect(out).toContain(`--${boundary}--`);
    // Opening delimiters for the two parts, plus the closing one.
    expect(out.split(`--${boundary}`).length - 1).toBe(3);
  });

  it('uses CRLF line endings throughout', () => {
    const out = buildPgpMimeMessage(armored, headers);
    expect(out).toContain('\r\n');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('carries the ciphertext verbatim', () => {
    const out = buildPgpMimeMessage(armored, headers);
    expect(out).toContain('-----BEGIN PGP MESSAGE-----');
    expect(out).toContain('-----END PGP MESSAGE-----');
  });

  it('omits To and Cc headers that were not supplied', () => {
    const out = buildPgpMimeMessage(armored, { from: 'me@example.com', subject: 'x' });
    expect(out).not.toContain('\r\nTo:');
    expect(out).not.toContain('\r\nCc:');
  });

  it('includes threading headers for an encrypted reply', () => {
    const out = buildPgpMimeMessage(armored, {
      ...headers,
      inReplyTo: '<parent@example.com>',
      references: '<root@example.com> <parent@example.com>',
    });
    expect(out).toContain('In-Reply-To: <parent@example.com>');
    expect(out).toContain('References: <root@example.com> <parent@example.com>');
  });

  it('carries Reply-To so replies do not fall back to From', () => {
    const out = buildPgpMimeMessage(armored, { ...headers, replyTo: 'support@example.com' });
    expect(out).toContain('Reply-To: support@example.com');
  });

  it('omits Reply-To when none was set', () => {
    expect(buildPgpMimeMessage(armored, headers)).not.toContain('Reply-To:');
  });

  it('encodes a non-ASCII subject rather than emitting raw bytes', () => {
    const out = buildPgpMimeMessage(armored, { ...headers, subject: 'Grüße' });
    expect(out).toContain('Subject: =?UTF-8?B?');
  });

  it('leaves a readable note for clients that cannot decrypt', () => {
    expect(buildPgpMimeMessage(armored, headers)).toMatch(/OpenPGP\/MIME encrypted message/i);
  });
});
