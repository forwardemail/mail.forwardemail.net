/**
 * Plaintext saved by an earlier build, or left behind when App Lock is turned
 * off, is removed once per account, and again each time App Lock goes off.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  appLock: false,
  active: 'me@test.com',
  store: new Map<string, string>(),
  forget: vi.fn(),
  index: vi.fn(),
}));

vi.mock('../../src/stores/mailService', () => ({
  forgetPgpPlaintext: (...a: unknown[]) => h.forget(...a),
}));
vi.mock('../../src/stores/searchStore', () => ({
  searchStore: { actions: { indexMessages: (...a: unknown[]) => h.index(...a) } },
}));
vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (k: string) => (k === 'email' ? h.active : (h.store.get(k) ?? null)),
    set: (k: string, v: string) => h.store.set(k, v),
  },
}));
vi.mock('../../src/utils/pgp-plaintext-policy', () => ({
  pgpPlaintextMayPersist: () => h.appLock,
}));

import {
  pgpPlaintextNoLongerProtected,
  purgePgpPlaintextIfNeeded,
} from '../../src/stores/pgpPlaintextPurge';

const row = { id: 'm1', subject: '...' };

beforeEach(() => {
  h.appLock = false;
  h.active = 'me@test.com';
  h.store.clear();
  h.forget.mockReset().mockResolvedValue([row]);
  h.index.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('pgp plaintext purge', () => {
  it('cleans an account once and takes its text out of the search index', async () => {
    await purgePgpPlaintextIfNeeded('me@test.com');
    await purgePgpPlaintextIfNeeded('me@test.com');

    expect(h.forget).toHaveBeenCalledTimes(1);
    expect(h.forget).toHaveBeenCalledWith('me@test.com');
    expect(h.index).toHaveBeenCalledWith([row]);
  });

  it('leaves the cache alone while App Lock encrypts it', async () => {
    h.appLock = true;

    await purgePgpPlaintextIfNeeded('me@test.com');

    expect(h.forget).not.toHaveBeenCalled();
  });

  it('cleans each account separately', async () => {
    await purgePgpPlaintextIfNeeded('me@test.com');
    await purgePgpPlaintextIfNeeded('other@test.com');

    expect(h.forget.mock.calls.map(([account]) => account)).toEqual([
      'me@test.com',
      'other@test.com',
    ]);
    // The search index on screen belongs to the active account only
    expect(h.index).toHaveBeenCalledTimes(1);
  });

  it('cleans again after App Lock is turned off, other accounts included', async () => {
    await purgePgpPlaintextIfNeeded('me@test.com');
    await purgePgpPlaintextIfNeeded('other@test.com');
    h.forget.mockClear();

    await pgpPlaintextNoLongerProtected('me@test.com');
    await purgePgpPlaintextIfNeeded('other@test.com');
    await purgePgpPlaintextIfNeeded('other@test.com');

    expect(h.forget.mock.calls.map(([account]) => account)).toEqual([
      'me@test.com',
      'other@test.com',
    ]);
  });

  it('tries again next time when the clean-up failed', async () => {
    h.forget.mockRejectedValueOnce(new Error('database busy'));

    await purgePgpPlaintextIfNeeded('me@test.com');
    await purgePgpPlaintextIfNeeded('me@test.com');

    expect(h.forget).toHaveBeenCalledTimes(2);
  });
});
