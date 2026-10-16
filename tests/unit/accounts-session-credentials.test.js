/**
 * "Stay signed in" turned off must mean the account's credentials live in
 * this tab's sessionStorage only, and that one tab never borrows another
 * tab's credentials through the localStorage fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const localMap = new Map();
// Each browser tab has its own sessionStorage. Tests swap this to model a
// second tab or a restart.
let sessionMap = new Map();

const makeStorage = (getMap) => ({
  getItem: (k) => (getMap().has(k) ? getMap().get(k) : null),
  setItem: (k, v) => getMap().set(k, String(v)),
  removeItem: (k) => getMap().delete(k),
  clear: () => getMap().clear(),
  get length() {
    return getMap().size;
  },
  key: (i) => [...getMap().keys()][i] ?? null,
});

vi.stubGlobal(
  'localStorage',
  makeStorage(() => localMap),
);
vi.stubGlobal(
  'sessionStorage',
  makeStorage(() => sessionMap),
);

const remoteRequest = vi.fn();

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('../../src/utils/crypto-store.js', () => ({
  isSensitiveLocalKey: () => false,
  isVaultLocked: () => false,
  protectLocalValue: (_key, value) => value,
  revealLocalValue: (value) => value,
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args) => remoteRequest(...args) },
}));

vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => false,
  cleanupDemoAccount: vi.fn(),
}));

const { Accounts, Local } = await import('../../src/utils/storage.js');
const { getAuthHeader } = await import('../../src/utils/auth.ts');
const { signInWithAliasPassword } = await import('../../src/utils/alias-sign-in.ts');

const SESSION_USER = 'traveller@example.com';
const SESSION_PASSWORD = 'hotel-lobby-pc';

const restartBrowser = () => {
  sessionMap = new Map();
};

const localValues = () => [...localMap.values()].join('\n');

beforeEach(() => {
  localMap.clear();
  sessionMap = new Map();
  remoteRequest.mockReset();
  remoteRequest.mockResolvedValue([{ path: 'INBOX' }]);
});

describe('signing in with "Stay signed in" off', () => {
  it('keeps the password out of localStorage', async () => {
    await signInWithAliasPassword(SESSION_USER, SESSION_PASSWORD, { staySignedIn: false });

    expect(Local.get('email')).toBe(SESSION_USER);
    expect(Local.get('alias_auth')).toBe(`${SESSION_USER}:${SESSION_PASSWORD}`);
    expect(localValues()).not.toContain(SESSION_PASSWORD);
    expect(localMap.has('webmail_alias_auth')).toBe(false);
    expect(localMap.has('webmail_email')).toBe(false);
  });

  it('is signed out after a restart and Accounts.init does not bring it back', async () => {
    await signInWithAliasPassword(SESSION_USER, SESSION_PASSWORD, { staySignedIn: false });

    restartBrowser();
    Accounts.init();

    expect(Accounts.getAll()).toEqual([]);
    expect(Local.get('email')).toBeNull();
    expect(Local.get('alias_auth')).toBeNull();
    expect(getAuthHeader({ allowApiKey: true })).toBe('');
  });

  it('still persists an account signed in with "Stay signed in" on', async () => {
    await signInWithAliasPassword(SESSION_USER, SESSION_PASSWORD, { staySignedIn: true });

    restartBrowser();
    Accounts.init();

    expect(Accounts.getAll().map((a) => a.email)).toEqual([SESSION_USER]);
    expect(Local.get('alias_auth')).toBe(`${SESSION_USER}:${SESSION_PASSWORD}`);
  });

  it('leaves the persistent account to come back to after a restart', async () => {
    await signInWithAliasPassword('desk@example.com', 'desk-secret', { staySignedIn: true });
    await signInWithAliasPassword(SESSION_USER, SESSION_PASSWORD, { staySignedIn: false });
    expect(Local.get('email')).toBe(SESSION_USER);

    restartBrowser();
    Accounts.init();

    expect(Accounts.getAll().map((a) => a.email)).toEqual(['desk@example.com']);
    expect(Accounts.getActive()).toBe('desk@example.com');
    expect(Local.get('alias_auth')).toBe('desk@example.com:desk-secret');
    expect(localValues()).not.toContain(SESSION_PASSWORD);
  });

  it('drops credentials an older build left in localStorage for a session-only account', () => {
    // What earlier versions wrote for a session-only sign-in: the password in
    // localStorage and signMe=0, with no persistent account list.
    localMap.set('webmail_email', SESSION_USER);
    localMap.set('webmail_alias_auth', `${SESSION_USER}:${SESSION_PASSWORD}`);
    localMap.set('webmail_active_account', SESSION_USER);
    localMap.set('webmail_signMe', '0');

    Accounts.init();

    expect(Accounts.getAll()).toEqual([]);
    expect(Local.get('alias_auth')).toBeNull();
    expect(localValues()).not.toContain(SESSION_PASSWORD);
  });
});

describe('credentials across tabs', () => {
  const API_KEY_ACCOUNT = { email: 'billing@example.com', apiKey: 'ak_live_123', aliasAuth: null };
  const ALIAS_ACCOUNT = {
    email: 'support@example.com',
    apiKey: null,
    aliasAuth: 'support@example.com:support-secret',
  };

  it('an API-key tab does not pick up the alias password another tab activated', () => {
    localMap.set('webmail_accounts', JSON.stringify([API_KEY_ACCOUNT, ALIAS_ACCOUNT]));

    // Tab 1 activates the API-key account and reads its credentials.
    const tab1 = new Map();
    sessionMap = tab1;
    Accounts.setActive(API_KEY_ACCOUNT.email);
    expect(getAuthHeader({ allowApiKey: true })).toBe(`Basic ${btoa('ak_live_123:')}`);

    // Tab 2 switches to the alias account; localStorage now holds its set.
    sessionMap = new Map();
    Accounts.setActive(ALIAS_ACCOUNT.email);
    expect(localMap.get('webmail_alias_auth')).toBe(ALIAS_ACCOUNT.aliasAuth);

    // Back in tab 1, which never had an alias_auth of its own.
    sessionMap = tab1;
    expect(Local.get('alias_auth')).toBeNull();
    expect(getAuthHeader({ allowApiKey: true })).toBe(`Basic ${btoa('ak_live_123:')}`);
  });

  it('a fresh tab still adopts the persistent account from localStorage', () => {
    localMap.set('webmail_accounts', JSON.stringify([ALIAS_ACCOUNT]));
    Accounts.setActive(ALIAS_ACCOUNT.email);

    sessionMap = new Map();
    expect(Local.get('alias_auth')).toBe(ALIAS_ACCOUNT.aliasAuth);
    expect(Local.get('email')).toBe(ALIAS_ACCOUNT.email);
  });
});
