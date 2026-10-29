// @vitest-environment node
/**
 * Device-key sealing of sensitive localStorage values (desktop, App Lock off).
 *
 * device-seal.ts runs for real here with libsodium; only the OS credential
 * store is faked. The storage.js half checks what actually lands in
 * localStorage, since "not plaintext on disk" is the whole point.
 *
 * Node environment with an in-memory Storage: under jsdom, libsodium rejects
 * the Uint8Array its own from_string returns (see crypto-store.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // Storage has to exist before storage.js is evaluated (it checks at load)
  const make = () => {
    const items = new Map<string, string>();
    return {
      get length() {
        return items.size;
      },
      key: (i: number) => [...items.keys()][i] ?? null,
      getItem: (k: string) => (items.has(k) ? (items.get(k) as string) : null),
      setItem: (k: string, v: string) => void items.set(k, String(v)),
      removeItem: (k: string) => void items.delete(k),
      clear: () => items.clear(),
    };
  };
  (globalThis as Record<string, unknown>).localStorage = make();
  (globalThis as Record<string, unknown>).sessionStorage = make();
});

const ENC_PREFIX = '\x00ENC\x01';
const DEV_PREFIX = '\x00DEV\x01';

const vault = { unlocked: false, enabled: false };

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
  },
}));

vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));

vi.mock('../../src/utils/crypto-store.js', () => {
  const sensitive = (key: string) =>
    ['api_key', 'alias_auth', 'authToken', 'accounts'].includes(key) ||
    key.startsWith('pgp_keys_') ||
    key.startsWith('pgp_passphrases_');
  return {
    isSensitiveLocalKey: sensitive,
    isLockEnabled: () => vault.enabled,
    isVaultConfigured: () => vault.enabled,
    isUnlocked: () => vault.unlocked,
    isVaultLocked: () => vault.enabled && !vault.unlocked,
    protectLocalValue: (key: string, value: string) =>
      vault.unlocked && sensitive(key) ? ENC_PREFIX + btoa(value) : value,
    revealLocalValue: (value: string) => {
      if (!value.startsWith(ENC_PREFIX)) return value;
      if (!vault.unlocked) return null;
      return atob(value.slice(ENC_PREFIX.length));
    },
  };
});

import {
  loadDeviceKey,
  sealForDevice,
  unsealFromDevice,
  isDeviceSealed,
  hasDeviceKey,
  getDeviceSealStatus,
  sealExistingLocalStorage,
  resetDeviceKeyForTests,
} from '../../src/utils/device-seal';
import { Local, Accounts } from '../../src/utils/storage';

function fakeStore(initial: string | null = null, { persists = true } = {}) {
  let stored = initial;
  return {
    sets: 0,
    get: async () => stored,
    async set(value: string) {
      this.sets += 1;
      if (persists) stored = value;
    },
    peek: () => stored,
  };
}

const isSensitive = (key: string) =>
  ['api_key', 'alias_auth', 'authToken', 'accounts'].includes(key) || key.startsWith('pgp_keys_');

describe('device-seal', () => {
  beforeEach(() => {
    resetDeviceKeyForTests();
    localStorage.clear();
    sessionStorage.clear();
    vault.unlocked = false;
    vault.enabled = false;
  });

  it('creates a key on first use and opens what it sealed', async () => {
    const store = fakeStore();
    expect(await loadDeviceKey({ create: true }, store)).toBe(true);
    expect(store.sets).toBe(1);
    expect(store.peek()).toMatch(/^[A-Za-z0-9_-]+$/);

    const sealed = sealForDevice('user@example.com:hunter2');
    expect(isDeviceSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('hunter2');
    expect(unsealFromDevice(sealed)).toBe('user@example.com:hunter2');
  });

  it('uses a different nonce each time', async () => {
    await loadDeviceKey({ create: true }, fakeStore());
    expect(sealForDevice('same')).not.toBe(sealForDevice('same'));
  });

  it('reuses the stored key across launches', async () => {
    const store = fakeStore();
    await loadDeviceKey({ create: true }, store);
    const sealed = sealForDevice('secret');

    resetDeviceKeyForTests();
    expect(await loadDeviceKey({ create: true }, store)).toBe(true);
    expect(store.sets).toBe(1);
    expect(unsealFromDevice(sealed)).toBe('secret');
  });

  it('cannot open a value sealed under another key', async () => {
    await loadDeviceKey({ create: true }, fakeStore());
    const sealed = sealForDevice('secret');

    resetDeviceKeyForTests();
    await loadDeviceKey({ create: true }, fakeStore());
    expect(unsealFromDevice(sealed)).toBeNull();
  });

  it('does not create a key when told not to (compose window)', async () => {
    const store = fakeStore();
    expect(await loadDeviceKey({ create: false }, store)).toBe(false);
    expect(store.sets).toBe(0);
    expect(hasDeviceKey()).toBe(false);
  });

  it('gives up on a store that accepts the key but does not keep it', async () => {
    const store = fakeStore(null, { persists: false });
    expect(await loadDeviceKey({ create: true }, store)).toBe(false);
    expect(hasDeviceKey()).toBe(false);
    expect(sealForDevice('secret')).toBe('secret');
  });

  it('runs unsealed when the store throws or there is none', async () => {
    const broken = {
      get: async () => {
        throw new Error('no secret service');
      },
      set: async () => {},
    };
    expect(await loadDeviceKey({ create: true }, broken)).toBe(false);
    expect(await loadDeviceKey({ create: true }, null)).toBe(false);
    expect(sealForDevice('secret')).toBe('secret');
  });

  it('starts without a key when the store never answers', async () => {
    const hung = { get: () => new Promise<string | null>(() => {}), set: async () => {} };
    const started = Date.now();
    expect(await loadDeviceKey({ create: true, timeoutMs: 50 }, hung)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(hasDeviceKey()).toBe(false);
  });

  it('picks up a key that arrives after the wait', async () => {
    let answer: (value: string) => void = () => {};
    const slow = {
      get: () => new Promise<string | null>((resolve) => (answer = resolve)),
      set: async () => {},
    };
    expect(await loadDeviceKey({ create: false, timeoutMs: 20 }, slow)).toBe(false);
    answer(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/=+$/, ''));
    await vi.waitFor(() => expect(hasDeviceKey()).toBe(true));
  });

  it('reports why sealing is on or off, and what cannot be opened', async () => {
    expect(await loadDeviceKey({ create: true }, null)).toBe(false);
    expect(getDeviceSealStatus().state).toBe('unsupported');

    resetDeviceKeyForTests();
    await loadDeviceKey({ create: true }, fakeStore());
    Local.set('alias_auth', 'a@b.c:pw');
    Local.set('pgp_keys_a@b.c', '[]');
    expect(getDeviceSealStatus()).toMatchObject({
      state: 'on',
      sealedValues: 2,
      readableValues: 2,
    });

    resetDeviceKeyForTests();
    const hung = { get: () => new Promise<string | null>(() => {}), set: async () => {} };
    await loadDeviceKey({ create: true, timeoutMs: 20 }, hung);
    expect(getDeviceSealStatus()).toMatchObject({
      state: 'unavailable',
      reason: 'no answer in 20ms',
      sealedValues: 2,
      readableValues: 0,
    });
  });

  it('treats a sealed value as missing when no key is loaded', () => {
    expect(unsealFromDevice(`${DEV_PREFIX}AAAA`)).toBeNull();
    expect(unsealFromDevice('plain')).toBe('plain');
    expect(unsealFromDevice(null)).toBeNull();
  });

  it('seals existing plaintext sensitive values only', async () => {
    await loadDeviceKey({ create: true }, fakeStore());
    localStorage.setItem('webmail_alias_auth', 'a@b.c:pw');
    localStorage.setItem('webmail_pgp_keys_a@b.c', '[{"key":"-----BEGIN PGP"}]');
    localStorage.setItem('webmail_api_key', `${ENC_PREFIX}vaultblob`);
    localStorage.setItem('webmail_theme', 'dark');
    localStorage.setItem('other_alias_auth', 'not ours');

    const count = sealExistingLocalStorage(isSensitive, (v) => v.startsWith(ENC_PREFIX));

    expect(count).toBe(2);
    expect(isDeviceSealed(localStorage.getItem('webmail_alias_auth'))).toBe(true);
    expect(isDeviceSealed(localStorage.getItem('webmail_pgp_keys_a@b.c'))).toBe(true);
    expect(localStorage.getItem('webmail_api_key')).toBe(`${ENC_PREFIX}vaultblob`);
    expect(localStorage.getItem('webmail_theme')).toBe('dark');
    expect(localStorage.getItem('other_alias_auth')).toBe('not ours');
    // A second pass leaves sealed values alone
    expect(sealExistingLocalStorage(isSensitive, (v) => v.startsWith(ENC_PREFIX))).toBe(0);
  });

  describe('through storage.js', () => {
    beforeEach(async () => {
      await loadDeviceKey({ create: true }, fakeStore());
    });

    it('keeps sensitive values off disk in plaintext and reads them back', () => {
      Local.set('alias_auth', 'a@b.c:pw');
      Local.set('pgp_passphrases_a@b.c', '{"k":"correct horse"}');

      expect(localStorage.getItem('webmail_alias_auth')).not.toContain('pw');
      expect(isDeviceSealed(localStorage.getItem('webmail_alias_auth'))).toBe(true);
      expect(localStorage.getItem('webmail_pgp_passphrases_a@b.c')).not.toContain('horse');
      expect(Local.get('alias_auth')).toBe('a@b.c:pw');
      expect(Local.get('pgp_passphrases_a@b.c')).toBe('{"k":"correct horse"}');
    });

    it('opens a sealed credential in a fresh tab and seeds the session copy', () => {
      Local.set('alias_auth', 'a@b.c:pw');
      sessionStorage.clear();

      expect(Local.get('alias_auth')).toBe('a@b.c:pw');
      expect(sessionStorage.getItem('webmail_alias_auth')).toBe('a@b.c:pw');
    });

    it('leaves settings that are not sensitive as they are', () => {
      Local.set('theme', 'dark');
      expect(localStorage.getItem('webmail_theme')).toBe('dark');
    });

    it('seals the accounts list', () => {
      Accounts.add('a@b.c', { aliasAuth: 'a@b.c:pw' }, true);
      const raw = localStorage.getItem('webmail_accounts') || '';
      expect(isDeviceSealed(raw)).toBe(true);
      expect(raw).not.toContain('pw');
      expect(Accounts.getPersistent().map((a) => a.email)).toEqual(['a@b.c']);
    });

    it('lets App Lock encrypt instead while the vault is unlocked', () => {
      vault.enabled = true;
      vault.unlocked = true;
      Local.set('api_key', 'k');
      expect(localStorage.getItem('webmail_api_key')).toBe(ENC_PREFIX + btoa('k'));
    });

    it('will not write a key list over a sealed one it cannot read', () => {
      Local.set('pgp_keys_a@b.c', '[{"name":"old"}]');
      resetDeviceKeyForTests();
      expect(Local.get('pgp_keys_a@b.c')).toBeNull();
      expect(Local.set('pgp_keys_a@b.c', '[{"name":"new"}]')).toBe(false);
      expect(isDeviceSealed(localStorage.getItem('webmail_pgp_keys_a@b.c'))).toBe(true);
      // A single credential may still be replaced by signing in again
      expect(Local.set('alias_auth', 'a@b.c:new')).toBe(true);
    });

    it('reads a sealed credential as missing once the key is gone', () => {
      Local.set('alias_auth', 'a@b.c:pw');
      sessionStorage.clear();
      resetDeviceKeyForTests();
      expect(Local.get('alias_auth')).toBeNull();
      expect(sessionStorage.getItem('webmail_alias_auth')).toBeNull();
    });
  });
});
