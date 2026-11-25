/**
 * Decrypted PGP messages are kept in memory, not on disk, without App Lock.
 * An entry is only good with the keys it was decrypted with.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSessionDecrypts,
  getSessionDecrypt,
  sessionDecryptCount,
  setSessionDecrypt,
} from '../../src/utils/pgp-session-cache';

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
});
