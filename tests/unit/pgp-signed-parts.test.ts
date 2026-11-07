import { describe, expect, it } from 'vitest';
import {
  isPgpSignedContentType,
  isPgpSignedNodemailer,
  splitSignedMime,
} from '../../src/utils/pgp-signed-parts';

const SIG = '-----BEGIN PGP SIGNATURE-----\r\n\r\nabc\r\n-----END PGP SIGNATURE-----';

const raw = (contentType: string, part: string) =>
  [
    'From: a@example.com',
    contentType,
    '',
    'preamble',
    '--b1',
    part,
    '--b1',
    'Content-Type: application/pgp-signature',
    '',
    SIG,
    '--b1--',
    '',
  ].join('\r\n');

describe('splitSignedMime', () => {
  it('cuts out the signed part byte for byte, headers included', () => {
    const part = 'Content-Type: text/plain\r\n\r\nline one  \r\nline two';
    const parts = splitSignedMime(
      raw(
        'Content-Type: multipart/signed; micalg=pgp-sha256;\r\n protocol="application/pgp-signature"; boundary="b1"',
        part,
      ),
    );
    expect(parts?.signed).toBe(part);
    expect(parts?.signature).toBe(SIG);
  });

  it('returns null for anything else', () => {
    expect(splitSignedMime(raw('Content-Type: multipart/mixed; boundary="b1"', 'x'))).toBeNull();
    expect(
      splitSignedMime(
        raw(
          'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary="b1"',
          'x',
        ),
      ),
    ).toBeNull();
    expect(splitSignedMime('no headers at all')).toBeNull();
    expect(splitSignedMime('')).toBeNull();
  });

  //
  // A signed part + signature covers exactly two parts (RFC 3156). The body
  // the reader sees is produced by a full MIME parse of the whole message, so
  // any construction where that parse can pick up bytes outside the single
  // signed part must not be reported as signed — otherwise the signer's
  // identity would be shown over content they never signed.
  //
  const ct = (extra = '') =>
    `Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="b1"${extra}`;
  const signedPart = 'Content-Type: text/plain\r\n\r\nthe real message';
  const sigPart = ['Content-Type: application/pgp-signature', '', SIG].join('\r\n');
  const injected = 'Content-Type: text/html\r\n\r\n<p>attacker content</p>';

  it('rejects a third body part after the signature', () => {
    const forged = [
      'From: a@example.com',
      ct(),
      '',
      '--b1',
      signedPart,
      '--b1',
      sigPart,
      '--b1',
      injected,
      '--b1--',
      '',
    ].join('\r\n');
    expect(splitSignedMime(forged)).toBeNull();
  });

  it('rejects a duplicated boundary= parameter', () => {
    const forged = [
      'From: a@example.com',
      `${ct()}; boundary="b2"`,
      '',
      '--b1',
      signedPart,
      '--b1',
      sigPart,
      '--b1--',
      '--b2',
      injected,
      '--b2--',
      '',
    ].join('\r\n');
    expect(splitSignedMime(forged)).toBeNull();
  });

  it('rejects a duplicated top-level Content-Type header', () => {
    const forged = [
      'From: a@example.com',
      ct(),
      'Content-Type: multipart/mixed; boundary="b2"',
      '',
      '--b1',
      signedPart,
      '--b1',
      sigPart,
      '--b1--',
      '--b2',
      injected,
      '--b2--',
      '',
    ].join('\r\n');
    expect(splitSignedMime(forged)).toBeNull();
  });

  it('still accepts a well-formed two-part message', () => {
    const ok = [
      'From: a@example.com',
      ct(),
      '',
      '--b1',
      signedPart,
      '--b1',
      sigPart,
      '--b1--',
      '',
    ].join('\r\n');
    const parts = splitSignedMime(ok);
    expect(parts?.signed).toBe(signedPart);
    expect(parts?.signature).toBe(SIG);
  });
});

describe('isPgpSignedNodemailer', () => {
  it('reads the raw content-type line', () => {
    expect(
      isPgpSignedNodemailer({
        headerLines: [
          {
            key: 'content-type',
            line: 'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary=x',
          },
        ],
      }),
    ).toBe(true);
  });

  it('falls back to the parsed header', () => {
    expect(
      isPgpSignedNodemailer({
        headers: {
          'content-type': {
            value: 'multipart/signed',
            params: { protocol: 'application/pgp-signature', boundary: 'x' },
          },
        },
      }),
    ).toBe(true);
    expect(isPgpSignedNodemailer({ headers: { 'content-type': { value: 'text/html' } } })).toBe(
      false,
    );
    expect(isPgpSignedNodemailer(null)).toBe(false);
  });

  it('agrees with isPgpSignedContentType on S/MIME', () => {
    expect(isPgpSignedContentType('multipart/signed; protocol="application/pkcs7-signature"')).toBe(
      false,
    );
  });
});
