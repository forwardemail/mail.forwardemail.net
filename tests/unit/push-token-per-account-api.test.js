/**
 Push Token Per-Account API Tests

 Verifies that registerPushTokenForAccount:
 - Uses buildAliasAuthHeader with explicit aliasAuth (not getAuthHeader)
 - Normalizes platform names to provider identifiers
 - Returns registration ID on success
 - Returns null on server error, missing ID, or invalid platform
 */

const {fetchMock, buildAliasAuthHeaderMock} = vi.hoisted(() => ({
	fetchMock: vi.fn(),
	buildAliasAuthHeaderMock: vi.fn(),
}));

vi.mock('../../src/utils/auth.ts', () => ({
	getAuthHeader: vi.fn(() => 'Basic active-credentials'),
	buildAliasAuthHeader: buildAliasAuthHeaderMock,
}));

vi.mock('../../src/utils/platform.js', () => ({
	getPlatform: vi.fn(() => 'mobile'),
	isTauri: true,
	isTauriDesktop: false,
	isTauriMobile: true,
}));

const APNS_TOKEN = 'apns-token-abcdefghijklmnopqrstuvwxyz';
const FCM_TOKEN = 'fcm-token-abcdefghijklmnopqrstuvwxyz';
const ACCOUNT_A_AUTH = 'alice@example.com:password-a';
const ACCOUNT_B_AUTH = 'bob@example.com:password-b';

describe('registerPushTokenForAccount API', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		buildAliasAuthHeaderMock.mockReturnValue('Basic account-credentials');
		fetchMock.mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({id: 'account-reg-1'}),
		});
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('uses buildAliasAuthHeader with the provided aliasAuth instead of getAuthHeader', async () => {
		const {registerPushTokenForAccount} = await import('../../src/utils/background-service.js');

		const result = await registerPushTokenForAccount(APNS_TOKEN, 'ios', ACCOUNT_A_AUTH);

		expect(result).toBe('account-reg-1');
		expect(buildAliasAuthHeaderMock).toHaveBeenCalledWith(ACCOUNT_A_AUTH, {required: true});
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, request] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.forwardemail.net/v1/push-tokens');
		expect(request).toMatchObject({
			method: 'POST',
			headers: {
				Authorization: 'Basic account-credentials',
				'Content-Type': 'application/json',
			},
		});
		expect(JSON.parse(request.body)).toMatchObject({
			token: APNS_TOKEN,
			platform: 'apns',
		});
	});

	it.each([
		['ios', APNS_TOKEN, 'apns'],
		['android', FCM_TOKEN, 'fcm'],
	])(
		'normalizes %s platform to %s provider for per-account registration',
		async (platform, token, provider) => {
			const {registerPushTokenForAccount} = await import('../../src/utils/background-service.js');

			await registerPushTokenForAccount(token, platform, ACCOUNT_B_AUTH);

			expect(fetchMock).toHaveBeenCalledOnce();
			expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
				token,
				platform: provider,
			});
		},
	);

	it('returns null when the server responds with a non-ok status', async () => {
		fetchMock.mockResolvedValueOnce({ok: false, status: 401});
		const {registerPushTokenForAccount} = await import('../../src/utils/background-service.js');

		const result = await registerPushTokenForAccount(APNS_TOKEN, 'ios', ACCOUNT_A_AUTH);

		expect(result).toBeNull();
	});

	it('returns null when the response has no registration id', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: vi.fn().mockResolvedValue({}),
		});
		const {registerPushTokenForAccount} = await import('../../src/utils/background-service.js');

		const result = await registerPushTokenForAccount(APNS_TOKEN, 'ios', ACCOUNT_A_AUTH);

		expect(result).toBeNull();
	});

	it('returns null for an invalid platform', async () => {
		const {registerPushTokenForAccount} = await import('../../src/utils/background-service.js');

		const result = await registerPushTokenForAccount(APNS_TOKEN, 'windows', ACCOUNT_A_AUTH);

		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns null when fetch throws a network error', async () => {
		fetchMock.mockRejectedValueOnce(new Error('Network failure'));
		const {registerPushTokenForAccount} = await import('../../src/utils/background-service.js');

		const result = await registerPushTokenForAccount(APNS_TOKEN, 'ios', ACCOUNT_A_AUTH);

		expect(result).toBeNull();
	});
});
