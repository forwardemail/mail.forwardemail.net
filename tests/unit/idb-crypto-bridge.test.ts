/**
 * db-crypto-bridge: the config it hands the db engine around App Lock
 * transitions, and the key hand-over used by the desktop compose window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  provider: null as null | (() => Promise<Record<string, unknown>>),
  sent: [] as Array<Record<string, unknown>>,
  lockEnabled: true,
  unlocked: true,
  duringUnseal: null as null | Record<string, unknown>,
  abandoned: 0,
  cleared: 0,
}));

const KEY = new Uint8Array(32).fill(5);

vi.mock('../../src/utils/db-worker-client.js', () => ({
  setCryptoConfigProvider: vi.fn(async (provider: () => Promise<Record<string, unknown>>) => {
    h.provider = provider;
  }),
  applyCryptoConfig: vi.fn(async () => {
    if (h.provider) h.sent.push(await h.provider());
  }),
  sendCryptoConfig: vi.fn(async (config: Record<string, unknown>) => {
    h.sent.push(config);
  }),
  reencryptAllDb: vi.fn(async () => ({})),
  unsealDbForDisable: vi.fn(async () => {
    // A worker restart in the middle of the sweep re-applies the provider.
    h.duringUnseal = h.provider ? await h.provider() : null;
    return { cleared: [], decrypted: {} };
  }),
  abandonSealedDb: vi.fn(async () => {
    h.abandoned += 1;
  }),
  clearCache: vi.fn(async () => {
    h.cleared += 1;
  }),
}));

vi.mock('../../src/utils/db', () => ({ db: { meta: { put: vi.fn(async () => {}) } } }));

vi.mock('../../src/utils/crypto-store.js', () => ({
  isLockEnabled: () => h.lockEnabled,
  isVaultConfigured: () => true,
  isUnlocked: () => h.unlocked,
  getIdbCryptoMaterial: async () => (h.unlocked ? KEY : null),
}));

import {
  decryptAllIdbData,
  abandonEncryptedCache,
  setExternalIdbKey,
  initDbCryptoBridge,
} from '../../src/utils/db-crypto-bridge.js';

describe('db-crypto-bridge', () => {
  beforeEach(() => {
    h.sent = [];
    h.lockEnabled = true;
    h.unlocked = true;
    h.duringUnseal = null;
    h.abandoned = 0;
    h.cleared = 0;
  });

  it('stops sealing writes for the whole disable sweep, even across a worker restart', async () => {
    await decryptAllIdbData();

    expect(h.sent[0]).toMatchObject({ required: false, sealWrites: false });
    expect(h.sent[0].rawKey).toBe(KEY);
    expect(h.duringUnseal).toMatchObject({ required: false, sealWrites: false });
    // Finished: the key is dropped.
    expect(h.sent.at(-1)).toEqual({ required: false, rawKey: null });
  });

  it('uses a key handed over by the main window when this window is not unlocked', async () => {
    h.unlocked = false;
    await initDbCryptoBridge();
    const handed = new Uint8Array(32).fill(9);
    await setExternalIdbKey(handed);
    expect(h.sent.at(-1)).toEqual({ required: true, rawKey: handed });

    await setExternalIdbKey(null);
    expect(h.sent.at(-1)).toEqual({ required: true, rawKey: null });
  });

  it('abandons only the sealed rows instead of clearing the cache', async () => {
    await abandonEncryptedCache();
    expect(h.abandoned).toBe(1);
    expect(h.cleared).toBe(0);
  });
});
