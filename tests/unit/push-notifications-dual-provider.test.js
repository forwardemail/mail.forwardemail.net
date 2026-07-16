const {
  drainMessagesMock,
  fcmGetTokenMock,
  fcmPermissionMock,
  getStateMock,
  listenMock,
  localStore,
  pickDistributorMock,
  registerServerMock,
  registerUnifiedMock,
  serializeMock,
  unifiedCallbacks,
  unregisterServerMock,
} = vi.hoisted(() => ({
  drainMessagesMock: vi.fn(),
  fcmGetTokenMock: vi.fn(),
  fcmPermissionMock: vi.fn(),
  getStateMock: vi.fn(),
  listenMock: vi.fn(),
  localStore: new Map(),
  pickDistributorMock: vi.fn(),
  registerServerMock: vi.fn(),
  registerUnifiedMock: vi.fn(),
  serializeMock: vi.fn(),
  unifiedCallbacks: { current: null },
  unregisterServerMock: vi.fn(),
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
}));

vi.mock('../../src/utils/background-service.js', () => ({
  registerPushToken: registerServerMock,
  unregisterPushToken: unregisterServerMock,
}));

vi.mock('../../src/utils/notification-bridge.js', () => ({
  requestPermission: vi.fn().mockResolvedValue('granted'),
}));

vi.mock('../../src/utils/unified-push.js', () => ({
  drainUnifiedPushMessages: drainMessagesMock,
  getUnifiedPushState: getStateMock,
  getUnifiedPushVapidPublicKey: vi.fn(() => 'B'.repeat(87)),
  isUnifiedPushSupported: vi.fn(() => true),
  listenForUnifiedPush: listenMock,
  pickUnifiedPushDistributor: pickDistributorMock,
  registerUnifiedPush: registerUnifiedMock,
  removeUnifiedPushListeners: vi.fn(),
  serializeUnifiedPushSubscription: serializeMock,
  unregisterUnifiedPush: vi.fn(),
}));

vi.mock('tauri-plugin-remote-push-api', () => ({
  getToken: fcmGetTokenMock,
  onNotificationReceived: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
  onNotificationTapped: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
  onTokenRefresh: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
  requestPermission: fcmPermissionMock,
}));

const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/message/dual-provider',
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

describe('dual-provider Android push preference', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('VITE_ANDROID_PUSH_PROVIDER', 'auto');
    localStore.clear();
    unifiedCallbacks.current = null;
    setAndroidUserAgent();

    fcmPermissionMock.mockResolvedValue({ granted: true });
    fcmGetTokenMock.mockResolvedValue('fcm-token-abcdefghijklmnopqrstuvwxyz');
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
    registerServerMock.mockResolvedValue('registration-1');
    serializeMock.mockReturnValue(SERIALIZED_SUBSCRIPTION);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to FCM when the user has not selected UnifiedPush', async () => {
    const pushManager = await import('../../src/utils/push-notifications.js');

    await expect(pushManager.initPushNotifications()).resolves.toBe(true);

    expect(fcmPermissionMock).toHaveBeenCalledOnce();
    expect(registerServerMock).toHaveBeenCalledWith(
      'fcm-token-abcdefghijklmnopqrstuvwxyz',
      'android',
    );
    expect(getStateMock).not.toHaveBeenCalled();
  });

  it('persists an explicit distributor selection and honors it after restart', async () => {
    let pushManager = await import('../../src/utils/push-notifications.js');
    await expect(pushManager.initPushNotifications()).resolves.toBe(true);
    await expect(pushManager.selectUnifiedPushDistributor()).resolves.toBe(true);

    expect(unregisterServerMock).toHaveBeenCalledWith('registration-1');
    expect(pickDistributorMock).toHaveBeenCalledOnce();
    expect(unregisterServerMock.mock.invocationCallOrder[0]).toBeLessThan(
      pickDistributorMock.mock.invocationCallOrder[0],
    );
    expect(pushManager.getAndroidPushProviderPreference()).toBe('unified-push');

    fcmPermissionMock.mockClear();
    registerServerMock.mockClear();
    vi.resetModules();
    pushManager = await import('../../src/utils/push-notifications.js');
    await expect(pushManager.initPushNotifications()).resolves.toBe(true);

    expect(registerServerMock).toHaveBeenCalledWith(SERIALIZED_SUBSCRIPTION, 'unified-push');
    expect(fcmPermissionMock).not.toHaveBeenCalled();
  });

  it('lets the user switch from UnifiedPush back to FCM', async () => {
    const pushManager = await import('../../src/utils/push-notifications.js');
    await pushManager.selectUnifiedPushDistributor();

    await expect(pushManager.selectFcmPushProvider()).resolves.toBe(true);

    expect(pushManager.getAndroidPushProviderPreference()).toBe('fcm');
    expect(fcmPermissionMock).toHaveBeenCalledOnce();
    expect(registerServerMock).toHaveBeenCalledWith(
      'fcm-token-abcdefghijklmnopqrstuvwxyz',
      'android',
    );
  });
});
