const {
  apnsGetTokenMock,
  apnsPermissionMock,
  fcmGetTokenMock,
  fcmPermissionMock,
  isDemoModeMock,
  isPermissionGrantedMock,
  isUnifiedPushSupportedMock,
  listServerMock,
  localStore,
  registerServerMock,
  unifiedPushStateMock,
  unregisterServerMock,
} = vi.hoisted(() => ({
  apnsGetTokenMock: vi.fn(),
  apnsPermissionMock: vi.fn(),
  fcmGetTokenMock: vi.fn(),
  fcmPermissionMock: vi.fn(),
  isDemoModeMock: vi.fn(),
  isPermissionGrantedMock: vi.fn(),
  isUnifiedPushSupportedMock: vi.fn(),
  listServerMock: vi.fn(),
  localStore: new Map(),
  registerServerMock: vi.fn(),
  unifiedPushStateMock: vi.fn(),
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
  listPushTokens: listServerMock,
  registerPushToken: registerServerMock,
  unregisterPushToken: unregisterServerMock,
}));

vi.mock('../../src/utils/notification-bridge.js', () => ({
  requestPermission: vi.fn().mockResolvedValue('granted'),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: isPermissionGrantedMock,
}));

vi.mock('../../src/utils/unified-push.js', () => ({
  drainUnifiedPushMessages: vi.fn().mockResolvedValue([]),
  getUnifiedPushState: unifiedPushStateMock,
  getUnifiedPushVapidPublicKey: vi.fn(() => 'B'.repeat(87)),
  isUnifiedPushSupported: isUnifiedPushSupportedMock,
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
const APNS_TOKEN = 'AB'.repeat(32);
const FCM_TOKEN = 'fcm-token-abcdefghijklmnopqrstuvwxyz';
const OLD_FCM_TOKEN = 'old-fcm-token-abcdefghijklmnopqrstuvwxyz';

function setUserAgent(value) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value,
  });
}

function createRegistration({
  id = 'registration-1',
  platform = 'fcm',
  token = FCM_TOKEN,
  failureCount = 0,
  deviceName = 'Forward Email on Android',
} = {}) {
  return {
    id,
    platform,
    token,
    device_name: deviceName,
    failure_count: failureCount,
    last_used_at: '2026-07-18T12:00:00.000Z',
    expires_at: '2026-10-16T12:00:00.000Z',
    created_at: '2026-07-17T12:00:00.000Z',
    updated_at: '2026-07-18T12:00:00.000Z',
  };
}

function seedCurrentRegistration({
  id = 'registration-1',
  platform = 'fcm',
  token = FCM_TOKEN,
} = {}) {
  localStore.set('alias_auth', ALIAS_AUTH);
  localStore.set('push_notification_registration_id', id);
  localStore.set('push_notification_platform', platform);
  localStore.set('push_notification_token', token);
}

