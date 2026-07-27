const {
  drainMessagesMock,
  getStateMock,
  listenMock,
  localStore,
  pickDistributorMock,
  requestNotificationPermissionMock,
  registerServerMock,
  registerUnifiedMock,
  removeListenersMock,
  serializeMock,
  unregisterServerMock,
  unregisterUnifiedMock,
  unifiedCallbacks,
} = vi.hoisted(() => ({
  drainMessagesMock: vi.fn(),
  getStateMock: vi.fn(),
  listenMock: vi.fn(),
  localStore: new Map(),
  pickDistributorMock: vi.fn(),
  requestNotificationPermissionMock: vi.fn(),
  registerServerMock: vi.fn(),
  registerUnifiedMock: vi.fn(),
  removeListenersMock: vi.fn(),
  serializeMock: vi.fn(),
  unregisterServerMock: vi.fn(),
  unregisterUnifiedMock: vi.fn(),
  unifiedCallbacks: { current: null },
}));

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: true,
}));

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn((key) => localStore.get(key)),
    set: vi.fn((key, value) => localStore.set(key, value)),
    remove: vi.fn((key) => localStore.delete(key)),
  },
  Accounts: {
    getAll: vi.fn(() => []),
  },
}));

vi.mock('../../src/utils/background-service.js', () => ({
  listPushTokens: vi.fn().mockResolvedValue([]),
  registerPushToken: registerServerMock,
  registerPushTokenForAccount: vi.fn().mockResolvedValue('multi-reg-1'),
  unregisterPushToken: unregisterServerMock,
  unregisterPushTokenForAccount: unregisterServerMock,
}));

vi.mock('../../src/utils/notification-bridge.js', () => ({
  requestPermission: requestNotificationPermissionMock,
}));

vi.mock('../../src/utils/unified-push.js', () => ({
  drainUnifiedPushMessages: drainMessagesMock,
  getUnifiedPushState: getStateMock,
  getUnifiedPushVapidPublicKey: vi.fn(() => 'B'.repeat(87)),
  isUnifiedPushSupported: vi.fn(() => true),
  listenForUnifiedPush: listenMock,
  pickUnifiedPushDistributor: pickDistributorMock,
  registerUnifiedPush: registerUnifiedMock,
  removeUnifiedPushListeners: removeListenersMock,
  serializeUnifiedPushSubscription: serializeMock,
  unregisterUnifiedPush: unregisterUnifiedMock,
}));

const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/message/abc',
  p256dh: `B${'C'.repeat(86)}`,
  auth: 'D'.repeat(22),
};
const SERIALIZED_SUBSCRIPTION = JSON.stringify({
  endpoint: SUBSCRIPTION.endpoint,
  keys: {
    p256dh: SUBSCRIPTION.p256dh,
    auth: SUBSCRIPTION.auth,
  },
});

function setAndroidUserAgent() {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'ForwardEmail/1.0 (Android 15)',
  });
}

