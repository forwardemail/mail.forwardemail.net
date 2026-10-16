// @vitest-environment node
/**
 * Boot-time copies of tab-scoped credentials from localStorage into this
 * tab's sessionStorage.
 *
 * localStorage holds one credential set: the persistent account activated
 * last in any tab. A reload must not hand that set to a tab signed in to a
 * different account (an API-key tab picking up another tab's alias password),
 * nor to a tab whose account was signed in without "Stay signed in".
 *
 * Node environment: libsodium's string helpers reject jsdom-realm buffers, and
 * the encrypted branch needs real ciphertext.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const localMap = new Map<string, string>();
const sessionMap = new Map<string, string>();

const makeStorage = (map: Map<string, string>) => ({
  getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
  setItem: (k: string, v: string) => void map.set(k, String(v)),
  removeItem: (k: string) => void map.delete(k),
  clear: () => map.clear(),
  get length() {
    return map.size;
  },
  key: (i: number) => [...map.keys()][i] ?? null,
});

vi.stubGlobal('localStorage', makeStorage(localMap));
vi.stubGlobal('sessionStorage', makeStorage(sessionMap));

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('../../src/utils/db-crypto-bridge.js', () => ({
  syncDbCryptoState: vi.fn().mockResolvedValue(undefined),
}));

const cryptoStore = await import('../../src/utils/crypto-store.js');

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const ALICE_ALIAS_PASSWORD = 'alice-generated-alias-password';
const BOB_API_KEY = 'bob-api-key-0123456789abcdef';

const signInAsPersistentAlice = (encrypt: (v: string) => string = (v) => v) => {
  localMap.set('webmail_email', ALICE);
  localMap.set('webmail_alias_auth', encrypt(`${ALICE}:${ALICE_ALIAS_PASSWORD}`));
};

const bobTabSession = () => {
  // Bob signed in with an API key in this tab only, so he has no alias_auth.
  sessionMap.set('webmail_email', BOB);
  sessionMap.set('webmail_api_key', BOB_API_KEY);
  sessionMap.set(
    'webmail_session_accounts',
    JSON.stringify([{ email: BOB, apiKey: BOB_API_KEY, aliasAuth: '' }]),
  );
};

beforeEach(() => {
  localMap.clear();
  sessionMap.clear();
});

describe('copyPlainCredentialsToSession (no App Lock)', () => {
  it("does not give an API-key tab another account's alias password", () => {
    signInAsPersistentAlice();
    // Bob is persistent too here, just not the account activated last.
    sessionMap.set('webmail_email', BOB);
    sessionMap.set('webmail_api_key', BOB_API_KEY);

    cryptoStore.copyPlainCredentialsToSession();

    expect(sessionMap.get('webmail_alias_auth')).toBeUndefined();
    expect(sessionMap.get('webmail_api_key')).toBe(BOB_API_KEY);
    expect(sessionMap.get('webmail_email')).toBe(BOB);
  });

  it('does not give a session-only tab the persistent account credentials', () => {
    signInAsPersistentAlice();
    localMap.set('webmail_email', BOB);
    bobTabSession();

    cryptoStore.copyPlainCredentialsToSession();

    expect(sessionMap.get('webmail_alias_auth')).toBeUndefined();
  });

  it('restores credentials the browser dropped from a tab of the same account', () => {
    signInAsPersistentAlice();
    sessionMap.set('webmail_email', 'Alice@Example.com');

    cryptoStore.copyPlainCredentialsToSession();

    expect(sessionMap.get('webmail_alias_auth')).toBe(`${ALICE}:${ALICE_ALIAS_PASSWORD}`);
  });

  it('fills a fresh tab with the persistent account', () => {
    signInAsPersistentAlice();

    cryptoStore.copyPlainCredentialsToSession();

    expect(sessionMap.get('webmail_email')).toBe(ALICE);
    expect(sessionMap.get('webmail_alias_auth')).toBe(`${ALICE}:${ALICE_ALIAS_PASSWORD}`);
  });
});

describe('restoreSessionCredentials (App Lock unlocked)', () => {
  beforeAll(async () => {
    // Same-tab reload path: vault configured, DEK stashed in this session.
    const sodium = await cryptoStore.getSodium();
    localMap.set('webmail_crypto_vault', JSON.stringify({ encryptedDek: 'sealed' }));
    localMap.set('webmail_lock_prefs', JSON.stringify({ enabled: true }));
    sessionMap.set('webmail_lock_session_unlocked', '1');
    sessionMap.set(
      'webmail_lock_session_dek',
      sodium.to_base64(sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES)),
    );
    expect(await cryptoStore.restoreSessionDek()).toBe(true);
  });

  it('leaves an API-key tab on its own account after unlock', () => {
    signInAsPersistentAlice(cryptoStore.encryptValue);
    sessionMap.set('webmail_email', BOB);
    sessionMap.set('webmail_api_key', BOB_API_KEY);

    cryptoStore.restoreSessionCredentials();

    expect(sessionMap.get('webmail_alias_auth')).toBeUndefined();
    expect(sessionMap.get('webmail_email')).toBe(BOB);
    expect(sessionMap.get('webmail_api_key')).toBe(BOB_API_KEY);
  });

  it('leaves a session-only tab alone even when localStorage is plaintext', () => {
    signInAsPersistentAlice();
    bobTabSession();

    cryptoStore.restoreSessionCredentials();

    expect(sessionMap.get('webmail_alias_auth')).toBeUndefined();
    expect(sessionMap.get('webmail_email')).toBe(BOB);
  });

  it('decrypts the credentials for a tab of the same account', () => {
    signInAsPersistentAlice(cryptoStore.encryptValue);
    sessionMap.set('webmail_email', ALICE);

    cryptoStore.restoreSessionCredentials();

    expect(sessionMap.get('webmail_alias_auth')).toBe(`${ALICE}:${ALICE_ALIAS_PASSWORD}`);
  });
});

describe('getIdbKeyForComposeWindow', () => {
  it('returns the IDB subkey as base64 that atob decodes to the same 32 bytes', async () => {
    localMap.set('webmail_crypto_vault', JSON.stringify({ encryptedDek: 'sealed' }));
    localMap.set('webmail_lock_prefs', JSON.stringify({ enabled: true }));
    expect(cryptoStore.isUnlocked()).toBe(true);

    const encoded = await cryptoStore.getIdbKeyForComposeWindow();
    const expected = await cryptoStore.getIdbCryptoMaterial();

    expect(typeof encoded).toBe('string');
    // compose-main.ts decodes with atob, which rejects the URL-safe alphabet.
    const binary = atob(encoded as string);
    const decoded = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    expect(decoded).toHaveLength(32);
    expect([...decoded]).toEqual([...(expected as Uint8Array)]);
  });

  it('returns nothing while App Lock is off', async () => {
    localMap.set('webmail_crypto_vault', JSON.stringify({ encryptedDek: 'sealed' }));
    localMap.set('webmail_lock_prefs', JSON.stringify({ enabled: false }));

    expect(await cryptoStore.getIdbKeyForComposeWindow()).toBeUndefined();
  });

  it('returns nothing once the vault is locked', async () => {
    localMap.set('webmail_crypto_vault', JSON.stringify({ encryptedDek: 'sealed' }));
    localMap.set('webmail_lock_prefs', JSON.stringify({ enabled: true }));
    cryptoStore.lock();

    expect(await cryptoStore.getIdbKeyForComposeWindow()).toBeUndefined();
  });
});
