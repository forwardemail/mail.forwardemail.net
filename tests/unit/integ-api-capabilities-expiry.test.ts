/**
 * The "this server strips addresses from lightweight lists" verdict used to be
 * stored forever under the apiBase alone, so a server fixed at the same URL was
 * never asked for lightweight lists again. It now expires after a week and
 * whenever the app version changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  store: new Map<string, string>(),
  apiBase: 'https://api.forwardemail.net',
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (key: string) => env.store.get(key) ?? null,
    set: (key: string, value: string) => {
      env.store.set(key, String(value));
    },
  },
}));
vi.mock('../../src/config.js', () => ({
  config: {
    get apiBase() {
      return env.apiBase;
    },
  },
}));

import {
  lightweightListSupported,
  noteLightweightListResponse,
  resetLightweightSupportForTests,
  VERDICT_TTL_MS,
} from '../../src/utils/api-capabilities';

// A page from an older API build: lightweight rows normalized with no sender.
const strippedPage = [
  { id: '64b7f0c2e4b0a1a2b3000001', subject: 'Invoice 4471', from: '' },
  { id: '64b7f0c2e4b0a1a2b3000002', subject: 'Re: lunch?', from: '' },
];

const DAY = 24 * 60 * 60 * 1000;

// What a fresh app launch sees: nothing in memory, only localStorage.
const relaunch = () => resetLightweightSupportForTests();

beforeEach(() => {
  env.store.clear();
  env.apiBase = 'https://api.forwardemail.net';
  vi.stubEnv('VITE_PKG_VERSION', '0.14.32');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  relaunch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('lightweight verdict persistence', () => {
  it('keeps the verdict across launches on the same server and build', () => {
    expect(noteLightweightListResponse(strippedPage)).toBe(true);
    vi.setSystemTime(new Date('2026-10-04T09:00:00Z'));
    relaunch();
    expect(lightweightListSupported()).toBe(false);
  });

  it('stores when and for which build the verdict was made', () => {
    noteLightweightListResponse(strippedPage);
    expect(JSON.parse(env.store.get('api_lightweight_addresses') as string)).toEqual({
      apiBase: 'https://api.forwardemail.net',
      at: Date.parse('2026-10-01T09:00:00Z'),
      appVersion: '0.14.32',
    });
  });

  it('probes again once the verdict is a week old', () => {
    noteLightweightListResponse(strippedPage);
    vi.setSystemTime(Date.parse('2026-10-01T09:00:00Z') + VERDICT_TTL_MS + 1);
    relaunch();
    expect(VERDICT_TTL_MS).toBe(7 * DAY);
    expect(lightweightListSupported()).toBe(true);
  });

  it('probes again after an app update', () => {
    noteLightweightListResponse(strippedPage);
    vi.stubEnv('VITE_PKG_VERSION', '0.14.33');
    relaunch();
    expect(lightweightListSupported()).toBe(true);
  });

  it('probes again when pointed at a different server', () => {
    noteLightweightListResponse(strippedPage);
    env.apiBase = 'https://mail.example.org';
    relaunch();
    expect(lightweightListSupported()).toBe(true);
  });

  it('treats the old bare-apiBase entry as stale', () => {
    env.store.set('api_lightweight_addresses', 'https://api.forwardemail.net');
    expect(lightweightListSupported()).toBe(true);
  });

  it('probes again in a session left open past the expiry', () => {
    noteLightweightListResponse(strippedPage);
    expect(lightweightListSupported()).toBe(false);
    vi.setSystemTime(Date.parse('2026-10-01T09:00:00Z') + 8 * DAY);
    expect(lightweightListSupported()).toBe(true);
  });

  it('records a fresh verdict when the re-probe still finds no senders', () => {
    noteLightweightListResponse(strippedPage);
    vi.setSystemTime(Date.parse('2026-10-01T09:00:00Z') + 8 * DAY);
    relaunch();
    expect(lightweightListSupported()).toBe(true);
    expect(noteLightweightListResponse(strippedPage)).toBe(true);
    relaunch();
    expect(lightweightListSupported()).toBe(false);
  });
});
