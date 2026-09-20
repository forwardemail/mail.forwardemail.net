/**
 * The encrypt-before-send path. Encryption is all-or-nothing across a recipient
 * set, so the failure cases matter as much as the success one: silently sending
 * in the clear, or silently dropping a Bcc'd reader who then gets an unreadable
 * message, are both worse than refusing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  store: new Map<string, string>(),
  requestPgpEncryption: vi.fn(),
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
}));

const { buildEncryptedPayload, collectRecipients } = await import('../../src/utils/pgp-send');
const { saveRecipientKey, recipientKeyCoverage, normalizeAddress, deleteRecipientKey } =
  await import('../../src/utils/pgp-recipients');

const KEY = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----';

beforeEach(() => {
  hoisted.store.clear();
  hoisted.store.set('email', 'me@example.com');
  hoisted.requestPgpEncryption.mockReset();
  hoisted.requestPgpEncryption.mockResolvedValue({
    success: true,
    armored: '-----BEGIN PGP MESSAGE-----\nc\n-----END PGP MESSAGE-----',
    signed: true,
  });
});

describe('normalizeAddress', () => {
  it('extracts the addr-spec and lowercases it', () => {
    expect(normalizeAddress('Jane <Jane@Example.COM>')).toBe('jane@example.com');
    expect(normalizeAddress('  BOB@x.com ')).toBe('bob@x.com');
  });
});

describe('collectRecipients', () => {
  it('covers to and cc, the recipients a raw message can carry in its headers', () => {
    const out = collectRecipients({
      from: 'me@example.com',
      to: ['a@x.com'],
      cc: ['b@x.com'],
    });
    expect(out).toEqual(['a@x.com', 'b@x.com']);
  });

  it('deduplicates across fields and case', () => {
    const out = collectRecipients({
      from: 'me@example.com',
      to: ['A@x.com'],
      cc: ['a@x.com'],
    });
    expect(out).toEqual(['a@x.com']);
  });
});

describe('recipientKeyCoverage', () => {
  it('names exactly who is missing a key', () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    const out = recipientKeyCoverage(['a@x.com', 'b@x.com']);
    expect(out.allCovered).toBe(false);
    expect(out.missing).toEqual(['b@x.com']);
  });

  it('matches regardless of case or display name', () => {
    saveRecipientKey({ email: 'A@X.com', armored: KEY });
    expect(recipientKeyCoverage(['Jane <a@x.com>']).allCovered).toBe(true);
  });

  it('is not covered when there are no recipients at all', () => {
    expect(recipientKeyCoverage([]).allCovered).toBe(false);
  });

  it('forgets a deleted key', () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    deleteRecipientKey('A@x.com');
    expect(recipientKeyCoverage(['a@x.com']).missing).toEqual(['a@x.com']);
  });
});

describe('buildEncryptedPayload', () => {
  const base = { from: 'me@example.com', to: ['a@x.com'], subject: 'Hi', text: 'secret' };

  it('refuses when a recipient has no pinned key, naming them', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    const out = await buildEncryptedPayload({ ...base, cc: ['nokey@x.com'] });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('missing_keys');
    expect(out.missing).toEqual(['nokey@x.com']);
    // Nothing may be sent, and nothing should have been encrypted.
    expect(hoisted.requestPgpEncryption).not.toHaveBeenCalled();
  });

  it('refuses with no recipients rather than encrypting to nobody', async () => {
    const out = await buildEncryptedPayload({ from: 'me@example.com', text: 'x' });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no_recipients');
  });

  it('builds a raw PGP/MIME payload when every recipient has a key', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    const out = await buildEncryptedPayload(base);

    expect(out.ok).toBe(true);
    expect(out.payload?.raw).toContain('multipart/encrypted');
    expect(out.payload?.raw).toContain('-----BEGIN PGP MESSAGE-----');
    // The plaintext must never appear in what gets posted.
    expect(out.payload?.raw).not.toContain('secret');
  });

  it('refuses bcc rather than dropping or exposing the blind recipient', async () => {
    // The API rebuilds a raw message's envelope from its headers and takes no
    // separate envelope on /v1/emails, so a bcc'd address is either visible to
    // everyone or never delivered. Neither is what the user asked for.
    for (const email of ['a@x.com', 'c@x.com']) saveRecipientKey({ email, armored: KEY });
    const out = await buildEncryptedPayload({ ...base, bcc: ['c@x.com'] });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('bcc_unsupported');
    expect(hoisted.requestPgpEncryption).not.toHaveBeenCalled();
  });

  it('ignores an empty bcc list', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    const out = await buildEncryptedPayload({ ...base, bcc: ['', '  '] });
    expect(out.ok).toBe(true);
  });

  it('writes the Reply-To header the composer set', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    const out = await buildEncryptedPayload({ ...base, replyTo: 'support@example.com' });
    expect(out.payload?.raw).toContain('Reply-To: support@example.com');
  });

  it('encrypts to the sender too, so the Sent copy stays readable', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    saveRecipientKey({ email: 'me@example.com', armored: `${KEY}\nmine` });

    await buildEncryptedPayload(base);

    const [{ recipientKeys }] = hoisted.requestPgpEncryption.mock.calls[0] as [
      { recipientKeys: string[] },
    ];
    expect(recipientKeys).toHaveLength(2);
    expect(recipientKeys.some((k) => k.includes('mine'))).toBe(true);
  });

  it('does not send a key for someone who is not on the message', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    saveRecipientKey({ email: 'stranger@x.com', armored: `${KEY}\nstranger` });

    await buildEncryptedPayload(base);

    const [{ recipientKeys }] = hoisted.requestPgpEncryption.mock.calls[0] as [
      { recipientKeys: string[] },
    ];
    expect(recipientKeys.some((k) => k.includes('stranger'))).toBe(false);
  });

  it('reports a worker failure instead of falling back to plaintext', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    hoisted.requestPgpEncryption.mockResolvedValue({
      success: false,
      reason: 'encrypt_failed',
      message: 'bad key',
    });

    const out = await buildEncryptedPayload(base);

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('encrypt_failed');
    expect(out.payload).toBeUndefined();
  });

  it('turns a thrown worker error into a value rather than wedging the caller', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    hoisted.requestPgpEncryption.mockRejectedValue(new Error('worker gone'));

    const out = await buildEncryptedPayload(base);

    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/worker gone/);
  });

  it('reports whether the ciphertext was also signed', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    hoisted.requestPgpEncryption.mockResolvedValue({
      success: true,
      armored: '-----BEGIN PGP MESSAGE-----\nc\n-----END PGP MESSAGE-----',
      signed: false,
    });

    const out = await buildEncryptedPayload(base);
    expect(out.ok).toBe(true);
    expect(out.signed).toBe(false);
  });

  it('keeps the subject readable, since PGP/MIME cannot hide it', async () => {
    saveRecipientKey({ email: 'a@x.com', armored: KEY });
    const out = await buildEncryptedPayload(base);
    // Stated plainly so the UI can warn rather than implying the subject is secret.
    expect(out.payload?.raw).toContain('Subject: Hi');
  });
});
