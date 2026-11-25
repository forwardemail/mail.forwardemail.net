/**
 * Decrypted PGP messages are kept in memory, not on disk, without App Lock.
 * An entry is only good with the keys it was decrypted with.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approximateChars,
  clearSessionDecrypts,
  getSessionDecrypt,
  sessionDecryptChars,
  sessionDecryptCount,
  setSessionDecrypt,
} from '../../src/utils/pgp-session-cache';

// A decrypted message with one attachment of about `mb` megabytes, the way
// the worker returns it: the file as a base64 data URL
const withAttachment = (mb: number) => ({
  success: true,
  body: '<p>see attached</p>',
  attachments: [
    { filename: 'scan.pdf', href: `data:application/pdf;base64,${'A'.repeat(mb * 1_000_000)}` },
  ],
});

const A = '-----BEGIN PGP MESSAGE-----\na\n-----END PGP MESSAGE-----';
const B = '-----BEGIN PGP MESSAGE-----\nb\n-----END PGP MESSAGE-----';

beforeEach(() => clearSessionDecrypts());

describe('pgp session cache', () => {
  it('returns what was decrypted for the same ciphertext', async () => {
    await setSessionDecrypt(A, 1, { body: 'hello' });
    expect(await getSessionDecrypt(A, 1)).toEqual({ body: 'hello' });
    expect(await getSessionDecrypt(B, 1)).toBeNull();
  });

  it('drops an entry once the keys changed', async () => {
    await setSessionDecrypt(A, 1, { body: 'hello' });
    expect(await getSessionDecrypt(A, 2)).toBeNull();
    expect(await getSessionDecrypt(A, 1)).toBeNull();
  });

  it('is bounded, least recently used out first', async () => {
    await setSessionDecrypt(A, 1, 'a');
    for (let i = 0; i < 199; i++) await setSessionDecrypt(`c${i}`, 1, i);
    expect(await getSessionDecrypt(A, 1)).toBe('a'); // A is now most recent
    await setSessionDecrypt(B, 1, 'b');
    expect(sessionDecryptCount()).toBe(200);
    expect(await getSessionDecrypt('c0', 1)).toBeNull();
    expect(await getSessionDecrypt(A, 1)).toBe('a');
  });

  it('forgets everything on clear', async () => {
    await setSessionDecrypt(A, 1, 'a');
    clearSessionDecrypts();
    expect(await getSessionDecrypt(A, 1)).toBeNull();
  });

  it('counts the attachments a decrypted message carries', () => {
    expect(approximateChars(withAttachment(2))).toBeGreaterThan(2_000_000);
    expect(approximateChars({ bytes: new Uint8Array(500) })).toBe(500);
    const loop: Record<string, unknown> = { text: 'abc' };
    loop.self = loop;
    expect(approximateChars(loop)).toBe(3);
  });

  it('lets go of older messages once large attachments fill it', async () => {
    // Seven 10 MB attachments are more than it may hold
    for (let i = 0; i < 7; i++) await setSessionDecrypt(`big${i}`, 1, withAttachment(10));

    expect(sessionDecryptChars()).toBeLessThanOrEqual(64_000_000);
    expect(await getSessionDecrypt('big0', 1)).toBeNull();
    expect(await getSessionDecrypt('big6', 1)).not.toBeNull();
  });

  it('keeps the message just opened even when it alone is over the limit', async () => {
    await setSessionDecrypt(A, 1, 'small');
    await setSessionDecrypt(B, 1, withAttachment(70));

    expect(await getSessionDecrypt(B, 1)).not.toBeNull();
    expect(await getSessionDecrypt(A, 1)).toBeNull();
    expect(sessionDecryptCount()).toBe(1);
  });

  it('stops counting what it no longer holds', async () => {
    await setSessionDecrypt(A, 1, withAttachment(1));
    await setSessionDecrypt(A, 1, 'replaced');
    expect(sessionDecryptChars()).toBe('replaced'.length);

    expect(await getSessionDecrypt(A, 2)).toBeNull();
    expect(sessionDecryptChars()).toBe(0);
  });
});