describe('UnifiedPush provider lifecycle in the native push manager', () => {
  let pushManager;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('VITE_ANDROID_PUSH_PROVIDER', 'unified-push');
    localStore.clear();
    unifiedCallbacks.current = null;
    setAndroidUserAgent();

    listenMock.mockImplementation(async (callbacks) => {
      unifiedCallbacks.current = callbacks;
      return true;
    });
    getStateMock.mockResolvedValue({
      availableDistributors: ['org.example.distributor'],
      distributor: 'org.example.distributor',
      selectionRequired: false,
      instance: 'forward-email',
      subscription: SUBSCRIPTION,
    });
    drainMessagesMock.mockResolvedValue([]);
    registerUnifiedMock.mockResolvedValue(undefined);
    removeListenersMock.mockResolvedValue(undefined);
    unregisterUnifiedMock.mockResolvedValue(undefined);
    requestNotificationPermissionMock.mockResolvedValue('granted');
    registerServerMock.mockResolvedValue('registration-1');
    unregisterServerMock.mockResolvedValue(true);
    serializeMock.mockReturnValue(SERIALIZED_SUBSCRIPTION);

    pushManager = await import('../../src/utils/push-notifications.js');
  });

  afterEach(async () => {
    await pushManager.cleanupPushNotifications();
    vi.unstubAllEnvs();
  });

  it('registers the encrypted subscription, silently re-registers, and replays queued messages', async () => {
    drainMessagesMock.mockResolvedValue([
      {
        payload: { type: 'new-message', mailbox: 'INBOX', uid: 42 },
        displayedBySystem: true,
      },
    ]);
    const received = [];
    const listener = (event) => received.push(event.detail);
    globalThis.addEventListener('fe:push-notification', listener);

    await expect(pushManager.initPushNotifications()).resolves.toBe(true);

    globalThis.removeEventListener('fe:push-notification', listener);
    expect(requestNotificationPermissionMock).toHaveBeenCalledOnce();
    expect(serializeMock).toHaveBeenCalledWith(SUBSCRIPTION);
    expect(registerServerMock).toHaveBeenCalledWith(SERIALIZED_SUBSCRIPTION, 'unified-push');
    expect(registerUnifiedMock).toHaveBeenCalledOnce();
    expect(localStore.get('push_notification_token')).toBe(SERIALIZED_SUBSCRIPTION);
    expect(localStore.get('push_notification_platform')).toBe('unified-push');
    // Per-account registration stored under __active_session__ (no email set)
    const regs = JSON.parse(localStore.get('push_registrations') || '{}');
    expect(regs['__active_session__']?.regId).toBe('registration-1');
    expect(received).toEqual([
      {
        type: 'new-message',
        mailbox: 'INBOX',
        uid: 42,
        displayedBySystem: true,
      },
    ]);
  });

  it('keeps UnifiedPush registered when Android display permission is declined', async () => {
    requestNotificationPermissionMock.mockResolvedValueOnce('denied');

    await expect(pushManager.initPushNotifications()).resolves.toBe(true);

    expect(requestNotificationPermissionMock).toHaveBeenCalledOnce();
    expect(registerServerMock).toHaveBeenCalledWith(SERIALIZED_SUBSCRIPTION, 'unified-push');
    expect(registerUnifiedMock).toHaveBeenCalledOnce();
    expect(pushManager.isPushInitialized()).toBe(true);
  });

  it('rotates a changed subscription and deletes the superseded server resource', async () => {
    await pushManager.initPushNotifications();
    registerServerMock.mockResolvedValueOnce('registration-2');
    const rotatedSerialized = JSON.stringify({
      endpoint: 'https://push.example.test/message/rotated',
      keys: { p256dh: SUBSCRIPTION.p256dh, auth: SUBSCRIPTION.auth },
    });
    serializeMock.mockReturnValueOnce(rotatedSerialized);

    await unifiedCallbacks.current.onSubscription({
      ...SUBSCRIPTION,
      endpoint: 'https://push.example.test/message/rotated',
    });

    expect(registerServerMock).toHaveBeenCalledTimes(2);
    expect(unregisterServerMock).toHaveBeenCalledWith('registration-1');
    // Per-account registration updated to new ID
    const regs = JSON.parse(localStore.get('push_registrations') || '{}');
    expect(regs['__active_session__']?.regId).toBe('registration-2');
    expect(pushManager.isPushInitialized()).toBe(true);
  });

  it('removes native listeners, server registration, and distributor registration on cleanup', async () => {
    await pushManager.initPushNotifications();
    await pushManager.cleanupPushNotifications();

    expect(removeListenersMock).toHaveBeenCalled();
    expect(unregisterServerMock).toHaveBeenCalledWith('registration-1');
    expect(unregisterUnifiedMock).toHaveBeenCalledOnce();
    expect(localStore.has('push_notification_token')).toBe(false);
    expect(localStore.has('push_notification_platform')).toBe(false);
    expect(localStore.has('push_registrations')).toBe(false);
    expect(pushManager.isPushInitialized()).toBe(false);
  });
});
