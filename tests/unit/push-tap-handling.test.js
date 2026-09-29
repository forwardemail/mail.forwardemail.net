/**
 * Tapping a remote push notification (APNs on iOS, an FCM or UnifiedPush
 * notification on Android) has to open the message it is about, in its own
 * account, including when the tap is what launched the app and when App Lock
 * is up. Before, nothing navigated on a tap at all: the tap only fed the data
 * pipeline, and on a cold start it arrived before anything listened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, pluginListeners, localValues, accounts } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  pluginListeners: {},
  localValues: new Map(),
  accounts: [],
}));

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMacOS: false,
  isTauriMobile: true,
  isTauri: true,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  addPluginListener: vi.fn(async (plugin, event, handler) => {
    pluginListeners[`${plugin}:${event}`] = handler;
    return { unregister: vi.fn() };
  }),
}));

vi.mock('../../src/utils/background-service.js', () => ({
  getLastTokenRegistrationError: vi.fn(() => null),
  listPushTokens: vi.fn().mockResolvedValue([]),
  registerPushToken: vi.fn(),
  registerPushTokenForAccount: vi.fn(),
  unregisterPushToken: vi.fn(),
  unregisterPushTokenForAccount: vi.fn(),
}));

vi.mock('../../src/utils/notification-bridge.js', () => ({
  requestPermission: vi.fn(() => Promise.resolve('granted')),
}));

vi.mock('../../src/utils/unified-push.js', () => ({
  drainUnifiedPushMessages: vi.fn(() => Promise.resolve([])),
  getUnifiedPushState: vi.fn(() => Promise.resolve(null)),
  getUnifiedPushVapidPublicKey: vi.fn(() => ''),
  isUnifiedPushSupported: vi.fn(() => false),
  listenForUnifiedPush: vi.fn(() => Promise.resolve()),
  pickUnifiedPushDistributor: vi.fn(() => Promise.resolve()),
  registerUnifiedPush: vi.fn(() => Promise.resolve()),
  removeUnifiedPushListeners: vi.fn(() => Promise.resolve()),
  serializeUnifiedPushSubscription: vi.fn(() => ''),
  unregisterUnifiedPush: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: (key) => localValues.get(key) ?? null,
    set: (key, value) => localValues.set(key, value),
    remove: (key) => localValues.delete(key),
  },
  Accounts: { getAll: () => accounts },
}));
vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (key) => localValues.get(key) ?? null,
    set: (key, value) => localValues.set(key, value),
    remove: (key) => localValues.delete(key),
  },
  Accounts: { getAll: () => accounts },
}));

const tapFor = (aliasId, messageId, mailbox = 'INBOX') => ({
  data: { event: 'newMessage', alias_id: aliasId, message_id: messageId, mailbox },
});

describe('push notification taps', () => {
  let navigated;
  let switched;
  let ready;

  const setPlatform = (ua) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);

  let loaded = null;
  const load = async () => {
    loaded?.push.__resetPushTapHandlingForTests();
    vi.resetModules();
    const open = await import('../../src/utils/notification-open.ts');
    open.configureNotificationOpen({
      isReady: () => ready,
      switchAccount: async (email) => {
        switched.push(email);
        localValues.set('email', email);
      },
      navigate: (path) => navigated.push(path),
    });
    const push = await import('../../src/utils/push-notifications.js');
    loaded = { open, push };
    return loaded;
  };

  beforeEach(() => {
    navigated = [];
    switched = [];
    ready = true;
    invokeMock.mockReset();
    for (const key of Object.keys(pluginListeners)) delete pluginListeners[key];
    localValues.clear();
    localValues.set('email', 'alice@example.com');
    localValues.set(
      'push_registrations',
      JSON.stringify({
        'alice@example.com': { regId: 'r1', token: 't', platform: 'ios', aliasId: 'alias-a' },
        'bob@example.com': { regId: 'r2', token: 't', platform: 'ios', aliasId: 'alias-b' },
      }),
    );
    accounts.length = 0;
    accounts.push({ email: 'alice@example.com' }, { email: 'bob@example.com' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('iOS: opens the tap that launched the app, in its own account', async () => {
    setPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    // Queued natively before the page loaded.
    invokeMock.mockResolvedValueOnce([tapFor('alias-b', 'msg-1', 'Work')]);
    const { push } = await load();

    await push.initPushTapHandling();

    expect(invokeMock).toHaveBeenCalledWith('plugin:mobile-push|take_pending_taps');
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#Work/msg-1']));
    expect(switched).toEqual(['bob@example.com']);
  });

  it('iOS: a tap while running is read from the native queue once', async () => {
    setPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    invokeMock.mockResolvedValueOnce([]);
    const { push } = await load();
    await push.initPushTapHandling();

    invokeMock.mockResolvedValueOnce([tapFor('alias-a', 'msg-2')]);
    window.dispatchEvent(
      new CustomEvent('mobile-push:notification-tapped', { detail: tapFor('alias-a', 'msg-2') }),
    );

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/msg-2']));
    expect(switched).toEqual([]);
  });

  it('iOS: falls back to the event payload on a native build without the queue', async () => {
    setPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    invokeMock.mockRejectedValue(new Error('Command take_pending_taps not found'));
    const { push } = await load();
    await push.initPushTapHandling();

    window.dispatchEvent(
      new CustomEvent('mobile-push:notification-tapped', { detail: tapFor('alias-a', 'msg-3') }),
    );

    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/msg-3']));
  });

  it('Android: opens an FCM or UnifiedPush tap from the launch intent', async () => {
    setPlatform('Mozilla/5.0 (Linux; Android 15)');
    invokeMock.mockResolvedValueOnce({ taps: [tapFor('alias-b', 'msg-4')] });
    const { push } = await load();

    await push.initPushTapHandling();

    expect(invokeMock).toHaveBeenCalledWith('plugin:unified-push|take_pending_taps');
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/msg-4']));
    expect(switched).toEqual(['bob@example.com']);

    // A later tap wakes the page through the plugin event.
    invokeMock.mockResolvedValueOnce({ taps: [tapFor('alias-a', 'msg-5')] });
    pluginListeners['unified-push:notification-tapped']();
    await vi.waitFor(() => expect(navigated).toContain('/mailbox#INBOX/msg-5'));
  });

  it('waits for App Lock before opening the tapped message', async () => {
    setPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    ready = false;
    invokeMock.mockResolvedValueOnce([tapFor('alias-a', 'msg-6')]);
    const { open, push } = await load();
    await push.initPushTapHandling();

    expect(navigated).toEqual([]);

    // The unlock handler in main.ts flushes the pending tap.
    ready = true;
    await open.flushPendingNotificationOpen();
    expect(navigated).toEqual(['/mailbox#INBOX/msg-6']);
  });

  it('does not open a tap for an account this device is not signed into', async () => {
    setPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    invokeMock.mockResolvedValueOnce([tapFor('alias-unknown', 'msg-7')]);
    const { push } = await load();
    await push.initPushTapHandling();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(navigated).toEqual([]);
    expect(switched).toEqual([]);
  });

  it('opens the mailbox when the push names no message (temporary storage delivery)', async () => {
    setPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    invokeMock.mockResolvedValueOnce([
      { data: { event: 'newMessage', alias_id: 'alias-a', message_id: '', mailbox: 'INBOX' } },
    ]);
    const { push } = await load();
    await push.initPushTapHandling();
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX']));
  });
});
