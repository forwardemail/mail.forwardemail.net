import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let actionHandler;
const localStore = new Map();

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  isTauriMobile: false,
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (key) => localStore.get(key) ?? null,
    set: (key, value) => localStore.set(key, value),
    remove: (key) => localStore.delete(key),
  },
  Accounts: {
    getAll: () => [],
  },
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  sendNotification: vi.fn(),
  onAction: vi.fn(async (handler) => {
    actionHandler = handler;
  }),
  registerActionTypes: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: vi.fn(async () => () => {}),
  }),
}));

describe('notification click → account switch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    actionHandler = undefined;
    localStore.clear();
    localStore.set('email', 'alice@example.com');
    window.location.hash = '';
  });

  afterEach(() => {
    // Flush any pending timers to prevent "window is not defined" after teardown
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('dispatches app:switch-account when notification account differs from active', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');
    await initTauriNotificationClickHandler();
    expect(typeof actionHandler).toBe('function');

    const switchEvents = [];
    const handler = (event) => switchEvents.push(event.detail);
    window.addEventListener('app:switch-account', handler);

    // Simulate clicking a notification that belongs to bob's account
    actionHandler({
      extra: {
        path: '#inbox/99',
        account: 'bob@example.com',
      },
    });

    // The switch event is dispatched synchronously
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0]).toEqual({ email: 'bob@example.com' });

    // Navigation happens after the 150ms delay
    expect(window.location.hash).toBe('');
    vi.advanceTimersByTime(200);
    expect(window.location.hash).toBe('#inbox/99');

    window.removeEventListener('app:switch-account', handler);
  });

  it('does NOT dispatch app:switch-account when notification account matches active', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');
    await initTauriNotificationClickHandler();

    const switchEvents = [];
    const handler = (event) => switchEvents.push(event.detail);
    window.addEventListener('app:switch-account', handler);

    // Simulate clicking a notification for the SAME account
    actionHandler({
      extra: {
        path: '#inbox/42',
        account: 'alice@example.com',
      },
    });

    // No timer needed — should navigate immediately
    vi.advanceTimersByTime(10);
    window.removeEventListener('app:switch-account', handler);

    expect(switchEvents).toHaveLength(0);
    expect(window.location.hash).toBe('#inbox/42');
  });

  it('navigates after account switch with a short delay', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');
    await initTauriNotificationClickHandler();

    // Simulate clicking a notification for a different account
    actionHandler({
      extra: {
        path: '#inbox/77',
        account: 'bob@example.com',
      },
    });

    // Navigation should NOT happen immediately (waiting for account switch)
    expect(window.location.hash).toBe('');

    // After the delay, navigation should occur
    vi.advanceTimersByTime(200);
    expect(window.location.hash).toBe('#inbox/77');
  });

  it('navigates immediately when no account field is present in notification data', async () => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');
    await initTauriNotificationClickHandler();

    // Simulate clicking a notification without account info (legacy behavior)
    actionHandler({
      extra: {
        path: '#inbox/55',
      },
    });

    // Should navigate immediately since no account switching needed
    expect(window.location.hash).toBe('#inbox/55');
  });

  it('handles case-insensitive account comparison', async () => {
    localStore.set('email', 'Alice@Example.COM');
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');
    await initTauriNotificationClickHandler();

    const switchEvents = [];
    const handler = (event) => switchEvents.push(event.detail);
    window.addEventListener('app:switch-account', handler);

    // Same account but different case — should NOT switch
    actionHandler({
      extra: {
        path: '#inbox/10',
        account: 'alice@example.com',
      },
    });

    vi.advanceTimersByTime(10);
    window.removeEventListener('app:switch-account', handler);

    expect(switchEvents).toHaveLength(0);
    expect(window.location.hash).toBe('#inbox/10');
  });
});

describe('notification data includes account field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStore.clear();
    localStore.set('email', 'alice@example.com');
  });

  it('notify() passes account through to Tauri extra payload', async () => {
    const tauriNotif = await import('@tauri-apps/plugin-notification');
    const { notify } = await import('../../src/utils/notification-bridge.js');

    await notify({
      title: 'New email',
      body: 'Hello',
      data: {
        path: '#inbox/1',
        uid: '1',
        account: 'bob@example.com',
      },
    });

    expect(tauriNotif.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({
          account: 'bob@example.com',
        }),
      }),
    );
  });

  it('notify() omits account from extra when not provided', async () => {
    const tauriNotif = await import('@tauri-apps/plugin-notification');
    const { notify } = await import('../../src/utils/notification-bridge.js');

    await notify({
      title: 'New email',
      body: 'Hello',
      data: {
        path: '#inbox/1',
        uid: '1',
      },
    });

    const call = tauriNotif.sendNotification.mock.calls[0][0];
    expect(call.extra).not.toHaveProperty('account');
  });
});
