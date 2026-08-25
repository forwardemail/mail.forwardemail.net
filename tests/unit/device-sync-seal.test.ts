/**
 * Sealing tests for QR device pairing.
 *
 * The seal is what makes it safe for a pairing payload to sit on screen as a
 * picture: AES-256-GCM, key generated per session. Exercised against real
 * WebCrypto, no mocks, because a mocked cipher would prove nothing about the
 * property that matters (a wrong or tampered payload must not open).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  BUNDLE_VERSION,
  DeviceSyncError,
  generateSealKey,
  openSealedBundle,
  sealBundle,
} from '../../src/utils/device-sync/seal';
import type { DeviceSyncBundle } from '../../src/utils/device-sync/types';

beforeAll(() => {
  // jsdom lacks crypto.subtle; use Node's WebCrypto implementation.
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const NOW = 1_760_000_000_000;

const makeBundle = (overrides: Partial<DeviceSyncBundle> = {}): DeviceSyncBundle => ({
  v: BUNDLE_VERSION,
  iat: Math.floor(NOW / 1000),
  exp: Math.floor(NOW / 1000) + 180,
  src: { app: 'desktop', os: 'macos', name: 'test-mbp' },
  account: { email: 'user@example.com', aliasAuth: 'user@example.com:hunter2', apiKey: null },
  ...overrides,
});

describe('device-sync seal', () => {
  it('round-trips a bundle', async () => {
    const bundle = makeBundle();
    const { key, sealed } = await sealBundle(bundle);

    expect(key.length).toBe(32);
    await expect(openSealedBundle(sealed, key, { now: NOW })).resolves.toEqual(bundle);
  });

  it('never leaves the credential readable in the sealed bytes', async () => {
    const { sealed } = await sealBundle(makeBundle());
    const asText = new TextDecoder().decode(sealed);

    expect(asText).not.toContain('hunter2');
    expect(asText).not.toContain('user@example.com');
  });

  it('rejects a wrong key', async () => {
    const { sealed } = await sealBundle(makeBundle());

    await expect(openSealedBundle(sealed, generateSealKey(), { now: NOW })).rejects.toMatchObject({
      code: 'BAD_KEY',
    });
  });

  it('rejects a tampered payload', async () => {
    const { key, sealed } = await sealBundle(makeBundle());
    // Flip a bit in the ciphertext; GCM's tag must catch it.
    sealed[sealed.length - 5] ^= 0x01;

    await expect(openSealedBundle(sealed, key, { now: NOW })).rejects.toMatchObject({
      code: 'BAD_KEY',
    });
  });

  it('rejects an expired bundle but still opens it when asked to ignore expiry', async () => {
    const bundle = makeBundle();
    const { key, sealed } = await sealBundle(bundle);
    const tooLate = NOW + 181_000;

    await expect(openSealedBundle(sealed, key, { now: tooLate })).rejects.toMatchObject({
      code: 'EXPIRED',
    });
    await expect(
      openSealedBundle(sealed, key, { now: tooLate, ignoreExpiry: true }),
    ).resolves.toEqual(bundle);
  });

  it('accepts a bundle on its final second', async () => {
    const bundle = makeBundle();
    const { key, sealed } = await sealBundle(bundle);

    await expect(openSealedBundle(sealed, key, { now: bundle.exp * 1000 })).resolves.toEqual(
      bundle,
    );
  });

  it('reports an unrecognised bundle version distinctly from corruption', async () => {
    const bundle = makeBundle({ v: 99 });
    const { key, sealed } = await sealBundle(bundle);

    await expect(openSealedBundle(sealed, key, { now: NOW })).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it('rejects a truncated payload', async () => {
    const { key, sealed } = await sealBundle(makeBundle());

    await expect(openSealedBundle(sealed.subarray(0, 8), key)).rejects.toMatchObject({
      code: 'BAD_FORMAT',
    });
  });

  it('compresses a repetitive bundle well below its JSON size', async () => {
    const bundle = makeBundle({
      settings: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`setting_${i}`, 'a repeated value']),
      ),
    });
    const { sealed } = await sealBundle(bundle);

    expect(sealed.length).toBeLessThan(JSON.stringify(bundle).length / 2);
  });

  it('still produces an openable payload where CompressionStream is missing', async () => {
    // WebKitGTK below 2.42 has no CompressionStream. The sender must fall back
    // to uncompressed JSON rather than failing the export outright.
    vi.stubGlobal('CompressionStream', undefined);
    try {
      const bundle = makeBundle();
      const { key, sealed } = await sealBundle(bundle);
      await expect(openSealedBundle(sealed, key, { now: NOW })).resolves.toEqual(bundle);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('exposes DeviceSyncError as a real Error subclass', async () => {
    const { sealed } = await sealBundle(makeBundle());
    const error = await openSealedBundle(sealed, generateSealKey()).catch((e) => e);

    expect(error).toBeInstanceOf(DeviceSyncError);
    expect(error).toBeInstanceOf(Error);
  });
});
