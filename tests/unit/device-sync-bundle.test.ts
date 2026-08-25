/**
 * Bundle collection and import planning for QR device pairing.
 *
 * The merge rules are the part worth guarding. PGP passphrases are keyed by the
 * key's NAME (see Settings.svelte removeKey and mailService loadStoredPassphrases),
 * so any import that renames a key on collision has to move its passphrase with
 * it or decryption quietly stops working on the new device. Losing a private
 * key is unrecoverable, so a name clash keeps both keys rather than picking one.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const localMap = new Map<string, string>();
let accountRows: { email: string; aliasAuth?: string | null; apiKey?: string | null }[] = [];
let addSucceeds = true;
const addSpy = vi.fn();
const setActiveSpy = vi.fn();

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (key: string) => (localMap.has(key) ? localMap.get(key)! : null),
    set: (key: string, value: string) => localMap.set(key, value),
    remove: (key: string) => localMap.delete(key),
  },
  Accounts: {
    getAll: () => accountRows,
    add: (email: string, credentials: unknown, staySignedIn: boolean) => {
      addSpy(email, credentials, staySignedIn);
      if (!addSucceeds) return false;
      accountRows = [
        ...accountRows.filter((a) => a.email !== email),
        { email, ...(credentials as object) },
      ];
      return true;
    },
    setActive: (email: string) => {
      setActiveSpy(email);
      return true;
    },
  },
}));

const metaRows = new Map<string, { key: string; value: unknown; updatedAt: number }>();

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: {
      where: () => ({
        startsWith: (prefix: string) => ({
          toArray: async () => [...metaRows.values()].filter((row) => row.key.startsWith(prefix)),
        }),
      }),
      put: async (row: { key: string; value: unknown; updatedAt: number }) => {
        metaRows.set(row.key, row);
      },
    },
  },
}));

const { collectBundle, planImport, applyPlan, readCurrentState } =
  await import('../../src/utils/device-sync/bundle');
const { sealBundle, openSealedBundle } = await import('../../src/utils/device-sync/seal');
const { encodeFrames, FrameCollector } = await import('../../src/utils/device-sync/frames');

const ACCOUNT = 'user@example.com';
const SOURCE = { app: 'desktop' as const, os: 'macos', name: 'test-mbp' };
const NOW = 1_760_000_000_000;

const KEY_A = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nAAAA\n-----END PGP PRIVATE KEY BLOCK-----';
const KEY_B = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nBBBB\n-----END PGP PRIVATE KEY BLOCK-----';

beforeEach(() => {
  localMap.clear();
  metaRows.clear();
  accountRows = [{ email: ACCOUNT, aliasAuth: `${ACCOUNT}:hunter2`, apiKey: null }];
  addSucceeds = true;
  addSpy.mockClear();
  setActiveSpy.mockClear();
});

const emptyState = async () => readCurrentState(ACCOUNT);

/**
 * The exact three-step import the scanner performs. applyBundle used to wrap
 * this but had no production caller, so the tests exercise the real path.
 */
const importBundle = async (
  bundle: Parameters<typeof planImport>[0],
  options: { account: string; activate?: boolean },
) => {
  const current = await readCurrentState(options.account);
  const plan = planImport(bundle, current);
  return applyPlan(plan, bundle, options);
};

describe('collectBundle', () => {
  it('collects only the buckets that were asked for', async () => {
    localMap.set(`pgp_keys_${ACCOUNT}`, JSON.stringify([{ name: 'work', value: KEY_A }]));
    localMap.set('theme', 'dark');

    const bundle = await collectBundle({
      account: ACCOUNT,
      include: { account: false, pgp: true, settings: false },
      source: SOURCE,
      now: NOW,
    });

    expect(bundle.account).toBeUndefined();
    expect(bundle.settings).toBeUndefined();
    expect(bundle.pgp?.keys).toEqual([{ name: 'work', value: KEY_A }]);
    expect(bundle.exp).toBe(bundle.iat + 180);
  });

  it('omits settings the user never set instead of exporting their defaults', async () => {
    localMap.set('theme', 'dark');

    const bundle = await collectBundle({
      account: ACCOUNT,
      include: { settings: true },
      source: SOURCE,
      now: NOW,
    });

    expect(bundle.settings).toEqual({ theme: 'dark' });
    expect(bundle.settings).not.toHaveProperty('compose_plain_default');
  });

  it('leaves form-factor-bound settings behind', async () => {
    localMap.set('theme', 'dark');
    localMap.set('layout_mode', 'full');
    localMap.set('sync_page_size', '50');
    localMap.set('list_density', 'compact');

    const bundle = await collectBundle({
      account: ACCOUNT,
      include: { settings: true },
      source: SOURCE,
      now: NOW,
    });

    expect(Object.keys(bundle.settings ?? {})).toEqual(['theme']);
  });

  it('carries the signature but not the profile image', async () => {
    localMap.set(`signature_${ACCOUNT}`, 'Sent from my desk');
    localMap.set(`profile_name_${ACCOUNT}`, 'Shaun');
    localMap.set(`profile_image_${ACCOUNT}`, 'data:image/png;base64,AAAA');

    const bundle = await collectBundle({
      account: ACCOUNT,
      include: { settings: true },
      source: SOURCE,
      now: NOW,
    });

    expect(bundle.extras).toEqual({ signature: 'Sent from my desk', profile_name: 'Shaun' });
  });

  it('refuses to build a sign-in bundle when no credentials can be read', async () => {
    // What a locked App Lock vault looks like from here: the account list
    // decrypts to nothing, so a bundle would ship with no way to fetch mail.
    accountRows = [];

    await expect(
      collectBundle({ account: ACCOUNT, include: { account: true }, source: SOURCE, now: NOW }),
    ).rejects.toMatchObject({ code: 'BAD_KEY' });
  });
});

