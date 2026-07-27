/**
 Push Notifications – Multi-Account Registration Integration Tests

 Verifies that:
 - reconcileAllAccounts registers the token for all signed-in accounts
 - The active account uses registerPushToken (session auth)
 - Other accounts use registerPushTokenForAccount (per-account auth)
 - Per-account registrations are persisted in push_registrations map
 - Token rotation unregisters old registrations before re-registering
 - cleanupPushNotifications unregisters ALL accounts' registrations
 - Failures in one account's registration do not block others
 */

const {
	accountsGetAllMock,
	localStore,
	registerServerMock,
	registerForAccountMock,
	unregisterServerMock,
	unregisterForAccountMock,
} = vi.hoisted(() => ({
	accountsGetAllMock: vi.fn(),
	localStore: new Map(),
	registerServerMock: vi.fn(),
	registerForAccountMock: vi.fn(),
	unregisterServerMock: vi.fn(),
	unregisterForAccountMock: vi.fn(),
}));

vi.mock('../../src/utils/demo-mode.js', () => ({
	isDemoMode: vi.fn(() => false),
}));

vi.mock('../../src/utils/platform.js', () => ({
	isTauriMobile: true,
}));

vi.mock('../../src/utils/storage', () => ({
	Local: {
		get: vi.fn(key => localStore.get(key)),
		set: vi.fn((key, value) => localStore.set(key, value)),
		remove: vi.fn(key => localStore.delete(key)),
	},
	Accounts: {
		getAll: accountsGetAllMock,
	},
}));

vi.mock('../../src/utils/background-service.js', () => ({
	listPushTokens: vi.fn().mockResolvedValue([]),
	registerPushToken: registerServerMock,
	registerPushTokenForAccount: registerForAccountMock,
	unregisterPushToken: unregisterServerMock,
	unregisterPushTokenForAccount: unregisterForAccountMock,
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
	getToken: vi.fn().mockResolvedValue('fcm-token-abcdefghijklmnopqrstuvwxyz'),
	onNotificationReceived: vi.fn().mockResolvedValue({unregister: vi.fn()}),
	onNotificationTapped: vi.fn().mockResolvedValue({unregister: vi.fn()}),
	onTokenRefresh: vi.fn().mockResolvedValue({unregister: vi.fn()}),
	requestPermission: vi.fn().mockResolvedValue({granted: true}),
}));

vi.mock('tauri-plugin-mobile-push-api', () => ({
	getToken: vi.fn().mockResolvedValue('apns-token-abcdefghijklmnopqrstuvwxyz'),
	onNotificationReceived: vi.fn().mockResolvedValue({unregister: vi.fn()}),
	onNotificationTapped: vi.fn().mockResolvedValue({unregister: vi.fn()}),
	onTokenRefresh: vi.fn().mockResolvedValue({unregister: vi.fn()}),
	requestPermission: vi.fn().mockResolvedValue({granted: true}),
}));

const APNS_TOKEN = 'apns-token-abcdefghijklmnopqrstuvwxyz';
const FCM_TOKEN = 'fcm-token-abcdefghijklmnopqrstuvwxyz';
const ACCOUNT_A_AUTH = 'alice@example.com:password-a';
const ACCOUNT_B_AUTH = 'bob@example.com:password-b';
const ACCOUNT_C_AUTH = 'carol@example.com:password-c';

function setUserAgent(value) {
	Object.defineProperty(navigator, 'userAgent', {
		configurable: true,
		value,
	});
}

