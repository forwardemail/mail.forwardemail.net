/**
 * The phone-side pairing and push probes. These replaced the camera spike
 * that used to live on the diagnostics page: they answer the same three
 * questions (secure context, camera, decoder) without opening the camera.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  isTauriDesktop: false,
  isTauriMobile: true,
  getPlatform: () => 'tauri-mobile',
}));

const scanner = vi.hoisted(() => ({
  native: false,
  decoder: null as null | { kind: string; close: () => void },
}));
vi.mock('../../src/utils/device-sync/scanner', () => ({
  isNativeDecoderAvailable: () => scanner.native,
  createQrDecoder: async () => scanner.decoder,
}));

const push = vi.hoisted(() => ({ token: null as string | null, provider: null as string | null }));
vi.mock('../../src/utils/push-notifications.js', () => ({
  getStoredPushToken: () => push.token,
  getActivePushProvider: () => push.provider,
  getPushPlatform: () => 'android',
}));

import { checkCamera, checkPushRegistration, checkQrDecoder } from '../../src/utils/diagnostics';

describe('checkCamera', () => {
  const originalMedia = navigator.mediaDevices;
  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: originalMedia, configurable: true });
  });
  const setDevices = (kinds: string[] | null) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value:
        kinds === null
          ? undefined
          : { enumerateDevices: async () => kinds.map((kind) => ({ kind, label: '' })) },
    });
  };

  it('counts video inputs without opening the camera', async () => {
    setDevices(['audioinput', 'videoinput', 'videoinput']);
    const r = await checkCamera();
    expect(r.status).toBe('pass');
    expect(r.detail).toEqual({ cameras: 2 });
  });

  it('fails when no camera is present', async () => {
    setDevices(['audioinput']);
    expect((await checkCamera()).status).toBe('fail');
  });

  it('fails when the webview has no mediaDevices at all', async () => {
    setDevices(null);
    const r = await checkCamera();
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/unavailable/i);
  });
});

describe('checkQrDecoder', () => {
  beforeEach(() => {
    scanner.native = false;
    scanner.decoder = null;
  });

  it('names the native detector when the engine has one', async () => {
    scanner.native = true;
    scanner.decoder = { kind: 'BarcodeDetector', close: vi.fn() };
    const r = await checkQrDecoder();
    expect(r.status).toBe('pass');
    expect(r.message).toBe('BarcodeDetector');
    expect(scanner.decoder.close).toHaveBeenCalled();
  });

  it('marks the bundled fallback, the WKWebView case', async () => {
    scanner.decoder = { kind: 'jsQR', close: vi.fn() };
    const r = await checkQrDecoder();
    expect(r.status).toBe('pass');
    expect(r.message).toBe('jsQR (bundled fallback)');
  });

  it('fails when neither decoder can run', async () => {
    expect((await checkQrDecoder()).status).toBe('fail');
  });
});

describe('checkPushRegistration', () => {
  beforeEach(() => {
    push.token = null;
    push.provider = null;
  });

  it('warns with no device token', async () => {
    const r = await checkPushRegistration();
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/no device token/i);
  });

  it('warns when the token exists but the active account is not registered', async () => {
    push.token = 'tok';
    const r = await checkPushRegistration();
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/no registration/i);
  });

  it('passes with the provider named and never the token itself', async () => {
    push.token = 'secret-device-token';
    push.provider = 'fcm';
    const r = await checkPushRegistration();
    expect(r.status).toBe('pass');
    expect(r.message).toBe('Registered via fcm');
    expect(JSON.stringify(r)).not.toContain('secret-device-token');
  });
});
