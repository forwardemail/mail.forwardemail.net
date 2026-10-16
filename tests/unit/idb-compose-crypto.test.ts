/**
 * The desktop compose window writes drafts and the outbox to IndexedDB, so it
 * must register the at-rest encryption provider before anything touches the
 * database, and install the IDB key the main window sends with compose:init.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  order: [] as string[],
  externalKeys: [] as unknown[],
  initHandler: null as null | ((event: { payload: unknown }) => void),
}));

vi.mock('../../src/utils/db-crypto-bridge.js', () => ({
  initDbCryptoBridge: vi.fn(async () => {
    h.order.push('bridge');
  }),
  setExternalIdbKey: vi.fn(async (key: unknown) => {
    h.externalKeys.push(key);
  }),
}));
vi.mock('../../src/utils/crypto-store.js', () => ({
  isLockEnabled: () => true,
  isVaultConfigured: () => true,
  isUnlocked: () => false,
  wasUnlockedThisSession: () => false,
  restoreSessionDek: vi.fn(async () => false),
}));
vi.mock('svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('svelte')>()),
  mount: vi.fn((_component: unknown, options: { props: Record<string, unknown> }) => {
    h.order.push('mount');
    (options.props.registerApi as (api: Record<string, unknown>) => void)({ open: vi.fn() });
    return {};
  }),
}));
vi.mock('../../src/svelte/Compose.svelte', () => ({ default: {} }));
vi.mock('../../src/svelte/toastsHost', () => ({
  createToastHost: () => ({ show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock('../../src/stores/settingsStore', () => ({ getEffectiveSettingValue: () => 'light' }));
vi.mock('../../src/utils/paste-normalizer', () => ({ installPasteNormalizer: vi.fn() }));
vi.mock('../../src/utils/runtime-error-notifier', () => ({
  installRuntimeErrorNotifier: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === 'compose:init') h.initHandler = handler;
    return () => {};
  }),
  emit: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'compose-1' }),
}));

describe('compose window db crypto wiring', () => {
  it('registers the crypto bridge before mounting and applies the handed-over key', async () => {
    document.body.innerHTML = '<div id="compose-root"></div><div id="toasts-root"></div>';
    await import('../../src/compose-main');

    expect(h.order.slice(0, 2)).toEqual(['bridge', 'mount']);

    await vi.waitFor(() => expect(h.initHandler).not.toBeNull());
    const key = new Uint8Array(32).map((_, i) => i);
    h.initHandler!({
      payload: { action: 'compose', prefill: {}, idbKey: Buffer.from(key).toString('base64') },
    });
    await vi.waitFor(() => expect(h.externalKeys).toHaveLength(1));
    expect(Array.from(h.externalKeys[0] as Uint8Array)).toEqual(Array.from(key));
  });
});