describe('multi-account push registration flow', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.stubEnv('VITE_ANDROID_PUSH_PROVIDER', 'fcm');
		localStore.clear();
		accountsGetAllMock.mockReturnValue([]);
		registerServerMock.mockResolvedValue('primary-reg-1');
		registerForAccountMock.mockResolvedValue('account-reg-1');
		unregisterServerMock.mockResolvedValue(true);
		unregisterForAccountMock.mockResolvedValue(true);
		setUserAgent('ForwardEmail/1.0 (Android 15)');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('registers the token for all non-active accounts after primary registration', async () => {
		localStore.set('alias_auth', ACCOUNT_A_AUTH);
		localStore.set('email', 'alice@example.com');
		accountsGetAllMock.mockReturnValue([
			{email: 'alice@example.com', aliasAuth: ACCOUNT_A_AUTH},
			{email: 'bob@example.com', aliasAuth: ACCOUNT_B_AUTH},
			{email: 'carol@example.com', aliasAuth: ACCOUNT_C_AUTH},
		]);

		const {syncPushNotifications} = await import('../../src/utils/push-notifications.js');
		await expect(syncPushNotifications()).resolves.toBe(true);

		// Active account uses registerPushToken (session auth)
		expect(registerServerMock).toHaveBeenCalledWith(FCM_TOKEN, 'android');
		// Other accounts use registerPushTokenForAccount (per-account auth)
		expect(registerForAccountMock).toHaveBeenCalledTimes(2);
		expect(registerForAccountMock).toHaveBeenCalledWith(FCM_TOKEN, 'android', ACCOUNT_B_AUTH);
		expect(registerForAccountMock).toHaveBeenCalledWith(FCM_TOKEN, 'android', ACCOUNT_C_AUTH);
	});

	it('skips accounts without aliasAuth credentials', async () => {
		localStore.set('alias_auth', ACCOUNT_A_AUTH);
		localStore.set('email', 'alice@example.com');
		accountsGetAllMock.mockReturnValue([
			{email: 'alice@example.com', aliasAuth: ACCOUNT_A_AUTH},
			{email: 'bob@example.com', aliasAuth: null},
			{email: 'carol@example.com', aliasAuth: ACCOUNT_C_AUTH},
		]);

		const {syncPushNotifications} = await import('../../src/utils/push-notifications.js');
		await expect(syncPushNotifications()).resolves.toBe(true);

		expect(registerForAccountMock).toHaveBeenCalledTimes(1);
		expect(registerForAccountMock).toHaveBeenCalledWith(FCM_TOKEN, 'android', ACCOUNT_C_AUTH);
	});

	it('does not register for other accounts when only one account exists', async () => {
		localStore.set('alias_auth', ACCOUNT_A_AUTH);
		localStore.set('email', 'alice@example.com');
		accountsGetAllMock.mockReturnValue([
			{email: 'alice@example.com', aliasAuth: ACCOUNT_A_AUTH},
		]);

		const {syncPushNotifications} = await import('../../src/utils/push-notifications.js');
		await expect(syncPushNotifications()).resolves.toBe(true);

		expect(registerServerMock).toHaveBeenCalledOnce();
		expect(registerForAccountMock).not.toHaveBeenCalled();
	});

	it('persists per-account registration IDs in push_registrations storage', async () => {
		localStore.set('alias_auth', ACCOUNT_A_AUTH);
		localStore.set('email', 'alice@example.com');
		registerForAccountMock
			.mockResolvedValueOnce('bob-reg-1')
			.mockResolvedValueOnce('carol-reg-1');
		accountsGetAllMock.mockReturnValue([
			{email: 'alice@example.com', aliasAuth: ACCOUNT_A_AUTH},
			{email: 'bob@example.com', aliasAuth: ACCOUNT_B_AUTH},
			{email: 'carol@example.com', aliasAuth: ACCOUNT_C_AUTH},
		]);

		const {syncPushNotifications} = await import('../../src/utils/push-notifications.js');
		await syncPushNotifications();

		const stored = JSON.parse(localStore.get('push_registrations'));
		expect(stored['alice@example.com']?.regId).toBe('primary-reg-1');
		expect(stored['bob@example.com']?.regId).toBe('bob-reg-1');
		expect(stored['carol@example.com']?.regId).toBe('carol-reg-1');
	});

	it('rotates previous per-account registration when token changes', async () => {
		localStore.set('alias_auth', ACCOUNT_A_AUTH);
		localStore.set('email', 'alice@example.com');
		// Seed existing registrations with an OLD token
		const oldRegs = {
			'alice@example.com': {regId: 'old-alice-reg', token: 'old-token', platform: 'android'},
			'bob@example.com': {regId: 'old-bob-reg', token: 'old-token', platform: 'android'},
		};
		localStore.set('push_registrations', JSON.stringify(oldRegs));
		registerForAccountMock.mockResolvedValueOnce('new-bob-reg');
		accountsGetAllMock.mockReturnValue([
			{email: 'alice@example.com', aliasAuth: ACCOUNT_A_AUTH},
			{email: 'bob@example.com', aliasAuth: ACCOUNT_B_AUTH},
		]);

		const {syncPushNotifications} = await import('../../src/utils/push-notifications.js');
		await syncPushNotifications();

		// Old active account registration unregistered via session auth
		expect(unregisterServerMock).toHaveBeenCalledWith('old-alice-reg');
		// Old non-active account registration unregistered via per-account auth
		expect(unregisterForAccountMock).toHaveBeenCalledWith('old-bob-reg', ACCOUNT_B_AUTH);
	});

	it('unregisters all per-account registrations during cleanup', async () => {
		// Seed registrations in the new per-account format
		const regs = {
			'alice@example.com': {regId: 'alice-reg-1', token: FCM_TOKEN, platform: 'android'},
			'bob@example.com': {regId: 'bob-reg-1', token: FCM_TOKEN, platform: 'android'},
			'carol@example.com': {regId: 'carol-reg-1', token: FCM_TOKEN, platform: 'android'},
		};
		localStore.set('push_registrations', JSON.stringify(regs));
		localStore.set('push_notification_token', FCM_TOKEN);
		localStore.set('push_notification_platform', 'android');

		const {cleanupPushNotifications} = await import('../../src/utils/push-notifications.js');
		await cleanupPushNotifications();

		expect(unregisterServerMock).toHaveBeenCalledWith('alice-reg-1');
		expect(unregisterServerMock).toHaveBeenCalledWith('bob-reg-1');
		expect(unregisterServerMock).toHaveBeenCalledWith('carol-reg-1');
		expect(localStore.has('push_registrations')).toBe(false);
	});

	it('handles multi-account registration failure gracefully without blocking primary', async () => {
		localStore.set('alias_auth', ACCOUNT_A_AUTH);
		localStore.set('email', 'alice@example.com');
		registerForAccountMock.mockRejectedValue(new Error('Network error'));
		accountsGetAllMock.mockReturnValue([
			{email: 'alice@example.com', aliasAuth: ACCOUNT_A_AUTH},
			{email: 'bob@example.com', aliasAuth: ACCOUNT_B_AUTH},
		]);

		const {syncPushNotifications} = await import('../../src/utils/push-notifications.js');
		await expect(syncPushNotifications()).resolves.toBe(true);

		// Primary registration still succeeds
		expect(registerServerMock).toHaveBeenCalledWith(FCM_TOKEN, 'android');
	});

	it('works with iOS APNS tokens for multi-account registration', async () => {
		localStore.set('alias_auth', ACCOUNT_A_AUTH);
		localStore.set('email', 'alice@example.com');
		setUserAgent('ForwardEmail/1.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
		accountsGetAllMock.mockReturnValue([
			{email: 'alice@example.com', aliasAuth: ACCOUNT_A_AUTH},
			{email: 'bob@example.com', aliasAuth: ACCOUNT_B_AUTH},
		]);

		const {syncPushNotifications} = await import('../../src/utils/push-notifications.js');
		await expect(syncPushNotifications()).resolves.toBe(true);

		expect(registerServerMock).toHaveBeenCalledWith(APNS_TOKEN, 'ios');
		expect(registerForAccountMock).toHaveBeenCalledWith(APNS_TOKEN, 'ios', ACCOUNT_B_AUTH);
	});
});
