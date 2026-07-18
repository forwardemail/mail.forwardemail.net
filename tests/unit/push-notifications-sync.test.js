const {
  apnsGetTokenMock,
  apnsPermissionMock,
  fcmGetTokenMock,
  fcmPermissionMock,
  isDemoModeMock,
  localStore,
  registerServerMock,
  unregisterServerMock,
} = vi.hoisted(() => ({
  apnsGetTokenMock: vi.fn(),
  apnsPermissionMock: vi.fn(),
  fcmGetTokenMock: vi.fn(),
  fcmPermissionMock: vi.fn(),
  isDemoModeMock: vi.fn(),
  localStore: new Map(),
  registerServerMock: vi.fn(),
  unregisterServerMock: vi.fn(),
}));

vi.mock('../../src/utils/demo-mode.js', () => ({
  isDemoMode: isDemoModeMock,
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
  drainUnifiedPushMessages: vi.fn().mockResolvedValue([]),
  getUnifiedPushState: vi.fn().mockResolvedValue({}),
  getUnifiedPushVapidPublicKey: vi.fn(() => 'B'.repeat(87)),
  isUnifiedPushSupported: vi.fn(() => false),
  listenForUnifiedPush: vi.fn().mockResolvedValue(false),
  pickUnifiedPushDistributor: vi.fn(),
  registerUnifiedPush: vi.fn(),
  removeUnifiedPushListeners: vi.fn().mockResolvedValue(undefined),
  serializeUnifiedPushSubscription: vi.fn(),
  unregisterUnifiedPush: vi.fn(),
}));

vi.mock('tauri-plugin-remote-push-api', () => ({
  getToken: fcmGetTokenMock,
  onNotificationReceived: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
  onNotificationTapped: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
  onTokenRefresh: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
  requestPermission: fcmPermissionMock,
}));

vi.mock('tauri-plugin-mobile-push-api', () => ({
  getToken: apnsGetTokenMock,
  onNotificationReceived: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
  onNotificationTapped: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
  onTokenRefresh: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
  requestPermission: apnsPermissionMock,
}));

const ALIAS_AUTH = 'user@example.com:app-password';
const APNS_TOKEN = 'apns-token-abcdefghijklmnopqrstuvwxyz';
const FCM_TOKEN = 'fcm-token-abcdefghijklmnopqrstuvwxyz';

function setUserAgent(value) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value,
  });
}

describe('authenticated mobile push synchronization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('VITE_ANDROID_PUSH_PROVIDER', 'fcm');
    localStore.clear();
    isDemoModeMock.mockReturnValue(false);
    apnsPermissionMock.mockResolvedValue({ granted: true });
    apnsGetTokenMock.mockResolvedValue(APNS_TOKEN);
    fcmPermissionMock.mockResolvedValue({ granted: true });
    fcmGetTokenMock.mockResolvedValue(FCM_TOKEN);
    registerServerMock.mockResolvedValue('registration-1');
    unregisterServerMock.mockResolvedValue(undefined);
    setUserAgent('ForwardEmail/1.0 (Android 15)');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not prompt or register before alias credentials exist', async () => {
    const { syncPushNotifications } = await import('../../src/utils/push-notifications.js');

    await expect(syncPushNotifications()).resolves.toBe(false);

    expect(fcmPermissionMock).not.toHaveBeenCalled();
    expect(registerServerMock).not.toHaveBeenCalled();
  });

  it('does not prompt or register for the demo account', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    isDemoModeMock.mockReturnValue(true);
    const { syncPushNotifications } = await import('../../src/utils/push-notifications.js');

    await expect(syncPushNotifications()).resolves.toBe(false);

    expect(fcmPermissionMock).not.toHaveBeenCalled();
    expect(registerServerMock).not.toHaveBeenCalled();
  });

  it('registers an Android FCM token after alias authentication', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    const { syncPushNotifications } = await import('../../src/utils/push-notifications.js');

    await expect(syncPushNotifications()).resolves.toBe(true);

    expect(fcmPermissionMock).toHaveBeenCalledOnce();
    expect(fcmGetTokenMock).toHaveBeenCalledOnce();
    expect(registerServerMock).toHaveBeenCalledWith(FCM_TOKEN, 'android');
  });

  it('registers an iOS APNS token after alias authentication', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    setUserAgent('ForwardEmail/1.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    const { syncPushNotifications } = await import('../../src/utils/push-notifications.js');

    await expect(syncPushNotifications()).resolves.toBe(true);

    expect(apnsPermissionMock).toHaveBeenCalledOnce();
    expect(apnsGetTokenMock).toHaveBeenCalledOnce();
    expect(registerServerMock).toHaveBeenCalledWith(APNS_TOKEN, 'ios');
  });

  it('coalesces concurrent login, startup, and resume synchronization', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    let resolveToken;
    fcmGetTokenMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    );
    const { syncPushNotifications } = await import('../../src/utils/push-notifications.js');

    const loginSync = syncPushNotifications();
    const resumeSync = syncPushNotifications();
    await vi.waitFor(() => expect(fcmGetTokenMock).toHaveBeenCalledOnce());
    resolveToken(FCM_TOKEN);

    await expect(Promise.all([loginSync, resumeSync])).resolves.toEqual([true, true]);
    expect(fcmPermissionMock).toHaveBeenCalledOnce();
    expect(registerServerMock).toHaveBeenCalledOnce();
  });

  it('retries on the next lifecycle trigger after server registration fails', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    registerServerMock.mockResolvedValueOnce(null).mockResolvedValueOnce('registration-2');
    const { isPushInitialized, syncPushNotifications } =
      await import('../../src/utils/push-notifications.js');

    await expect(syncPushNotifications()).resolves.toBe(false);
    expect(isPushInitialized()).toBe(false);

    await expect(syncPushNotifications()).resolves.toBe(true);
    expect(isPushInitialized()).toBe(true);
    expect(fcmPermissionMock).toHaveBeenCalledTimes(2);
    expect(fcmGetTokenMock).toHaveBeenCalledTimes(2);
    expect(registerServerMock).toHaveBeenCalledTimes(2);
  });

  it('waits for in-flight registration before logout cleanup', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    let resolveToken;
    fcmGetTokenMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    );
    const { cleanupPushNotifications, isPushInitialized, syncPushNotifications } =
      await import('../../src/utils/push-notifications.js');

    const synchronization = syncPushNotifications();
    await vi.waitFor(() => expect(fcmGetTokenMock).toHaveBeenCalledOnce());
    const cleanup = cleanupPushNotifications();
    resolveToken(FCM_TOKEN);

    await expect(synchronization).resolves.toBe(true);
    await expect(cleanup).resolves.toBeUndefined();
    expect(unregisterServerMock).toHaveBeenCalledWith('registration-1');
    expect(isPushInitialized()).toBe(false);
  });
});
