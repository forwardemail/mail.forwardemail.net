/**
 * macOS APNs registration through tauri-plugin-mobile-push.
 *
 * The macOS plugin reports "unsupported" unless the bundle is signed with the
 * APNs entitlement, so both a signed and an unsigned build are covered: the
 * signed build registers its token as an APNs registration, and the unsigned
 * build never prompts and never registers.
 */

const {
  apnsGetTokenMock,
  apnsPermissionMock,
  invokeMock,
  listServerMock,
  localStore,
  registerServerMock,
  unregisterServerMock,
} = vi.hoisted(() => ({
  apnsGetTokenMock: vi.fn(),
  apnsPermissionMock: vi.fn(),
  invokeMock: vi.fn(),
  listServerMock: vi.fn(),
  localStore: new Map(),
  registerServerMock: vi.fn(),
  unregisterServerMock: vi.fn(),
}));

vi.mock('../../src/utils/demo-mode.js', () => ({
  isDemoMode: vi.fn(() => false),
}));

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  isTauriMobile: false,
  isTauriMacOS: true,
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
  getLastTokenRegistrationError: vi.fn(() => null),
  listPushTokens: listServerMock,
  registerPushToken: registerServerMock,
  registerPushTokenForAccount: vi.fn(),
  unregisterPushToken: unregisterServerMock,
  unregisterPushTokenForAccount: unregisterServerMock,
}));

vi.mock('../../src/utils/notification-bridge.js', () => ({
  getPermissionState: vi.fn(() => Promise.resolve('granted')),
  requestPermission: vi.fn().mockResolvedValue('granted'),
}));

