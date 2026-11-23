/**
 * Signing outgoing mail with a key on a YubiKey or smartcard, through the
 * system gpg. When the user turned that on, the worker's keys must not be
 * used instead, and a failure to sign must stop the send rather than let the
 * message go out unsigned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  store: new Map<string, string>(),
  gpgEnabled: true,
  signWithSystemGpg: vi.fn(),
  requestPgpEncryption: vi.fn(),
  requestPgpSignature: vi.fn(),
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (k: string) => hoisted.store.get(k) ?? null,
    set: (k: string, v: string) => hoisted.store.set(k, v),
    remove: (k: string) => hoisted.store.delete(k),
  },
}));

vi.mock('../../src/utils/sync-worker-client.js', () => ({
  requestPgpEncryption: (...a: unknown[]) => hoisted.requestPgpEncryption(...a),
  requestPgpSignature: (...a: unknown[]) => hoisted.requestPgpSignature(...a),
}));

vi.mock('../../src/utils/pgp-system-gpg', () => ({
  systemGpgEnabled: (account: string) => hoisted.gpgEnabled && account === 'me@example.com',
  signWithSystemGpg: (...a: unknown[]) => hoisted.signWithSystemGpg(...a),
}));

const { buildEncryptedPayload, buildSignedPayload } = await import('../../src/utils/pgp-send');
const { saveRecipientKey } = await import('../../src/utils/pgp-recipients');

const KEY = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----';
const SIG = '-----BEGIN PGP SIGNATURE-----\ns\n-----END PGP SIGNATURE-----';
const MSG = '-----BEGIN PGP MESSAGE-----\nc\n-----END PGP MESSAGE-----';
const input = {
  from: 'Me <me@example.com>',
  to: ['a@x.com'],
  subject: 'Hi',
  text: 'hello\nthere',
};
const askPin = vi.fn();

beforeEach(() => {
  hoisted.store.clear();
  hoisted.store.set('email', 'me@example.com');
  hoisted.gpgEnabled = true;
  hoisted.signWithSystemGpg.mockReset();
  hoisted.requestPgpEncryption.mockReset();
  hoisted.requestPgpSignature.mockReset();
});

describe('buildSignedPayload with a YubiKey', () => {
  it('signs the CRLF form of the entity with gpg, as the From address', async () => {
    hoisted.signWithSystemGpg.mockResolvedValue({
      success: true,
      armored: SIG,
      micalg: 'pgp-sha512',
    });
    const res = await buildSignedPayload(input, { askPin });
    expect(res.ok).toBe(true);
    expect(hoisted.requestPgpSignature).not.toHaveBeenCalled();
    const call = hoisted.signWithSystemGpg.mock.calls[0][0];
    expect(call.signer).toBe('me@example.com');
    expect(call.askPin).toBe(askPin);
    expect(call.recipientKeys).toBeUndefined();
    expect(call.data).not.toMatch(/[^\r]\n/);

    const raw = res.payload!.raw;
    expect(raw).toContain('micalg="pgp-sha512"');
    // The signed part is exactly what gpg signed
    expect(raw).toContain(`\r\n${call.data}\r\n--`);
    expect(raw).toContain('-----BEGIN PGP SIGNATURE-----');
  });

  it('stops the send when gpg cannot sign', async () => {
    hoisted.signWithSystemGpg.mockResolvedValue({
      success: false,
      reason: 'no_card',
      message: 'Insert your YubiKey or smartcard',
    });
    const res = await buildSignedPayload(input, { askPin });
    expect(res).toMatchObject({ ok: false, reason: 'sign_failed' });
    expect(res.message).toMatch(/YubiKey/);
    expect(res.payload).toBeUndefined();
  });

  it('says there is no key to sign with when the keyring has none', async () => {
    hoisted.signWithSystemGpg.mockResolvedValue({
      success: false,
      reason: 'no_secret_key',
      message: 'No secret key',
    });
    const res = await buildSignedPayload(input);
    expect(res.reason).toBe('no_signing_key');
  });

  it("uses the app's keys when the YubiKey option is off", async () => {
    hoisted.gpgEnabled = false;
    hoisted.requestPgpSignature.mockResolvedValue({
      success: true,
      signature: SIG,
      micalg: 'pgp-sha256',
    });
    const res = await buildSignedPayload(input);
    expect(res.ok).toBe(true);
    expect(hoisted.signWithSystemGpg).not.toHaveBeenCalled();
  });
});

describe('buildEncryptedPayload with a YubiKey', () => {
  beforeEach(() => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY + 'a' });
    saveRecipientKey({ email: 'me@example.com', armored: KEY + 'me' });
    saveRecipientKey({ email: 'other@x.com', armored: KEY + 'other' });
  });

  it('encrypts and signs in one gpg call, to the recipients and the sender', async () => {
    hoisted.signWithSystemGpg.mockResolvedValue({ success: true, armored: MSG });
    const res = await buildEncryptedPayload(input, { askPin });
    expect(res).toMatchObject({ ok: true, signed: true });
    expect(hoisted.requestPgpEncryption).not.toHaveBeenCalled();
    const call = hoisted.signWithSystemGpg.mock.calls[0][0];
    expect(call.signer).toBe('me@example.com');
    expect(call.recipientKeys).toEqual([KEY + 'a', KEY + 'me']);
    expect(res.payload!.raw).toContain(MSG.replace(/\n/g, '\r\n'));
  });

  it('does not send unsigned when gpg cannot sign', async () => {
    hoisted.signWithSystemGpg.mockResolvedValue({
      success: false,
      reason: 'cancelled',
      message: 'PIN entry cancelled.',
    });
    const res = await buildEncryptedPayload(input, { askPin });
    expect(res).toMatchObject({ ok: false, reason: 'encrypt_failed' });
    expect(res.message).toBe('PIN entry cancelled.');
    expect(hoisted.requestPgpEncryption).not.toHaveBeenCalled();
  });

  it('leaves an unsigned encrypted send to the worker', async () => {
    hoisted.requestPgpEncryption.mockResolvedValue({ success: true, armored: MSG, signed: false });
    const res = await buildEncryptedPayload(input, { sign: false });
    expect(res.ok).toBe(true);
    expect(hoisted.signWithSystemGpg).not.toHaveBeenCalled();
  });
});