describe('planImport', () => {
  const bundleWith = (pgp: {
    keys: { name: string; value: string }[];
    passphrases?: Record<string, string>;
  }) => ({
    v: 1,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 180,
    src: SOURCE,
    pgp: { keys: pgp.keys, passphrases: pgp.passphrases ?? {} },
  });

  it('skips a key already held, even under a different name', async () => {
    localMap.set(`pgp_keys_${ACCOUNT}`, JSON.stringify([{ name: 'personal', value: KEY_A }]));

    const plan = planImport(
      bundleWith({ keys: [{ name: 'work', value: KEY_A }] }),
      await emptyState(),
    );

    expect(plan.pgp?.added).toEqual([]);
    expect(plan.pgp?.duplicates).toHaveLength(1);
  });

  it('fills a missing passphrase for a key that is already present', async () => {
    localMap.set(`pgp_keys_${ACCOUNT}`, JSON.stringify([{ name: 'personal', value: KEY_A }]));

    const plan = planImport(
      bundleWith({ keys: [{ name: 'work', value: KEY_A }], passphrases: { work: 's3cret' } }),
      await emptyState(),
    );

    // Stored under the name this device already uses, not the sender's name.
    expect(plan.pgp?.passphrases).toEqual({ personal: 's3cret' });
  });

  it('never overwrites a passphrase this device already has', async () => {
    localMap.set(`pgp_keys_${ACCOUNT}`, JSON.stringify([{ name: 'personal', value: KEY_A }]));
    localMap.set(`pgp_passphrases_${ACCOUNT}`, JSON.stringify({ personal: 'local-one' }));

    const plan = planImport(
      bundleWith({
        keys: [{ name: 'personal', value: KEY_A }],
        passphrases: { personal: 'incoming' },
      }),
      await emptyState(),
    );

    expect(plan.pgp?.passphrases).toEqual({});
  });

  it('keeps both keys on a name clash and moves the passphrase to the new name', async () => {
    localMap.set(`pgp_keys_${ACCOUNT}`, JSON.stringify([{ name: 'work', value: KEY_A }]));

    const plan = planImport(
      bundleWith({ keys: [{ name: 'work', value: KEY_B }], passphrases: { work: 'incoming' } }),
      await emptyState(),
    );

    expect(plan.pgp?.added).toEqual([{ name: 'work (imported)', value: KEY_B }]);
    expect(plan.pgp?.renamed).toEqual([{ from: 'work', to: 'work (imported)' }]);
    expect(plan.pgp?.passphrases).toEqual({ 'work (imported)': 'incoming' });
  });

  it('treats armor differing only in line endings as the same key', async () => {
    localMap.set(`pgp_keys_${ACCOUNT}`, JSON.stringify([{ name: 'work', value: KEY_A }]));

    const plan = planImport(
      bundleWith({ keys: [{ name: 'work', value: `${KEY_A.replace(/\n/g, '\r\n')}\n` }] }),
      await emptyState(),
    );

    expect(plan.pgp?.added).toEqual([]);
  });

  it('lists only settings that would actually change', async () => {
    localMap.set('theme', 'dark');

    const plan = planImport(
      {
        v: 1,
        iat: 0,
        exp: Math.floor(NOW / 1000) + 180,
        src: SOURCE,
        settings: { theme: 'dark', compose_plain_default: true },
      },
      await emptyState(),
    );

    expect(plan.settings).toEqual([
      { id: 'compose_plain_default', label: 'Plain Text Default', from: null, to: 'true' },
    ]);
  });

  it('ignores settings a bundle claims but the registry does not mark portable', async () => {
    const plan = planImport(
      {
        v: 1,
        iat: 0,
        exp: Math.floor(NOW / 1000) + 180,
        src: SOURCE,
        settings: { layout_mode: 'classic', sync_page_size: 99, theme: 'dark' },
      },
      await emptyState(),
    );

    expect(plan.settings.map((change) => change.id)).toEqual(['theme']);
  });

  it('separates new saved searches from ones being replaced', async () => {
    metaRows.set(`saved_search_${ACCOUNT}_urgent`, {
      key: `saved_search_${ACCOUNT}_urgent`,
      value: { name: 'urgent', query: 'is:unread' },
      updatedAt: 1,
    });

    const plan = planImport(
      {
        v: 1,
        iat: 0,
        exp: Math.floor(NOW / 1000) + 180,
        src: SOURCE,
        savedSearches: [
          { name: 'urgent', value: { name: 'urgent', query: 'is:starred' } },
          { name: 'receipts', value: { name: 'receipts', query: 'invoice' } },
        ],
      },
      await emptyState(),
    );

    expect(plan.savedSearches.updated.map((s) => s.name)).toEqual(['urgent']);
    expect(plan.savedSearches.added.map((s) => s.name)).toEqual(['receipts']);
  });
});

