/**
 * Removing an account must delete everything stored for it, and nothing
 * stored for anyone else. Another tab's session-only account must not be
 * mistaken for an orphan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const localMap = new Map();
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

// In-memory stand-in for the db worker client. Like the real client, a
// startsWith() query lists rows correctly, while startsWith().delete() is
// sent as an exact-key delete.
const { tables } = vi.hoisted(() => ({ tables: new Map() }));

vi.mock('../../src/utils/db', () => {
  const ACCOUNT_TABLES = [
    'folders',
    'messages',
    'messageBodies',
    'searchIndex',
    'indexMeta',
    'drafts',
    'settings',
    'settingsLabels',
    'outbox',
    'labels',
    'syncManifests',
  ];
  const rows = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  const keep = (name, predicate) => tables.set(name, rows(name).filter(predicate));
  const makeTable = (name) => ({
    toArray: async () => [...rows(name)],
    get: async (key) => rows(name).find((r) => r.key === key || r.account === key),
    put: async (record) => {
      keep(name, (r) => r.key !== record.key);
      rows(name).push(record);
    },
    bulkDelete: async (keys) => keep(name, (r) => !keys.includes(r.key)),
    where: (field) => ({
      equals: (value) => ({
        toArray: async () => rows(name).filter((r) => r[field] === value),
        delete: async () => keep(name, (r) => r[field] !== value),
      }),
      startsWith: (prefix) => ({
        toArray: async () => rows(name).filter((r) => String(r[field]).startsWith(prefix)),
        delete: async () => keep(name, (r) => r[field] !== prefix),
      }),
    }),
  });
  const db = { transaction: async (_mode, _tables, cb) => cb() };
  for (const name of [...ACCOUNT_TABLES, 'meta']) db[name] = makeTable(name);
  return { db };
});

vi.mock('../../src/utils/crypto-store.js', () => ({
  isSensitiveLocalKey: () => false,
  isVaultLocked: () => false,
  protectLocalValue: (_key, value) => value,
  revealLocalValue: (value) => value,
}));

const { Accounts, Local, reconcileOrphanedAccountData, clearAccountPgpData } =
  await import('../../src/utils/storage.js');

const LEAVING = 'pat@example.com';
// Shares LEAVING as a prefix; its data must survive.
const NEIGHBOUR = 'pat@example.com.au';

// pending_account_deletes is the removal bookkeeping row, not account data.
const metaKeys = () =>
  (tables.get('meta') || [])
    .map((r) => r.key)
    .filter((key) => key !== 'pending_account_deletes')
    .sort();

const seedMeta = (account) => [
  { key: `mutation_queue_${account}`, value: [] },
  { key: `contacts_v2_${account}`, value: [] },
  { key: `saved_search_${account}_Invoices`, value: { query: 'invoice' } },
  { key: `att_blob_${account}_<msg-1@example.com>_report.pdf`, value: 'data:application/pdf' },
  { key: `calendars_${account}`, value: [] },
  { key: `calendar_events_${account}_all`, value: [] },
  { key: `calendar_events_${account}_cal-1`, value: [] },
  { key: `calendar_prefs_${account}`, value: {} },
];

const seedLocal = (account) => {
  const keys = [
    `pgp_keys_${account}`,
    `pgp_passphrases_${account}`,
    `pgp_recipients_${account}`,
    `signature_${account}`,
    `signature_html_${account}`,
    `signature_enabled_${account}`,
    `profile_name_${account.toLowerCase()}`,
    `profile_image_${account.toLowerCase()}`,
    `sent_folder_${account}`,
    `default_calendar_id_${account}`,
  ];
  keys.forEach((key) => localMap.set(`webmail_${key}`, 'value'));
  return keys;
};

beforeEach(() => {
  localMap.clear();
  sessionMap = new Map();
  tables.clear();
  tables.set('meta', [
    ...seedMeta(LEAVING),
    ...seedMeta(NEIGHBOUR),
    {
      key: 'att_cache_manifest',
      value: {
        totalBytes: 300,
        entries: [
          { key: `att_blob_${LEAVING}_<msg-1@example.com>_report.pdf`, size: 100 },
          { key: `att_blob_${NEIGHBOUR}_<msg-1@example.com>_report.pdf`, size: 200 },
        ],
      },
    },
  ]);
  tables.set('folders', [
    { account: LEAVING, path: 'INBOX' },
    { account: NEIGHBOUR, path: 'INBOX' },
  ]);
  localMap.set(
    'webmail_accounts',
    JSON.stringify([
      { email: LEAVING, aliasAuth: `${LEAVING}:pw1` },
      { email: NEIGHBOUR, aliasAuth: `${NEIGHBOUR}:pw2` },
    ]),
  );
  Accounts.setActive(NEIGHBOUR);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Accounts.remove', () => {
  it('deletes every per-account meta row and local value, and nothing of a prefix match', async () => {
    const leavingLocal = seedLocal(LEAVING);
    const neighbourLocal = seedLocal(NEIGHBOUR);

    expect(await Accounts.remove(LEAVING)).toBe(true);

    expect(metaKeys()).toEqual(
      ['att_cache_manifest', ...seedMeta(NEIGHBOUR).map((r) => r.key)].sort(),
    );
    for (const key of leavingLocal) expect(localMap.has(`webmail_${key}`)).toBe(false);
    for (const key of neighbourLocal) expect(localMap.get(`webmail_${key}`)).toBe('value');
    expect(tables.get('folders')).toEqual([{ account: NEIGHBOUR, path: 'INBOX' }]);
  });

  it('drops the removed attachments from the attachment cache manifest', async () => {
    await Accounts.remove(LEAVING);

    const manifest = tables.get('meta').find((r) => r.key === 'att_cache_manifest').value;
    expect(manifest.entries.map((e) => e.key)).toEqual([
      `att_blob_${NEIGHBOUR}_<msg-1@example.com>_report.pdf`,
    ]);
    expect(manifest.totalBytes).toBe(200);
  });

  it('removes an account given in a different case', async () => {
    seedLocal(LEAVING);
    expect(await Accounts.remove('Pat@Example.com')).toBe(true);

    expect(Accounts.getAll().map((a) => a.email)).toEqual([NEIGHBOUR]);
    expect(metaKeys()).not.toContain(`contacts_v2_${LEAVING}`);
    expect(localMap.has(`webmail_signature_${LEAVING}`)).toBe(false);
  });

  it('still clears the cache when the account is already off the list', async () => {
    localMap.set(
      'webmail_accounts',
      JSON.stringify([{ email: NEIGHBOUR, aliasAuth: `${NEIGHBOUR}:pw2` }]),
    );

    await Accounts.remove(LEAVING);

    expect(tables.get('folders')).toEqual([{ account: NEIGHBOUR, path: 'INBOX' }]);
    expect(metaKeys()).not.toContain(`mutation_queue_${LEAVING}`);
  });
});

describe('clearAccountPgpData', () => {
  it('removes only this account’s private keys and passphrases', () => {
    seedLocal(LEAVING);
    seedLocal(NEIGHBOUR);
    localMap.set('webmail_theme', 'dark');

    clearAccountPgpData(LEAVING);

    expect(localMap.has(`webmail_pgp_keys_${LEAVING}`)).toBe(false);
    expect(localMap.has(`webmail_pgp_passphrases_${LEAVING}`)).toBe(false);
    expect(localMap.get(`webmail_pgp_keys_${NEIGHBOUR}`)).toBe('value');
    expect(localMap.get(`webmail_signature_${LEAVING}`)).toBe('value');
    expect(localMap.get('webmail_accounts')).toBeTruthy();
    expect(localMap.get('webmail_theme')).toBe('dark');
    expect(Local.get('alias_auth')).toBe(`${NEIGHBOUR}:pw2`);
  });
});

describe('reconcileOrphanedAccountData with a second tab', () => {
  const SESSION_ACCOUNT = 'kiosk@example.com';

  const signInSessionOnlyInTab1 = () => {
    const tab1 = new Map();
    sessionMap = tab1;
    Accounts.add(SESSION_ACCOUNT, { aliasAuth: `${SESSION_ACCOUNT}:pw3` }, false);
    Accounts.setActive(SESSION_ACCOUNT);
    tables.get('folders').push({ account: SESSION_ACCOUNT, path: 'INBOX' });
    return tab1;
  };

  it('keeps the cache of a session-only account that is open in another tab', async () => {
    signInSessionOnlyInTab1();

    // Tab 2 only knows the persistent accounts.
    sessionMap = new Map();
    const result = await reconcileOrphanedAccountData();

    expect(result.orphans).toEqual([]);
    expect(tables.get('folders').map((f) => f.account)).toContain(SESSION_ACCOUNT);
  });

  it('cleans it up once that tab has been gone longer than the lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
    signInSessionOnlyInTab1();

    // The tab closed; nothing refreshes the lease any more.
    sessionMap = new Map();
    vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
    const result = await reconcileOrphanedAccountData();

    expect(result.orphans).toEqual([SESSION_ACCOUNT]);
    expect(tables.get('folders').map((f) => f.account)).not.toContain(SESSION_ACCOUNT);
  });

  it('does not write the session-only address into localStorage', () => {
    signInSessionOnlyInTab1();
    expect([...localMap.values()].join('\n')).not.toContain(SESSION_ACCOUNT);
  });
});
