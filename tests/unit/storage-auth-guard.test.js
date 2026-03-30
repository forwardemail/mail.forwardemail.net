import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock sessionStorage / localStorage ──────────────────────────────
// We need fine-grained control over what each storage returns, so we
// replace the globals with simple Map-backed fakes.
const sessionMap = new Map();
const localMap = new Map();

const fakeSessionStorage = {
  getItem: vi.fn((k) => (sessionMap.has(k) ? sessionMap.get(k) : null)),
  setItem: vi.fn((k, v) => sessionMap.set(k, v)),
  removeItem: vi.fn((k) => sessionMap.delete(k)),
  clear: vi.fn(() => sessionMap.clear()),
  get length() {
    return sessionMap.size;
  },
  key: vi.fn((i) => [...sessionMap.keys()][i] ?? null),
};

const fakeLocalStorage = {
  getItem: vi.fn((k) => (localMap.has(k) ? localMap.get(k) : null)),
  setItem: vi.fn((k, v) => localMap.set(k, v)),
  removeItem: vi.fn((k) => localMap.delete(k)),
  clear: vi.fn(() => localMap.clear()),
  get length() {
    return localMap.size;
  },
  key: vi.fn((i) => [...localMap.keys()][i] ?? null),
};

vi.stubGlobal('sessionStorage', fakeSessionStorage);
vi.stubGlobal('localStorage', fakeLocalStorage);

// Import AFTER stubs are in place
const { Local } = await import('../../src/utils/storage.js');

const PREFIX = 'webmail_';
const ENCRYPTED_PREFIX = '\x00ENC\x01';

beforeEach(() => {
  sessionMap.clear();
  localMap.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  sessionMap.clear();
  localMap.clear();
});

describe('Local.get — encrypted credential guard', () => {
  it('returns plaintext alias_auth from sessionStorage', () => {
    sessionMap.set(`${PREFIX}alias_auth`, 'user@example.com:password123');
    expect(Local.get('alias_auth')).toBe('user@example.com:password123');
  });

  it('returns null when sessionStorage has an encrypted alias_auth blob', () => {
    sessionMap.set(`${PREFIX}alias_auth`, `${ENCRYPTED_PREFIX}ciphertext`);
    expect(Local.get('alias_auth')).toBeNull();
    // The encrypted blob should be removed from sessionStorage
    expect(sessionMap.has(`${PREFIX}alias_auth`)).toBe(false);
  });

  it('falls through to localStorage when sessionStorage is empty', () => {
    localMap.set(`${PREFIX}alias_auth`, 'user@example.com:password123');
    const result = Local.get('alias_auth');
    expect(result).toBe('user@example.com:password123');
    // Should also copy to sessionStorage
    expect(sessionMap.get(`${PREFIX}alias_auth`)).toBe('user@example.com:password123');
  });

  it('returns null when localStorage has an encrypted alias_auth blob', () => {
    localMap.set(`${PREFIX}alias_auth`, `${ENCRYPTED_PREFIX}encrypted-creds`);
    expect(Local.get('alias_auth')).toBeNull();
    // Should NOT copy encrypted value to sessionStorage
    expect(sessionMap.has(`${PREFIX}alias_auth`)).toBe(false);
  });

  it('returns null when localStorage has an encrypted api_key blob', () => {
    localMap.set(`${PREFIX}api_key`, `${ENCRYPTED_PREFIX}encrypted-key`);
    expect(Local.get('api_key')).toBeNull();
  });

  it('returns plaintext api_key from localStorage fallback', () => {
    localMap.set(`${PREFIX}api_key`, 'my-api-key-123');
    expect(Local.get('api_key')).toBe('my-api-key-123');
  });

  it('returns non-tab-scoped keys directly from localStorage (no guard)', () => {
    localMap.set(`${PREFIX}theme`, 'dark');
    expect(Local.get('theme')).toBe('dark');
  });

  it('handles the full scenario: sessionStorage cleared, localStorage encrypted', () => {
    // Simulate: user logged in, app lock encrypted localStorage, then browser cleared sessionStorage
    localMap.set(`${PREFIX}alias_auth`, `${ENCRYPTED_PREFIX}aes-gcm-encrypted-blob`);
    localMap.set(`${PREFIX}email`, 'user@example.com');
    // sessionStorage is empty (cleared by browser)

    // alias_auth should return null (encrypted)
    expect(Local.get('alias_auth')).toBeNull();
    // email is not encrypted, should fall through normally
    expect(Local.get('email')).toBe('user@example.com');
  });
});

describe('Local.get — encrypted blob in sessionStorage (edge case)', () => {
  it('removes encrypted blob from sessionStorage and returns null', () => {
    // This could happen if an encrypted value was somehow written to sessionStorage
    // (e.g. by a bug or race condition during lock/unlock)
    sessionMap.set(`${PREFIX}authToken`, `${ENCRYPTED_PREFIX}some-encrypted-token`);
    expect(Local.get('authToken')).toBeNull();
    expect(sessionMap.has(`${PREFIX}authToken`)).toBe(false);
  });
});