describe('applyPlan', () => {
  it('appends imported keys rather than replacing what is there', async () => {
    localMap.set(`pgp_keys_${ACCOUNT}`, JSON.stringify([{ name: 'work', value: KEY_A }]));
    const bundle = {
      v: 1,
      iat: 0,
      exp: Math.floor(NOW / 1000) + 180,
      src: SOURCE,
      pgp: { keys: [{ name: 'personal', value: KEY_B }], passphrases: { personal: 'pw' } },
    };

    await importBundle(bundle, { account: ACCOUNT });

    expect(JSON.parse(localMap.get(`pgp_keys_${ACCOUNT}`)!)).toEqual([
      { name: 'work', value: KEY_A },
      { name: 'personal', value: KEY_B },
    ]);
    expect(JSON.parse(localMap.get(`pgp_passphrases_${ACCOUNT}`)!)).toEqual({ personal: 'pw' });
  });

  it('activates the account only when asked', async () => {
    const bundle = {
      v: 1,
      iat: 0,
      exp: Math.floor(NOW / 1000) + 180,
      src: SOURCE,
      account: { email: 'new@example.com', aliasAuth: 'new@example.com:pw', apiKey: null },
    };

    const quiet = await importBundle(bundle, { account: 'new@example.com' });
    expect(quiet.activatedAccount).toBeNull();
    expect(setActiveSpy).not.toHaveBeenCalled();

    const loud = await importBundle(bundle, { account: 'new@example.com', activate: true });
    expect(loud.activatedAccount).toBe('new@example.com');
    expect(setActiveSpy).toHaveBeenCalledWith('new@example.com');
  });

  it('surfaces a refused account write instead of reporting a silent success', async () => {
    // Accounts.add returns false while the vault is locked rather than
    // clobbering the encrypted account list.
    addSucceeds = false;
    const bundle = {
      v: 1,
      iat: 0,
      exp: Math.floor(NOW / 1000) + 180,
      src: SOURCE,
      account: { email: 'new@example.com', aliasAuth: 'new@example.com:pw', apiKey: null },
    };

    await expect(importBundle(bundle, { account: 'new@example.com' })).rejects.toMatchObject({
      code: 'BAD_KEY',
    });
  });

  it('writes nothing for a bundle whose values already match', async () => {
    localMap.set('theme', 'dark');
    const before = new Map(localMap);

    const result = await importBundle(
      { v: 1, iat: 0, exp: Math.floor(NOW / 1000) + 180, src: SOURCE, settings: { theme: 'dark' } },
      { account: ACCOUNT },
    );

    expect(result.plan.settings).toEqual([]);
    expect([...localMap.entries()]).toEqual([...before.entries()]);
  });
});

describe('end to end', () => {
  it('carries keys and settings from one device to another through frames', async () => {
    localMap.set(`pgp_keys_${ACCOUNT}`, JSON.stringify([{ name: 'work', value: KEY_A }]));
    localMap.set(`pgp_passphrases_${ACCOUNT}`, JSON.stringify({ work: 'hunter2' }));
    localMap.set('theme', 'dark');
    localMap.set(`signature_${ACCOUNT}`, 'Sent from my desk');

    const bundle = await collectBundle({
      account: ACCOUNT,
      include: { account: true, pgp: true, settings: true },
      source: SOURCE,
      now: NOW,
    });

    const { key, sealed } = await sealBundle(bundle);
    const frames = encodeFrames({ sealed, key });

    // The receiving device: a blank slate, frames arriving in camera order.
    localMap.clear();
    accountRows = [];

    const collector = new FrameCollector();
    for (const frame of [...frames].reverse()) collector.accept(frame);
    const assembled = collector.assemble();

    const received = await openSealedBundle(assembled.sealed, assembled.key, { now: NOW });
    const result = await importBundle(received, { account: ACCOUNT, activate: true });

    expect(result.activatedAccount).toBe(ACCOUNT);
    expect(JSON.parse(localMap.get(`pgp_keys_${ACCOUNT}`)!)).toEqual([
      { name: 'work', value: KEY_A },
    ]);
    expect(JSON.parse(localMap.get(`pgp_passphrases_${ACCOUNT}`)!)).toEqual({ work: 'hunter2' });
    expect(localMap.get('theme')).toBe('dark');
    expect(localMap.get(`signature_${ACCOUNT}`)).toBe('Sent from my desk');
    expect(addSpy).toHaveBeenCalledWith(
      ACCOUNT,
      { aliasAuth: `${ACCOUNT}:hunter2`, apiKey: null },
      true,
    );
  });
});
