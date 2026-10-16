/**
 * Desktop compose windows under App Lock: the key they get when they open,
 * and what happens to their database config when the main window locks,
 * unlocks or turns App Lock off while they are open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  provider: null as null | (() => Promise<Record<string, unknown>>),
  lockEnabled: true,
  unlocked: false,
  label: 'main',
  windows: ['main', 'compose-1', 'compose-2'] as string[],
  emitted: [] as Array<{ label: string; event: string; payload: Record<string, unknown> }>,
  listeners: new Map<string, (event: { payload: unknown }) => unknown>(),
}));

const KEY = new Uint8Array(32).fill(7);
const KEY_B64 = btoa(String.fromCharCode(...KEY));

vi.mock('../../src/utils/db-worker-client.js', () => ({
  setCryptoConfigProvider: vi.fn(async (provider: () => Promise<Record<string, unknown>>) => {
    h.provider = provider;
  }),
  applyCryptoConfig: vi.fn(async () => {}),
  sendCryptoConfig: vi.fn(async () => {}),
  reencryptAllDb: vi.fn(async () => ({})),
  unsealDbForDisable: vi.fn(async () => ({ cleared: [], decrypted: {} })),
  abandonSealedDb: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {}),
}));
vi.mock('../../src/utils/db', () => ({ db: { meta: { put: vi.fn(async () => {}) } } }));
vi.mock('../../src/utils/crypto-store.js', () => ({
  isLockEnabled: () => h.lockEnabled,
  isVaultConfigured: () => true,
  isUnlocked: () => h.unlocked,
  getIdbCryptoMaterial: async () => (h.unlocked ? KEY : null),
  getIdbKeyForComposeWindow: async () => (h.lockEnabled && h.unlocked ? KEY_B64 : undefined),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: h.label }) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getAllWebviewWindows: async () => h.windows.map((label) => ({ label })),
}));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async (label: string, event: string, payload: Record<string, unknown>) => {
    h.emitted.push({ label, event, payload });
  }),
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => unknown) => {
    h.listeners.set(event, cb);
    return () => {};
  }),
}));

import { initDbCryptoBridge, setExternalIdbKey } from '../../src/utils/db-crypto-bridge.js';
import {
  broadcastComposeLockState,
  handleComposeLockState,
} from '../../src/utils/compose-crypto-sync';

const config = () => h.provider!();

describe('a compose window following App Lock in the main window', () => {
  beforeEach(async () => {
    h.lockEnabled = true;
    h.unlocked = false;
    h.label = 'compose-1';
    h.emitted = [];
    await initDbCryptoBridge();
    await handleComposeLockState({ state: 'locked' });
    await setExternalIdbKey(KEY);
  });

  it('seals with the key it was handed', async () => {
    expect(await config()).toEqual({ required: true, rawKey: KEY });
  });

  it('stops sealing, but can still read, while App Lock is being turned off', async () => {
    await handleComposeLockState({ state: 'disabling' });
    expect(await config()).toEqual({ required: false, rawKey: KEY, sealWrites: false });
  });

  it('drops the key and writes plaintext once App Lock is off', async () => {
    await handleComposeLockState({ state: 'disabling' });
    await handleComposeLockState({ state: 'off' });
    // This window's own storage may still say App Lock is on (WebView2 can
    // keep it separate); the main window's word wins.
    expect(await config()).toEqual({ required: false, rawKey: null });
  });

  it('forgets the key on lock and takes the new one on unlock', async () => {
    await handleComposeLockState({ state: 'locked' });
    expect(await config()).toEqual({ required: true, rawKey: null });
    await handleComposeLockState({ state: 'unlocked', idbKey: KEY_B64 });
    expect(await config()).toEqual({ required: true, rawKey: KEY });
  });

  it('ignores a message it does not understand', async () => {
    await handleComposeLockState({ state: 'whatever' });
    expect(await config()).toEqual({ required: true, rawKey: KEY });
  });
});

describe('the main window telling compose windows', () => {
  beforeEach(() => {
    h.label = 'main';
    h.emitted = [];
    h.lockEnabled = true;
    h.unlocked = true;
  });

  it('sends the key to each compose window by label, and nowhere else', async () => {
    await broadcastComposeLockState('unlocked');
    expect(h.emitted.map((e) => e.label)).toEqual(['compose-1', 'compose-2']);
    expect(h.emitted[0]).toMatchObject({
      event: 'compose:lock-state',
      payload: { state: 'unlocked', idbKey: KEY_B64 },
    });
  });

  it('sends no key with a lock', async () => {
    h.unlocked = false;
    await broadcastComposeLockState('locked');
    expect(h.emitted.every((e) => !('idbKey' in e.payload))).toBe(true);
  });

  it('does nothing from inside a compose window', async () => {
    h.label = 'compose-2';
    await broadcastComposeLockState('off');
    expect(h.emitted).toEqual([]);
  });
});

describe('opening a compose window under App Lock', () => {
  it('hands over the key with compose:init', async () => {
    h.label = 'main';
    h.lockEnabled = true;
    h.unlocked = true;
    h.emitted = [];
    vi.doMock('../../src/stores/folderStore', async () => {
      const { writable } = await import('svelte/store');
      return { folders: writable([]) };
    });
    vi.doMock('../../src/utils/storage', () => ({ Local: { get: () => null } }));
    const { initComposeWindowListener } = await import('../../src/utils/compose-window');
    await initComposeWindowListener();
    await h.listeners.get('compose:ready')!({ payload: { label: 'compose-9' } });

    expect(h.emitted).toContainEqual({
      label: 'compose-9',
      event: 'compose:init',
      payload: expect.objectContaining({ idbKey: KEY_B64 }),
    });
  });
});
