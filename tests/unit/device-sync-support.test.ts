/**
 * Which platforms offer QR device pairing.
 *
 * One predicate gates every entry point. The risk it guards against is a
 * partial gate - a scanner button on a platform whose decoder always resolves
 * to null, which is a button that can only ever fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadSupport = async (isTauriIOS: boolean) => {
  vi.resetModules();
  vi.doMock('../../src/utils/platform.js', () => ({ isTauriIOS }));
  return import('../../src/utils/device-sync/support');
};

afterEach(() => {
  vi.doUnmock('../../src/utils/platform.js');
  vi.resetModules();
});

describe('isDevicePairingSupported', () => {
  it('is off on iOS, where WebKit has no BarcodeDetector', async () => {
    const { isDevicePairingSupported } = await loadSupport(true);
    expect(isDevicePairingSupported()).toBe(false);
  });

  it('is on everywhere else', async () => {
    const { isDevicePairingSupported } = await loadSupport(false);
    expect(isDevicePairingSupported()).toBe(true);
  });
});
