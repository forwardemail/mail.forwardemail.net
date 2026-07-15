const { addPluginListenerMock, invokeMock, listeners, unregisterMocks } = vi.hoisted(() => ({
  addPluginListenerMock: vi.fn(),
  invokeMock: vi.fn(),
  listeners: new Map(),
  unregisterMocks: [],
}));

vi.mock('@tauri-apps/api/core', () => ({
  addPluginListener: addPluginListenerMock,
  invoke: invokeMock,
}));

vi.mock('../../src/config.js', () => ({
  config: {
    unifiedPushVapidPublicKey: 'B'.repeat(87),
  },
}));

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: true,
}));

import {
  drainUnifiedPushMessages,
  getUnifiedPushState,
  getUnifiedPushVapidPublicKey,
  isUnifiedPushSupported,
  listenForUnifiedPush,
  pickUnifiedPushDistributor,
  registerUnifiedPush,
  removeUnifiedPushListeners,
  serializeUnifiedPushSubscription,
  unregisterUnifiedPush,
} from '../../src/utils/unified-push.js';

const VALID_SUBSCRIPTION = {
  endpoint: 'https://push.example.test/message/abc',
  p256dh: `B${'C'.repeat(86)}`,
  auth: 'D'.repeat(22),
};

function setUserAgent(value) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value,
  });
}

describe('UnifiedPush client bridge', () => {
  beforeEach(async () => {
    await removeUnifiedPushListeners();
    vi.clearAllMocks();
    listeners.clear();
    unregisterMocks.length = 0;
    setUserAgent('ForwardEmail/1.0 (Android 15)');

    addPluginListenerMock.mockImplementation(async (_plugin, event, callback) => {
      listeners.set(event, callback);
      const unregister = vi.fn(async () => {});
      unregisterMocks.push(unregister);
      return { unregister };
    });
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await removeUnifiedPushListeners();
  });

  it('only reports support for Tauri Android', () => {
    expect(isUnifiedPushSupported()).toBe(true);
    setUserAgent('ForwardEmail/1.0 (iPhone)');
    expect(isUnifiedPushSupported()).toBe(false);
  });

  it('normalizes the configured VAPID public key', () => {
    expect(getUnifiedPushVapidPublicKey()).toBe('B'.repeat(87));
  });

  it('serializes a standards-shaped Web Push subscription', () => {
    expect(JSON.parse(serializeUnifiedPushSubscription(VALID_SUBSCRIPTION))).toEqual({
      endpoint: VALID_SUBSCRIPTION.endpoint,
      keys: {
        p256dh: VALID_SUBSCRIPTION.p256dh,
        auth: VALID_SUBSCRIPTION.auth,
      },
    });
  });

  it.each([
    null,
    { ...VALID_SUBSCRIPTION, endpoint: 'http://push.example.test/message/abc' },
    { ...VALID_SUBSCRIPTION, p256dh: 'not-a-key' },
    { ...VALID_SUBSCRIPTION, p256dh: 'C'.repeat(87) },
    { ...VALID_SUBSCRIPTION, p256dh: `B${'C'.repeat(85)}` },
    { ...VALID_SUBSCRIPTION, auth: 'short' },
    { ...VALID_SUBSCRIPTION, auth: 'D'.repeat(23) },
  ])('rejects malformed subscriptions: %j', (subscription) => {
    expect(serializeUnifiedPushSubscription(subscription)).toBeNull();
  });

  it('invokes silent registration with the configured VAPID public key', async () => {
    await registerUnifiedPush();

    expect(invokeMock).toHaveBeenCalledWith('plugin:unified-push|register', {
      instance: 'forward-email',
      messageForDistributor: 'Forward Email',
      vapidPublicKey: 'B'.repeat(87),
    });
  });

  it('opens distributor selection only through the explicit picker command', async () => {
    await pickUnifiedPushDistributor();

    expect(invokeMock).toHaveBeenCalledWith('plugin:unified-push|pick_distributor', {
      instance: 'forward-email',
      messageForDistributor: 'Forward Email',
      vapidPublicKey: 'B'.repeat(87),
    });
  });

  it('retrieves state and drains structured queued messages', async () => {
    const state = { distributor: 'org.example.distributor', subscription: VALID_SUBSCRIPTION };
    const messages = [{ payload: { type: 'new-message' }, displayedBySystem: true }];
    invokeMock.mockResolvedValueOnce(state).mockResolvedValueOnce({ messages });

    await expect(getUnifiedPushState()).resolves.toEqual(state);
    await expect(drainUnifiedPushMessages()).resolves.toEqual(messages);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'plugin:unified-push|get_state', {});
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'plugin:unified-push|drain_messages', {});
  });

  it('registers all lifecycle listeners and filters callbacks by instance', async () => {
    const callbacks = {
      onSubscription: vi.fn(),
      onMessage: vi.fn(),
      onRegistrationFailed: vi.fn(),
      onUnregistered: vi.fn(),
      onTemporaryUnavailable: vi.fn(),
    };

    await expect(listenForUnifiedPush(callbacks)).resolves.toBe(true);
    expect(addPluginListenerMock).toHaveBeenCalledTimes(5);

    listeners.get('subscription-changed')({
      instance: 'another-app',
      subscription: VALID_SUBSCRIPTION,
    });
    listeners.get('subscription-changed')({
      instance: 'forward-email',
      subscription: VALID_SUBSCRIPTION,
    });
    listeners.get('message-received')({
      instance: 'forward-email',
      payload: { type: 'new-message' },
    });
    listeners.get('registration-failed')({
      instance: 'forward-email',
      reason: 'network',
    });
    listeners.get('unregistered')({ instance: 'forward-email' });
    listeners.get('temporary-unavailable')({ instance: 'forward-email' });

    expect(callbacks.onSubscription).toHaveBeenCalledOnce();
    expect(callbacks.onSubscription).toHaveBeenCalledWith(VALID_SUBSCRIPTION);
    expect(callbacks.onMessage).toHaveBeenCalledWith({
      instance: 'forward-email',
      payload: { type: 'new-message' },
    });
    expect(callbacks.onRegistrationFailed).toHaveBeenCalledWith('network');
    expect(callbacks.onUnregistered).toHaveBeenCalledOnce();
    expect(callbacks.onTemporaryUnavailable).toHaveBeenCalledOnce();
  });

  it('unregisters every native listener and the distributor instance', async () => {
    await listenForUnifiedPush();
    await removeUnifiedPushListeners();
    await unregisterUnifiedPush();

    expect(unregisterMocks).toHaveLength(5);
    expect(unregisterMocks.every((unregister) => unregister.mock.calls.length === 1)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('plugin:unified-push|unregister', {
      instance: 'forward-email',
    });
  });
});