describe('push notification status and management', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('VITE_ANDROID_PUSH_PROVIDER', 'fcm');
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn().mockResolvedValue(new Uint8Array([0x12, 0x34, 0x56, 0x78]).buffer),
      },
    });
    localStore.clear();
    isDemoModeMock.mockReturnValue(false);
    isPermissionGrantedMock.mockResolvedValue(true);
    isUnifiedPushSupportedMock.mockReturnValue(false);
    unifiedPushStateMock.mockResolvedValue({});
    apnsPermissionMock.mockResolvedValue({ granted: true });
    apnsGetTokenMock.mockResolvedValue(APNS_TOKEN);
    fcmPermissionMock.mockResolvedValue({ granted: true });
    fcmGetTokenMock.mockResolvedValue(FCM_TOKEN);
    listServerMock.mockResolvedValue([]);
    registerServerMock.mockResolvedValue('registration-1');
    unregisterServerMock.mockResolvedValue(true);
    setUserAgent('ForwardEmail/1.0 (Android 15)');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns an active privacy-safe APNS status when native token casing differs', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    localStore.set('push_notification_platform', 'ios');
    localStore.set('push_notification_token', APNS_TOKEN);
    setUserAgent('ForwardEmail/1.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    listServerMock.mockResolvedValue([
      createRegistration({
        platform: 'apns',
        token: APNS_TOKEN.toLowerCase(),
        deviceName: 'Forward Email on iPhone',
      }),
    ]);
    const { getPushNotificationStatus } = await import('../../src/utils/push-notifications.js');

    const status = await getPushNotificationStatus();

    expect(status).toMatchObject({
      supported: true,
      authenticated: true,
      demo: false,
      platform: 'ios',
      provider: 'apns',
      providerLabel: 'Apple Push Notification Service',
      permission: 'granted',
      localTokenPresent: true,
      localTokenFingerprint: '1234-5678',
      serverReachable: true,
      health: 'active',
    });
    expect(status.currentRegistration).toMatchObject({
      id: 'registration-1',
      platform: 'apns',
      deviceName: 'Forward Email on iPhone',
      tokenFingerprint: '1234-5678',
      isCurrentDevice: true,
      failureCount: 0,
    });
    expect(JSON.stringify(status)).not.toContain(APNS_TOKEN);
    expect(JSON.stringify(status)).not.toContain(APNS_TOKEN.toLowerCase());
  });

  it('classifies a failing registration as repairable and preserves stale records separately', async () => {
    seedCurrentRegistration();
    listServerMock.mockResolvedValue([
      createRegistration({ failureCount: 3 }),
      createRegistration({
        id: 'stale-registration',
        platform: 'apns',
        token: APNS_TOKEN,
        deviceName: 'Previous iPhone',
      }),
    ]);
    const { getPushNotificationStatus } = await import('../../src/utils/push-notifications.js');

    const status = await getPushNotificationStatus();

    expect(status.health).toBe('needs-repair');
    expect(status.currentRegistration?.id).toBe('registration-1');
    expect(status.otherRegistrations).toHaveLength(1);
    expect(status.otherRegistrations[0]).toMatchObject({
      id: 'stale-registration',
      providerLabel: 'Apple Push Notification Service',
      tokenFingerprint: '1234-5678',
      isCurrentDevice: false,
    });
  });

  it('reports a missing UnifiedPush distributor without prompting for permission', async () => {
    vi.stubEnv('VITE_ANDROID_PUSH_PROVIDER', 'auto');
    localStore.set('alias_auth', ALIAS_AUTH);
    localStore.set('push_notification_preferred_provider', 'unified-push');
    isUnifiedPushSupportedMock.mockReturnValue(true);
    unifiedPushStateMock.mockResolvedValue({
      distributor: null,
      selectionRequired: true,
    });
    const { getPushNotificationStatus } = await import('../../src/utils/push-notifications.js');

    const status = await getPushNotificationStatus();

    expect(status).toMatchObject({
      platform: 'android',
      provider: 'unified-push',
      androidProviderMode: 'auto',
      providerPreference: 'unified-push',
      health: 'needs-distributor',
    });
  });

  it.each([
    ['unsupported', 'ForwardEmail/1.0 (Linux)', ALIAS_AUTH, false, 'unsupported'],
    [
      'authentication-required',
      'ForwardEmail/1.0 (Android 15)',
      null,
      false,
      'authentication-required',
    ],
    ['demo-mode', 'ForwardEmail/1.0 (Android 15)', ALIAS_AUTH, true, 'demo-mode'],
  ])(
    'blocks registration in the %s state without native or server side effects',
    async (_state, userAgent, aliasAuth, demo, expectedCode) => {
      setUserAgent(userAgent);
      if (aliasAuth) localStore.set('alias_auth', aliasAuth);
      isDemoModeMock.mockReturnValue(demo);
      const { registerCurrentDevicePush } = await import('../../src/utils/push-notifications.js');

      const result = await registerCurrentDevicePush();

      expect(result).toMatchObject({ ok: false, code: expectedCode });
      expect(fcmPermissionMock).not.toHaveBeenCalled();
      expect(apnsPermissionMock).not.toHaveBeenCalled();
      expect(registerServerMock).not.toHaveBeenCalled();
    },
  );

  it('registers the current Android device and verifies its server resource', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    listServerMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createRegistration({ id: 'registration-new' })]);
    registerServerMock.mockResolvedValue('registration-new');
    const { registerCurrentDevicePush } = await import('../../src/utils/push-notifications.js');

    const result = await registerCurrentDevicePush();

    expect(result).toMatchObject({
      ok: true,
      code: 'registered',
      status: {
        health: 'active',
        currentRegistration: { id: 'registration-new' },
      },
    });
    expect(fcmPermissionMock).toHaveBeenCalledOnce();
    expect(registerServerMock).toHaveBeenCalledWith(FCM_TOKEN, 'android');
  });

  it('returns permission-denied when native registration remains unavailable', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    isPermissionGrantedMock.mockResolvedValue(false);
    fcmPermissionMock.mockResolvedValue({ granted: false });
    const { registerCurrentDevicePush } = await import('../../src/utils/push-notifications.js');

    const result = await registerCurrentDevicePush();

    expect(result).toMatchObject({ ok: false, code: 'permission-denied' });
    expect(registerServerMock).not.toHaveBeenCalled();
  });

  it('deregisters the current device locally and through the owned server resource', async () => {
    seedCurrentRegistration();
    listServerMock.mockResolvedValueOnce([createRegistration()]).mockResolvedValueOnce([]);
    const { deregisterCurrentDevicePush } = await import('../../src/utils/push-notifications.js');

    const result = await deregisterCurrentDevicePush();

    expect(result).toMatchObject({
      ok: true,
      code: 'deregistered',
      status: { health: 'not-registered', currentRegistration: null },
    });
    expect(unregisterServerMock).toHaveBeenCalledWith('registration-1');
    expect(localStore.has('push_notification_token')).toBe(false);
    expect(localStore.has('push_notification_registration_id')).toBe(false);
  });

  it('re-registers by removing the old server resource before creating the replacement', async () => {
    seedCurrentRegistration({ token: OLD_FCM_TOKEN });
    listServerMock
      .mockResolvedValueOnce([createRegistration({ token: OLD_FCM_TOKEN })])
      .mockResolvedValueOnce([createRegistration({ id: 'registration-new' })]);
    registerServerMock.mockResolvedValue('registration-new');
    const { reregisterCurrentDevicePush } = await import('../../src/utils/push-notifications.js');

    const result = await reregisterCurrentDevicePush();

    expect(result).toMatchObject({
      ok: true,
      code: 'reregistered',
      status: { health: 'active', currentRegistration: { id: 'registration-new' } },
    });
    expect(unregisterServerMock).toHaveBeenCalledWith('registration-1');
    expect(registerServerMock).toHaveBeenCalledWith(FCM_TOKEN, 'android');
    expect(unregisterServerMock.mock.invocationCallOrder[0]).toBeLessThan(
      registerServerMock.mock.invocationCallOrder[0],
    );
  });

  it('removes a selected stale server registration without deregistering this device', async () => {
    seedCurrentRegistration();
    const current = createRegistration();
    const stale = createRegistration({
      id: 'stale-registration',
      platform: 'apns',
      token: APNS_TOKEN,
      deviceName: 'Previous iPhone',
    });
    listServerMock.mockResolvedValueOnce([current, stale]).mockResolvedValueOnce([current]);
    const { removePushRegistration } = await import('../../src/utils/push-notifications.js');

    const result = await removePushRegistration('stale-registration');

    expect(result).toMatchObject({
      ok: true,
      code: 'removed',
      status: { health: 'active', otherRegistrations: [] },
    });
    expect(unregisterServerMock).toHaveBeenCalledWith('stale-registration');
    expect(localStore.get('push_notification_registration_id')).toBe('registration-1');
  });

  it('coalesces concurrent user registration actions into one native and server mutation', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    let resolveToken;
    fcmGetTokenMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    );
    listServerMock.mockResolvedValueOnce([]).mockResolvedValueOnce([createRegistration()]);
    const { registerCurrentDevicePush } = await import('../../src/utils/push-notifications.js');

    const first = registerCurrentDevicePush();
    const second = registerCurrentDevicePush();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(fcmGetTokenMock).toHaveBeenCalledOnce());
    resolveToken(FCM_TOKEN);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, code: 'registered' }),
      expect.objectContaining({ ok: true, code: 'registered' }),
    ]);
    expect(registerServerMock).toHaveBeenCalledOnce();
    expect(listServerMock).toHaveBeenCalledTimes(2);
  });

  it('returns registration-timeout when native token retrieval hangs', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    fcmGetTokenMock.mockImplementationOnce(
      () => new Promise(() => {}), // never resolves
    );
    listServerMock.mockResolvedValueOnce([]);
    const { registerCurrentDevicePush } = await import('../../src/utils/push-notifications.js');

    vi.useFakeTimers();
    try {
      const resultPromise = registerCurrentDevicePush();
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await resultPromise;

      expect(result.ok).toBe(false);
      expect(result.code).toBe('registration-timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a permission prompt the user answers slowly', async () => {
    localStore.set('alias_auth', ALIAS_AUTH);
    // The user takes 90 seconds to answer the system dialog. That is past the
    // 15s bridge timeout but within the permission prompt budget, so
    // registration must still succeed.
    let grantPermission;
    fcmPermissionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grantPermission = () => resolve({ granted: true });
        }),
    );
    listServerMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createRegistration({ id: 'registration-new' })]);
    registerServerMock.mockResolvedValue('registration-new');
    const { registerCurrentDevicePush } = await import('../../src/utils/push-notifications.js');

    vi.useFakeTimers();
    try {
      const resultPromise = registerCurrentDevicePush();
      await vi.advanceTimersByTimeAsync(90_000);
      grantPermission();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(result.code).toBe('registered');
    } finally {
      vi.useRealTimers();
    }
  });
});
