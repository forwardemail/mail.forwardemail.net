/**
 * storage.js sensitive-key routing tests.
 *
 * Local.set/get and the Accounts list must round-trip through the App Lock
 * vault (crypto-store) for sensitive keys: encrypted in localStorage whenever
 * the vault is unlocked, plaintext mirror in tab-scoped sessionStorage, and
 * fail-safe behavior while locked (reads return null, list writes refuse to
 * clobber the encrypted list). crypto-store is mocked with a reversible fake
 * so the routing logic is tested without libsodium.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ENC_PREFIX = '\x00ENC\x01';

// Mutable fake-vault state the mock reads at call time.
const vault = { unlocked: false, enabled: false, configured: false };

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
    isVaultConfigured: () => vault.configured,
    isUnlocked: () => vault.unlocked,
    isVaultLocked: () => vault.enabled && vault.configured && !vault.unlocked,
    protectLocalValue: (key: string, value: string) =>
      vault.unlocked && sensitive(key) ? ENC_PREFIX + btoa(value) : value,
    revealLocalValue: (value: string) => {
      if (!value.startsWith(ENC_PREFIX)) return value;
      if (!vault.unlocked) return null;
      return atob(value.slice(ENC_PREFIX.length));
    },
  };
});

import { Local, Accounts } from '../../src/utils/storage';

describe('storage sensitive-key routing', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vault.unlocked = false;
    vault.enabled = false;
    vault.configured = false;
  });

  it('writes plaintext when the vault is not in use (feature off)', () => {
    Local.set('api_key', 'secret-key');
    expect(localStorage.getItem('webmail_api_key')).toBe('secret-key');
    expect(Local.get('api_key')).toBe('secret-key');
  });

  it('encrypts sensitive localStorage writes while unlocked, keeps session plaintext', () => {
    vault.unlocked = true;
    Local.set('api_key', 'secret-key');

    expect(localStorage.getItem('webmail_api_key')).toBe(ENC_PREFIX + btoa('secret-key'));
    // Tab-scoped mirror stays plaintext (auth headers read synchronously).
    expect(sessionStorage.getItem('webmail_api_key')).toBe('secret-key');
    expect(Local.get('api_key')).toBe('secret-key');
  });

  it('decrypts on a fresh tab (no session copy) and re-seeds sessionStorage', () => {
    vault.unlocked = true;
    Local.set('alias_auth', 'user:pass');
    sessionStorage.clear(); // simulate a new tab

    expect(Local.get('alias_auth')).toBe('user:pass');
    expect(sessionStorage.getItem('webmail_alias_auth')).toBe('user:pass');
  });

  it('treats encrypted values as missing while locked (no garbage auth headers)', () => {
    vault.unlocked = true;
    Local.set('alias_auth', 'user:pass');
    sessionStorage.clear();
    vault.unlocked = false;

    expect(Local.get('alias_auth')).toBeNull();
  });

  it('encrypts non-tab-scoped sensitive keys (PGP material) and decrypts on read', () => {
    vault.unlocked = true;
    Local.set('pgp_keys_a@example.com', '[{"name":"k","value":"ARMORED"}]');

    expect(localStorage.getItem('webmail_pgp_keys_a@example.com')).toContain(ENC_PREFIX);
    expect(Local.get('pgp_keys_a@example.com')).toBe('[{"name":"k","value":"ARMORED"}]');
    vault.unlocked = false;
    expect(Local.get('pgp_keys_a@example.com')).toBeNull();
  });

  describe('Accounts list', () => {
    it('encrypts the persistent accounts list while unlocked and round-trips it', () => {
      vault.unlocked = true;
      expect(Accounts.add('a@example.com', { apiKey: 'k1' }, true)).toBe(true);

      const stored = localStorage.getItem('webmail_accounts')!;
      expect(stored.startsWith(ENC_PREFIX)).toBe(true);

      const list = Accounts.getPersistent();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ email: 'a@example.com', apiKey: 'k1' });
    });

    it('refuses to modify an encrypted accounts list while locked (no clobber)', () => {
      vault.unlocked = true;
      vault.enabled = true;
      vault.configured = true;
      Accounts.add('a@example.com', { apiKey: 'k1' }, true);
      const sealed = localStorage.getItem('webmail_accounts');

      vault.unlocked = false;
      expect(Accounts.add('b@example.com', { apiKey: 'k2' }, true)).toBe(false);
      expect(localStorage.getItem('webmail_accounts')).toBe(sealed); // untouched
      expect(Accounts.getPersistent()).toEqual([]); // unreadable, not clobbered
    });

    it('skips the legacy single-account migration while locked', () => {
      vault.enabled = true;
      vault.configured = true;
      vault.unlocked = true;
      Accounts.add('a@example.com', { apiKey: 'k1' }, true);
      const sealed = localStorage.getItem('webmail_accounts');

      vault.unlocked = false;
      localStorage.setItem('webmail_email', 'stray@example.com');
      expect(Accounts.init()).toBe(true);
      expect(localStorage.getItem('webmail_accounts')).toBe(sealed);
    });
  });
});
