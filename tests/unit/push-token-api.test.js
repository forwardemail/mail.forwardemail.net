const { fetchMock, getAuthHeaderMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getAuthHeaderMock: vi.fn(),
}));

vi.mock('../../src/utils/auth.ts', () => ({
  getAuthHeader: getAuthHeaderMock,
}));

vi.mock('../../src/utils/platform.js', () => ({
  getPlatform: vi.fn(() => 'mobile'),
  isTauri: true,
  isTauriDesktop: false,
  isTauriMobile: true,
}));

const APNS_TOKEN = 'apns-token-abcdefghijklmnopqrstuvwxyz';
const FCM_TOKEN = 'fcm-token-abcdefghijklmnopqrstuvwxyz';

describe('push-token API', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getAuthHeaderMock.mockReturnValue('Basic alias-credentials');
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: 'registration-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['ios', APNS_TOKEN, 'apns'],
    ['android', FCM_TOKEN, 'fcm'],
  ])('posts a %s token with its normalized provider', async (platform, token, provider) => {
    const { registerPushToken } = await import('../../src/utils/background-service.js');

    await expect(registerPushToken(token, platform)).resolves.toBe('registration-1');

    expect(getAuthHeaderMock).toHaveBeenCalledWith({ allowApiKey: false, required: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.forwardemail.net/v1/push-tokens');
    expect(request).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Basic alias-credentials',
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(request.body)).toMatchObject({
      token,
      platform: provider,
    });
  });

  it('lists the authenticated alias push registrations without exposing another auth mode', async () => {
    const registrations = [
      {
        id: 'registration-1',
        platform: 'apns',
        token: APNS_TOKEN,
      },
    ];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(registrations),
    });
    const { listPushTokens } = await import('../../src/utils/background-service.js');

    await expect(listPushTokens()).resolves.toEqual(registrations);

    expect(getAuthHeaderMock).toHaveBeenCalledWith({ allowApiKey: false, required: true });
    expect(fetchMock).toHaveBeenCalledWith('https://api.forwardemail.net/v1/push-tokens', {
      method: 'GET',
      headers: {
        Authorization: 'Basic alias-credentials',
      },
    });
  });

  it.each([
    ['an unsuccessful response', { ok: false, status: 503 }],
    [
      'a malformed response',
      {
        ok: true,
        json: vi.fn().mockResolvedValue({ registrations: [] }),
      },
    ],
  ])('returns null when listing receives %s', async (_label, response) => {
    fetchMock.mockResolvedValueOnce(response);
    const { listPushTokens } = await import('../../src/utils/background-service.js');

    await expect(listPushTokens()).resolves.toBeNull();
  });

  it.each([
    ['a successful deletion', { ok: true, status: 204 }],
    ['an already absent registration', { ok: false, status: 404 }],
  ])('deletes an encoded registration ID for %s', async (_label, response) => {
    fetchMock.mockResolvedValueOnce(response);
    const { unregisterPushToken } = await import('../../src/utils/background-service.js');

    await expect(unregisterPushToken('registration/with spaces')).resolves.toBe(true);

    expect(getAuthHeaderMock).toHaveBeenCalledWith({ allowApiKey: false, required: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.forwardemail.net/v1/push-tokens/registration%2Fwith%20spaces',
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Basic alias-credentials',
        },
      },
    );
  });

  it('reports a failed registration deletion without clearing it locally', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const { unregisterPushToken } = await import('../../src/utils/background-service.js');

    await expect(unregisterPushToken('registration-1')).resolves.toBe(false);
  });
});