vi.mock('../../src/utils/unified-push.js', () => ({
  drainUnifiedPushMessages: vi.fn().mockResolvedValue([]),
  getUnifiedPushState: vi.fn(),
  getUnifiedPushVapidPublicKey: vi.fn(),
  isUnifiedPushSupported: vi.fn(() => false),
  listenForUnifiedPush: vi.fn().mockResolvedValue(false),
  pickUnifiedPushDistributor: vi.fn(),
  registerUnifiedPush: vi.fn(),
  removeUnifiedPushListeners: vi.fn().mockResolvedValue(undefined),
  serializeUnifiedPushSubscription: vi.fn(),
  unregisterUnifiedPush: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('tauri-plugin-mobile-push-api', () => ({
  getToken: apnsGetTokenMock,
  requestPermission: apnsPermissionMock,
}));

const ALIAS_AUTH = 'user@example.com:app-password';
const EMAIL = 'user@example.com';
const APNS_TOKEN = 'ab'.repeat(32);

let permissionState = 'granted';
let pendingTaps = [];
let loadedPush = null;

function signIn() {
  localStore.set('alias_auth', ALIAS_AUTH);
  localStore.set('email', EMAIL);
}

function serverRecord(overrides = {}) {
  return {
    id: 'registration-mac',
    platform: 'apns',
    token: APNS_TOKEN,
    device_name: 'apns (Macintosh)',
    failure_count: 0,
    last_used_at: null,
    expires_at: null,
    created_at: '2026-09-01T12:00:00.000Z',
    updated_at: '2026-09-01T12:00:00.000Z',
    ...overrides,
  };
}

async function loadPush() {
  loadedPush = await import('../../src/utils/push-notifications.js');
  return loadedPush;
}

function capturePushEvents() {
  const events = [];
  const handler = (event) => events.push(event.detail);
  window.addEventListener('fe:push-notification', handler);
  return {
    events,
    stop: () => window.removeEventListener('fe:push-notification', handler),
  };
}

describe('macOS APNs push', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStore.clear();
    permissionState = 'granted';
    pendingTaps = [];
    window.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: 'macos' };
    invokeMock.mockImplementation(async (command) => {
      if (command === 'plugin:mobile-push|permission_state') return { state: permissionState };
      if (command === 'plugin:mobile-push|open_settings') return true;
      if (command === 'plugin:mobile-push|take_pending_taps') {
        const taps = pendingTaps;
        pendingTaps = [];
        return taps;
      }
      throw new Error(`unexpected command ${command}`);
    });
    apnsPermissionMock.mockResolvedValue({ granted: true, status: 'granted' });
    apnsGetTokenMock.mockResolvedValue(APNS_TOKEN);
    registerServerMock.mockResolvedValue({ id: 'registration-mac', aliasId: 'alias-1' });
    unregisterServerMock.mockResolvedValue(true);
    listServerMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    // Native listeners live on window, which outlives vi.resetModules().
    await loadedPush?.cleanupPushNotifications();
    loadedPush?.__resetPushTapHandlingForTests();
    loadedPush = null;
    delete window.__TAURI_OS_PLUGIN_INTERNALS__;
  });

  describe('build signed for APNs', () => {
    it('reports a manageable macOS status before registration', async () => {
      signIn();
      permissionState = 'prompt';
      const { getPushNotificationStatus } = await loadPush();

      const status = await getPushNotificationStatus();

      expect(status).toMatchObject({
        supported: true,
        platform: 'macos',
        provider: 'apns',
        providerLabel: 'Apple Push Notification Service',
        permission: 'not-granted',
        health: 'permission-not-granted',
      });
      expect(invokeMock).toHaveBeenCalledWith('plugin:mobile-push|permission_state');
      expect(apnsPermissionMock).not.toHaveBeenCalled();
    });

    it('registers the Mac token with Forward Email as an APNs token', async () => {
      signIn();
      listServerMock.mockResolvedValue([serverRecord()]);
      const { registerCurrentDevicePush } = await loadPush();

      const result = await registerCurrentDevicePush();

      expect(apnsPermissionMock).toHaveBeenCalledTimes(1);
      expect(apnsGetTokenMock).toHaveBeenCalledTimes(1);
      expect(registerServerMock).toHaveBeenCalledWith(APNS_TOKEN, 'apns');
      expect(localStore.get('push_notification_token')).toBe(APNS_TOKEN);
      expect(localStore.get('push_notification_platform')).toBe('apns');
      expect(result).toMatchObject({ ok: true, code: 'registered' });
      expect(result.status).toMatchObject({
        platform: 'macos',
        provider: 'apns',
        health: 'active',
        initialized: true,
      });
      expect(result.status.currentRegistration).toMatchObject({
        id: 'registration-mac',
        isCurrentDevice: true,
      });
    });

    it('explains a permission turned off in System Settings', async () => {
      signIn();
      permissionState = 'denied';
      apnsPermissionMock.mockResolvedValue({ granted: false, status: 'previously-denied' });
      const { registerCurrentDevicePush } = await loadPush();

      const result = await registerCurrentDevicePush();

      expect(result.ok).toBe(false);
      expect(result.code).toBe('permission-blocked');
      expect(result.detail).toMatch(/turned off in System Settings/);
      expect(apnsGetTokenMock).not.toHaveBeenCalled();
      expect(registerServerMock).not.toHaveBeenCalled();
    });

    it('shows the native reason when APNs never answers, not a bare timeout', async () => {
      // macos.rs waits 25 seconds for the APNs callback and spends up to 8
      // more on the main thread around it before it explains the failure.
      // The page used to give up at 35 seconds, so that explanation (which
      // says why the Mac got no token) could lose the race to "getToken timed
      // out after 35000ms".
      const nativeReason =
        'Apple Push Notification service did not answer within 25 seconds ' +
        '(delegate TaoAppDelegateParent (handles the token); bundle net.forwardemail.mail; ' +
        'aps-environment production; registered no)';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        signIn();
        apnsGetTokenMock.mockImplementation(
          () =>
            new Promise((_, reject) => {
              setTimeout(() => reject(nativeReason), 38_000);
            }),
        );
        const { registerCurrentDevicePush } = await loadPush();

        const pending = registerCurrentDevicePush();
        await vi.advanceTimersByTimeAsync(38_000);
        const result = await pending;

        expect(result.ok).toBe(false);
        expect(result.code).toBe('token-unavailable');
        expect(result.detail).toBe(nativeReason);
        expect(registerServerMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits out the slowest native answer (register again after 15s, 40s in all)', async () => {
      const nativeReason =
        'Apple Push Notification service did not answer within 40 seconds (registered yes)';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        signIn();
        // 40 seconds of waiting plus three main-thread steps of up to 4 each.
        apnsGetTokenMock.mockImplementation(
          () => new Promise((_, reject) => setTimeout(() => reject(nativeReason), 52_000)),
        );
        const { registerCurrentDevicePush } = await loadPush();

        const pending = registerCurrentDevicePush();
        await vi.advanceTimersByTimeAsync(52_000);
        const result = await pending;

        expect(result.code).toBe('token-unavailable');
        expect(result.detail).toBe(nativeReason);
      } finally {
        vi.useRealTimers();
      }
    });

    it('finishes registering when APNs answers after getToken gave up', async () => {
      signIn();
      listServerMock.mockResolvedValue([serverRecord()]);
      apnsGetTokenMock.mockRejectedValueOnce(
        'Apple Push Notification service did not answer within 40 seconds (registered yes)',
      );
      const { registerCurrentDevicePush, getPushNotificationStatus } = await loadPush();

      const failed = await registerCurrentDevicePush();
      expect(failed).toMatchObject({ ok: false, code: 'token-unavailable' });
      expect(registerServerMock).not.toHaveBeenCalled();

      // The token arrives later. The native side keeps it and answers the
      // next getToken with it straight away.
      apnsGetTokenMock.mockResolvedValue(APNS_TOKEN);
      window.dispatchEvent(
        new CustomEvent('mobile-push:token-received', { detail: { token: APNS_TOKEN } }),
      );

      await vi.waitFor(() => expect(registerServerMock).toHaveBeenCalledWith(APNS_TOKEN, 'apns'));
      await vi.waitFor(async () =>
        expect(await getPushNotificationStatus()).toMatchObject({ health: 'active' }),
      );
      // The second attempt asks again; with permission granted that returns at once.
      expect(apnsPermissionMock).toHaveBeenCalledTimes(2);
    });

    it('keeps a newer token that arrives while registration is still running', async () => {
      signIn();
      listServerMock.mockResolvedValue([serverRecord()]);
      const NEWER_TOKEN = 'cd'.repeat(32);
      let answerGetToken;
      apnsGetTokenMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerGetToken = resolve;
          }),
      );
      const { registerCurrentDevicePush } = await loadPush();

      const pending = registerCurrentDevicePush();
      await vi.waitFor(() => expect(answerGetToken).toBeTypeOf('function'));
      // The recovery registration answers with a new token while the first
      // answer is still being registered.
      window.dispatchEvent(
        new CustomEvent('mobile-push:token-received', { detail: { token: NEWER_TOKEN } }),
      );
      answerGetToken(APNS_TOKEN);
      await pending;

      await vi.waitFor(() => expect(registerServerMock).toHaveBeenCalledWith(NEWER_TOKEN, 'apns'));
      expect(localStore.get('push_notification_token')).toBe(NEWER_TOKEN);
    });

    it('passes the native displayedBySystem flag through and marks taps', async () => {
      signIn();
      const { initPushTapHandling, syncPushNotifications } = await loadPush();
      expect(await syncPushNotifications()).toBe(true);
      await initPushTapHandling();
      const capture = capturePushEvents();

      const payload = { event: 'newMessage', notification_id: 'n-1' };
      window.dispatchEvent(
        new CustomEvent('mobile-push:notification-received', {
          detail: { data: payload, displayedBySystem: true },
        }),
      );
      window.dispatchEvent(
        new CustomEvent('mobile-push:notification-received', {
          detail: { data: { ...payload, notification_id: 'n-2' }, displayedBySystem: false },
        }),
      );
      // A tap is queued natively (macos.rs) and the event wakes the page.
      pendingTaps = [{ data: { ...payload, notification_id: 'n-3' } }];
      window.dispatchEvent(
        new CustomEvent('mobile-push:notification-tapped', {
          detail: { data: { ...payload, notification_id: 'n-3' } },
        }),
      );
      await vi.waitFor(() => expect(capture.events).toHaveLength(3));
      capture.stop();

      expect(capture.events).toHaveLength(3);
      expect(capture.events[0]).toMatchObject({ notification_id: 'n-1', displayedBySystem: true });
      expect(capture.events[1].notification_id).toBe('n-2');
      expect(capture.events[1]).not.toHaveProperty('displayedBySystem');
      expect(capture.events[2]).toMatchObject({
        notification_id: 'n-3',
        notificationTapped: true,
        displayedBySystem: true,
      });
    });

    it('re-registers every account when APNs hands the Mac a new token', async () => {
      signIn();
      const { syncPushNotifications } = await loadPush();
      await syncPushNotifications();
      registerServerMock.mockClear();
      unregisterServerMock.mockClear();

      const refreshed = 'cd'.repeat(32);
      window.dispatchEvent(
        new CustomEvent('mobile-push:token-received', { detail: { token: refreshed } }),
      );

      await vi.waitFor(() => expect(registerServerMock).toHaveBeenCalledWith(refreshed, 'apns'));
      expect(unregisterServerMock).toHaveBeenCalledWith('registration-mac');
    });

    it('expects a system alert only for newMessage events of registered accounts', async () => {
      signIn();
      const { isSystemPushAlertExpected, syncPushNotifications } = await loadPush();

      expect(isSystemPushAlertExpected('newMessage', { _account: EMAIL })).toBe(false);
      await syncPushNotifications();

      expect(isSystemPushAlertExpected('newMessage', { _account: EMAIL })).toBe(true);
      expect(isSystemPushAlertExpected('newMessage', {})).toBe(true);
      expect(isSystemPushAlertExpected('flagsUpdated', { _account: EMAIL })).toBe(false);
      expect(isSystemPushAlertExpected('newMessage', { _account: 'other@example.com' })).toBe(
        false,
      );
    });

    it('opens the Notifications pane of System Settings', async () => {
      const { openNotificationSettings } = await loadPush();

      expect(await openNotificationSettings()).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith('plugin:mobile-push|open_settings');
    });
  });

  describe('build not signed for APNs', () => {
    beforeEach(() => {
      permissionState = 'unsupported';
    });

    it('reports macOS as unsupported without a provider', async () => {
      signIn();
      const { getPushNotificationStatus } = await loadPush();

      const status = await getPushNotificationStatus();

      expect(status).toMatchObject({
        supported: false,
        platform: 'macos',
        provider: null,
        permission: 'unsupported',
        health: 'unsupported',
      });
      expect(listServerMock).not.toHaveBeenCalled();
    });

    it('never prompts or registers on sync, and does not warn', async () => {
      signIn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { getLastPushRegistrationFailure, syncPushNotifications } = await loadPush();

      expect(await syncPushNotifications()).toBe(false);

      expect(apnsPermissionMock).not.toHaveBeenCalled();
      expect(apnsGetTokenMock).not.toHaveBeenCalled();
      expect(registerServerMock).not.toHaveBeenCalled();
      expect(getLastPushRegistrationFailure()).toMatchObject({ code: 'unsupported' });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('refuses registration from Settings with the unsupported code', async () => {
      signIn();
      const { registerCurrentDevicePush } = await loadPush();

      const result = await registerCurrentDevicePush();

      expect(result).toMatchObject({ ok: false, code: 'unsupported' });
      expect(apnsPermissionMock).not.toHaveBeenCalled();
    });

    it('never expects a system alert', async () => {
      signIn();
      const { isSystemPushAlertExpected, syncPushNotifications } = await loadPush();
      await syncPushNotifications();

      expect(isSystemPushAlertExpected('newMessage', { _account: EMAIL })).toBe(false);
    });
  });
});
