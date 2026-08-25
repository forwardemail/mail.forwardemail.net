/**
 * Pairing codes.
 *
 * This is the control that makes a photographed QR useless, so the properties
 * worth pinning are: the wrap actually hides the seal key, a wrong code fails
 * closed rather than yielding plausible garbage, and the alphabet cannot
 * silently corrupt a code someone typed correctly.
 *
 * Argon2id at 256 MiB is intentionally slow, hence the timeouts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  generatePairingCode,
  isPairingCodeComplete,
  normalizePairingCode,
  unwrapSealKey,
  wrapSealKey,
} from '../../src/utils/device-sync/pairing-code';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const SALT = new Uint8Array(16).fill(9);
const SEAL_KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7);

describe('pairing code alphabet', () => {
  it('generates codes of the expected length from the unambiguous alphabet', () => {
    for (let i = 0; i < 20; i += 1) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      // 0, 1, I and O are excluded precisely because they are misread.
      expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePairingCode()));
    expect(seen.size).toBeGreaterThan(45);
  });

  it('formats in readable groups', () => {
    expect(formatPairingCode('A7K29QMX')).toBe('A7K2-9QMX');
  });

  it('accepts what people actually type', () => {
    expect(normalizePairingCode('a7k2-9qmx')).toBe('A7K29QMX');
    expect(normalizePairingCode('A7K2 9QMX')).toBe('A7K29QMX');
    expect(normalizePairingCode(' A7K2-9QMX ')).toBe('A7K29QMX');
  });

  it('never rewrites L, which is a valid character', () => {
    // An earlier draft mapped L to 1 as a "lookalike" and corrupted good input.
    expect(normalizePairingCode('LLLLLLLL')).toBe('LLLLLLLL');
  });

  it('rejects characters the alphabet does not use', () => {
    for (const bad of ['O', '0', 'I', '1']) {
      expect(normalizePairingCode(`A7K29QM${bad}`)).toBe('');
    }
  });

  it('knows when a code is complete', () => {
    expect(isPairingCodeComplete('A7K2-9QM')).toBe(false);
    expect(isPairingCodeComplete('A7K2-9QMX')).toBe(true);
    expect(isPairingCodeComplete('A7K2-9QMXY')).toBe(false);
  });
});

describe('seal key wrapping', () => {
  it('round-trips the seal key with the right code', async () => {
    const code = generatePairingCode();
    const wrapped = await wrapSealKey(SEAL_KEY, code, SALT);

    expect(wrapped).toHaveLength(32);
    expect(wrapped).not.toEqual(SEAL_KEY);
    await expect(unwrapSealKey(wrapped, code, SALT)).resolves.toEqual(SEAL_KEY);
  }, 30_000);

  it('tolerates the formatting and case a person types', async () => {
    const wrapped = await wrapSealKey(SEAL_KEY, 'A7K29QMX', SALT);
    await expect(unwrapSealKey(wrapped, 'a7k2-9qmx', SALT)).resolves.toEqual(SEAL_KEY);
  }, 30_000);

  it('yields a different key for a wrong code, so the payload fails closed', async () => {
    const wrapped = await wrapSealKey(SEAL_KEY, 'A7K29QMX', SALT);
    const wrong = await unwrapSealKey(wrapped, 'A7K29QMY', SALT);

    // There is no error at this layer by design - the AEAD tag one level up is
    // what rejects it. What matters is that it is not the real key.
    expect(wrong).not.toEqual(SEAL_KEY);
  }, 30_000);

  it('binds the wrap to the salt, so frames from another session do not open it', async () => {
    const code = generatePairingCode();
    const wrapped = await wrapSealKey(SEAL_KEY, code, SALT);
    const otherSalt = new Uint8Array(16).fill(4);

    await expect(unwrapSealKey(wrapped, code, otherSalt)).resolves.not.toEqual(SEAL_KEY);
  }, 30_000);

  it('refuses a salt of the wrong size rather than deriving something weak', async () => {
    await expect(wrapSealKey(SEAL_KEY, 'A7K29QMX', new Uint8Array(8))).rejects.toThrow(/16 bytes/);
  });

  it('refuses an empty or unusable code', async () => {
    await expect(wrapSealKey(SEAL_KEY, '', SALT)).rejects.toThrow(/empty|unusable/i);
    await expect(wrapSealKey(SEAL_KEY, '00000000', SALT)).rejects.toThrow(/empty|unusable/i);
  });
});
