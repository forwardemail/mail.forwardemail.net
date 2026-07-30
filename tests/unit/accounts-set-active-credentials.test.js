/**
 * Credential handover when the active account changes.
 *
 * getAuthHeader() prefers `alias_auth` and falls back to `api_key`, and
 * Local.get() for a credential key reads sessionStorage first, then falls back
 * to localStorage — copying whatever it finds there back into sessionStorage.
 *
 * setActive routes an account's credentials to sessionStorage or localStorage
 * depending on whether the user asked to stay signed in, then mirrors them into
 * Local for the API layer. That mirror used to write only the keys the INCOMING
 * account owned. For a session-only account it therefore cleared the session
 * copy but left the previous account's credential sitting in localStorage,
 * where the very next Local.get() found it and revived it: the UI showed the
 * new account while every request authenticated as the old one.
 *
 * Both keys are now mirrored unconditionally — set when present, removed when
 * absent — so the handover cannot leave one behind.
 */

const sessionMap = new Map();
const localMap = new Map();

const makeStorage = (map) => ({
  getItem: vi.fn((k) => (map.has(k) ? map.get(k) : null)),
  setItem: vi.fn((k, v) => map.set(k, v)),
  removeItem: vi.fn((k) => map.delete(k)),
  clear: vi.fn(() => map.clear()),
  get length() {
    return map.size;
  },
  key: vi.fn((i) => [...map.keys()][i] ?? null),
});

vi.stubGlobal('sessionStorage', makeStorage(sessionMap));
vi.stubGlobal('localStorage', makeStorage(localMap));

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
    folders: { toArray: vi.fn().mockResolvedValue([]) },
    settings: { toArray: vi.fn().mockResolvedValue([]) },
    drafts: { toArray: vi.fn().mockResolvedValue([]) },
    outbox: { toArray: vi.fn().mockResolvedValue([]) },
    labels: { toArray: vi.fn().mockResolvedValue([]) },
    syncManifests: { toArray: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../../src/utils/crypto-store.js', () => ({
  isSensitiveLocalKey: vi.fn(() => false),
  isLockEnabled: vi.fn(() => false),
  isVaultConfigured: vi.fn(() => false),
  isUnlocked: vi.fn(() => false),
  protectLocalValue: vi.fn((_key, value) => value),
  revealLocalValue: vi.fn((value) => value),
}));

const { Accounts, Local } = await import('../../src/utils/storage.js');
const { getAuthHeader } = await import('../../src/utils/auth.ts');

// "Keep me signed in" — credentials live in localStorage.
const PERSISTENT_ALIAS = {
  email: 'alias-user@example.com',
  aliasAuth: 'alias-user@example.com:alias-secret',
  apiKey: null,
};
// Session-only — credentials live in sessionStorage, and this is the account
// whose handover used to leave the previous one's credential in localStorage.
const SESSION_API_KEY = {
  email: 'apikey-user@example.com',
  aliasAuth: null,
  apiKey: 'api-key-value',
};
const SESSION_ALIAS = {
  email: 'second-alias@example.com',
  aliasAuth: 'second-alias@example.com:other-secret',
  apiKey: null,
};

function seedAccounts({ persistent = [], session = [] }) {
  if (persistent.length) localMap.set('webmail_accounts', JSON.stringify(persistent));
  if (session.length) sessionMap.set('webmail_session_accounts', JSON.stringify(session));
}

beforeEach(() => {
  sessionMap.clear();
  localMap.clear();
  vi.clearAllMocks();
});

describe('Accounts.setActive credential handover', () => {
  it('drops the previous alias password when a session-only API-key account takes over', () => {
    seedAccounts({ persistent: [PERSISTENT_ALIAS], session: [SESSION_API_KEY] });

    expect(Accounts.setActive(PERSISTENT_ALIAS.email)).toBe(true);
    expect(Local.get('alias_auth')).toBe(PERSISTENT_ALIAS.aliasAuth);

    expect(Accounts.setActive(SESSION_API_KEY.email)).toBe(true);

    expect(Local.get('email')).toBe(SESSION_API_KEY.email);
    expect(Local.get('alias_auth')).toBeNull();
    expect(Local.get('api_key')).toBe(SESSION_API_KEY.apiKey);
    // The localStorage copy is gone too — a sessionStorage-only clear would be
    // undone by the next Local.get(), which falls back to localStorage.
    expect(localMap.get('webmail_alias_auth')).toBeUndefined();
  });

  it('authenticates as the account that is actually active', () => {
    // The point of removing the key rather than just overwriting the session
    // copy: getAuthHeader prefers alias_auth over api_key, so a surviving
    // alias_auth wins outright and every request goes out as the old account.
    seedAccounts({ persistent: [PERSISTENT_ALIAS], session: [SESSION_API_KEY] });
    Accounts.setActive(PERSISTENT_ALIAS.email);
    Accounts.setActive(SESSION_API_KEY.email);

    const header = getAuthHeader({ allowApiKey: true });
    expect(header).toBe(`Basic ${btoa(`${SESSION_API_KEY.apiKey}:`)}`);
    expect(header).not.toContain(btoa(PERSISTENT_ALIAS.aliasAuth));
  });

  it('replaces one alias password with the next rather than keeping both', () => {
    seedAccounts({ persistent: [PERSISTENT_ALIAS], session: [SESSION_ALIAS] });
    Accounts.setActive(PERSISTENT_ALIAS.email);
    Accounts.setActive(SESSION_ALIAS.email);

    expect(Local.get('alias_auth')).toBe(SESSION_ALIAS.aliasAuth);
    expect(getAuthHeader({ allowApiKey: true })).toBe(`Basic ${btoa(SESSION_ALIAS.aliasAuth)}`);
  });

  it('drops a stale API key when an alias account takes over', () => {
    seedAccounts({ persistent: [PERSISTENT_ALIAS], session: [SESSION_API_KEY] });
    Accounts.setActive(SESSION_API_KEY.email);
    Accounts.setActive(PERSISTENT_ALIAS.email);

    expect(Local.get('api_key')).toBeNull();
    expect(Local.get('alias_auth')).toBe(PERSISTENT_ALIAS.aliasAuth);
  });

  it('refuses to activate an account it does not know', () => {
    seedAccounts({ persistent: [PERSISTENT_ALIAS] });
    Accounts.setActive(PERSISTENT_ALIAS.email);

    expect(Accounts.setActive('stranger@example.com')).toBe(false);
    // Credentials are untouched by a rejected switch.
    expect(Local.get('email')).toBe(PERSISTENT_ALIAS.email);
    expect(Local.get('alias_auth')).toBe(PERSISTENT_ALIAS.aliasAuth);
  });
});
