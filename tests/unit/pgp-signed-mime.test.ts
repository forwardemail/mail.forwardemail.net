// @vitest-environment node
/**
 * Sign-only sending and key generation, against real openpgp.
 *
 * The part that is easy to get wrong in RFC 3156 is which bytes the signature
 * covers: the first body part exactly as it sits between the boundaries, with
 * CRLF line endings. These tests take the finished message apart the way a
 * receiver does and check the signature over that slice, so a builder that
 * adds or drops a single CRLF fails here.
 */
import { describe, expect, it } from 'vitest';
import * as openpgp from 'openpgp';
import { buildInnerMime, buildPgpSignedMessage } from '../../src/utils/pgp-mime';
import { generatePgpKeyPair, MIN_PASSPHRASE_LENGTH } from '../../src/utils/pgp-keygen';

const PASSPHRASE = 'correct horse battery';

// What sync.worker.ts handleSignMessageTask does with the entity
async function signDetached(entity: string, armoredPrivateKey: string, passphrase: string) {
  const privateKey = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey }),
    passphrase,
  });
  const canonical = entity.replace(/\r?\n/g, '\r\n');
  const message = await openpgp.createMessage({ binary: new TextEncoder().encode(canonical) });
  const signature = await openpgp.sign({
    message,
    signingKeys: privateKey,
    detached: true,
    format: 'armored',
  });
  const parsed = await openpgp.readSignature({ armoredSignature: signature });
  const hash = openpgp.enums.read(openpgp.enums.hash, parsed.packets[0].hashAlgorithm);
  return { signature, micalg: `pgp-${String(hash).toLowerCase()}` };
}

// A receiver's view: the signed bytes and the signature, cut out of the raw message
function splitSigned(raw: string) {
  const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
  if (!boundary) throw new Error('no boundary');
  const delimiter = `\r\n--${boundary}`;
  const first = raw.indexOf(`--${boundary}\r\n`);
  const start = first + `--${boundary}\r\n`.length;
  const end = raw.indexOf(delimiter, start);
  const signedBytes = raw.slice(start, end);
  const sigPart = raw.slice(end + delimiter.length);
  const armored = sigPart.match(
    /-----BEGIN PGP SIGNATURE-----[\s\S]+?-----END PGP SIGNATURE-----/,
  )?.[0];
  return { signedBytes, armored: armored || '' };
}

describe('generatePgpKeyPair', () => {
  it('makes a v4 Curve25519 key for the address, locked with the passphrase', async () => {
    const pair = await generatePgpKeyPair({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      passphrase: PASSPHRASE,
    });
    const priv = await openpgp.readPrivateKey({ armoredKey: pair.privateKey });
    expect(priv.isDecrypted()).toBe(false);
    expect(priv.keyPacket.version).toBe(4);
    expect(priv.getUserIDs()).toEqual(['Ada Lovelace <ada@example.com>']);
    expect(pair.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(pair.publicKey).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    expect(pair.publicKey).not.toContain('PRIVATE');
    expect(pair.revocationCertificate).toContain('BEGIN PGP PUBLIC KEY BLOCK');
    await expect(
      openpgp.decryptKey({ privateKey: priv, passphrase: 'wrong passphrase' }),
    ).rejects.toThrow();
  }, 30_000);

  it('refuses a short passphrase or a missing address', async () => {
    await expect(
      generatePgpKeyPair({
        email: 'a@example.com',
        passphrase: 'x'.repeat(MIN_PASSPHRASE_LENGTH - 1),
      }),
    ).rejects.toThrow(/passphrase/);
    await expect(generatePgpKeyPair({ email: 'nobody', passphrase: PASSPHRASE })).rejects.toThrow(
      /address/,
    );
  });
});

describe('buildPgpSignedMessage', () => {
  it('produces a message whose signature checks out over the signed part', async () => {
    const pair = await generatePgpKeyPair({ email: 'ada@example.com', passphrase: PASSPHRASE });
    const entity = buildInnerMime({
      text: 'Hello,\nsee attached.\n',
      html: '<p>Hello,<br>see attached.</p>',
      attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: btoa('notes') }],
    });
    const { signature, micalg } = await signDetached(entity, pair.privateKey, PASSPHRASE);

    const raw = buildPgpSignedMessage(entity, signature, micalg, {
      from: 'Ada <ada@example.com>',
      to: ['bob@example.com'],
      subject: 'Signed',
    });

    expect(raw).toMatch(
      /Content-Type: multipart\/signed; micalg="pgp-sha\d+"; protocol="application\/pgp-signature"/,
    );
    expect(raw).not.toMatch(/[^\r]\n/);

    const { signedBytes, armored } = splitSigned(raw);
    expect(signedBytes).toBe(entity.replace(/\r?\n/g, '\r\n'));

    const verification = await openpgp.verify({
      message: await openpgp.createMessage({ binary: new TextEncoder().encode(signedBytes) }),
      signature: await openpgp.readSignature({ armoredSignature: armored }),
      verificationKeys: await openpgp.readKey({ armoredKey: pair.publicKey }),
    });
    await expect(verification.signatures[0].verified).resolves.toBe(true);
  }, 30_000);

  it('fails verification when the signed part is altered in transit', async () => {
    const pair = await generatePgpKeyPair({ email: 'ada@example.com', passphrase: PASSPHRASE });
    const entity = buildInnerMime({ text: 'Pay 10 EUR' });
    const { signature, micalg } = await signDetached(entity, pair.privateKey, PASSPHRASE);
    const raw = buildPgpSignedMessage(entity, signature, micalg, { from: 'ada@example.com' });
    const { signedBytes, armored } = splitSigned(raw);
    const tampered = signedBytes.replace(btoa('Pay 10 EUR'), btoa('Pay 99 EUR'));
    expect(tampered).not.toBe(signedBytes);

    const verification = await openpgp.verify({
      message: await openpgp.createMessage({ binary: new TextEncoder().encode(tampered) }),
      signature: await openpgp.readSignature({ armoredSignature: armored }),
      verificationKeys: await openpgp.readKey({ armoredKey: pair.publicKey }),
    });
    await expect(verification.signatures[0].verified).rejects.toThrow();
  }, 30_000);

  it('keeps a hostile micalg out of the header', () => {
    const raw = buildPgpSignedMessage(
      'Content-Type: text/plain\r\n\r\nhi',
      'sig',
      'x"\r\nBcc: e@x',
      {
        from: 'a@example.com',
      },
    );
    expect(raw).toContain('micalg="pgp-sha256"');
    expect(raw).not.toContain('Bcc:');
  });
});
