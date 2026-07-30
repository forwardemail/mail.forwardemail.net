/**
 * Attributing an inbound push notification to the right mailbox.
 *
 * The server stamps push payloads with `alias_id` and no email address, while
 * every consumer in the app scopes on `_account`. That gap is why a push used
 * to be treated as belonging to whichever account was on screen: it drove the
 * active account's folder refresh and its notification, no matter which mailbox
 * actually received the mail.
 *
 * The device learns the alias-to-email association from the push-token
 * registration response, which returns the alias it registered against. These
 * tests pin that capture and the resolution that depends on it.
 */

const { registerPushTokenMock, registerForAccountMock, callbacks, listenerCleanup } = vi.hoisted(
  () => ({
    registerPushTokenMock: vi.fn(),
    registerForAccountMock: vi.fn(),
    callbacks: {},
    listenerCleanup: { unregister: vi.fn(() => Promise.resolve()) },
  }),
);

vi.mock('../../src/utils/platform.js', () => ({ isTauriMobile: true }));

vi.mock('../../src/utils/background-service.js', () => ({
  listPushTokens: vi.fn().mockResolvedValue([]),
  registerPushToken: registerPushTokenMock,
  registerPushTokenForAccount: registerForAccountMock,
  unregisterPushToken: vi.fn().mockResolvedValue(true),
  unregisterPushTokenForAccount: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/utils/notification-bridge.js', () => ({
  requestPermission: vi.fn(() => Promise.resolve('granted')),
}));

const localValues = new Map();
const accountList = [];

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn((key) => localValues.get(key) ?? null),
    set: vi.fn((key, value) => localValues.set(key, value)),
    remove: vi.fn((key) => localValues.delete(key)),
  },
  Accounts: {
    getAll: vi.fn(() => accountList),
  },
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

vi.mock('tauri-plugin-remote-push-api', () => ({
  getToken: vi.fn(() => Promise.resolve('fcm-device-token-1234567890')),
  requestPermission: vi.fn(() => Promise.resolve({ granted: true })),
  onTokenRefresh: vi.fn(async (cb) => {
    callbacks.tokenRefresh = cb;
    return listenerCleanup;
  }),
  onNotificationReceived: vi.fn(async (cb) => {
    callbacks.received = cb;
    return listenerCleanup;
  }),
  onNotificationTapped: vi.fn(async (cb) => {
    callbacks.tapped = cb;
    return listenerCleanup;
  }),
}));

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const ALICE_ALIAS = '651f0000000000000000aaaa';
const BOB_ALIAS = '651f0000000000000000bbbb';

async function bootWithBothAccounts() {
  const { initPushNotifications, syncPushNotifications } =
    await import('../../src/utils/push-notifications.js');
  await initPushNotifications();
  await syncPushNotifications();
}

function captureDispatched() {
  const events = [];
  const handler = (event) => events.push(event.detail);
  window.addEventListener('fe:push-notification', handler);
  return {
    events,
    stop: () => window.removeEventListener('fe:push-notification', handler),
  };
}

describe('push notification account attribution', () => {
  beforeEach(async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Android');
    const { cleanupPushNotifications } = await import('../../src/utils/push-notifications.js');
    await cleanupPushNotifications();
    vi.clearAllMocks();
    localValues.clear();
    accountList.length = 0;
    for (const key of Object.keys(callbacks)) delete callbacks[key];

    localValues.set('email', ALICE);
    localValues.set('alias_auth', `${ALICE}:secret`);
    accountList.push(
      { email: ALICE, aliasAuth: `${ALICE}:secret` },
      { email: BOB, aliasAuth: `${BOB}:secret` },
    );

    registerPushTokenMock.mockResolvedValue({ id: 'alice-reg', aliasId: ALICE_ALIAS });
    registerForAccountMock.mockResolvedValue({ id: 'bob-reg', aliasId: BOB_ALIAS });
  });

  afterEach(async () => {
    const { cleanupPushNotifications } = await import('../../src/utils/push-notifications.js');
    await cleanupPushNotifications();
    vi.restoreAllMocks();
  });

  it('stores the alias each account registered against', async () => {
    await bootWithBothAccounts();

    const stored = JSON.parse(localValues.get('push_registrations'));
    expect(stored[ALICE]?.aliasId).toBe(ALICE_ALIAS);
    expect(stored[BOB]?.aliasId).toBe(BOB_ALIAS);
  });

  it('resolves an alias ID back to the account that owns it', async () => {
    await bootWithBothAccounts();
    const { resolveAccountForAliasId } = await import('../../src/utils/push-notifications.js');

    expect(resolveAccountForAliasId(BOB_ALIAS)).toBe(BOB);
    expect(resolveAccountForAliasId(ALICE_ALIAS)).toBe(ALICE);
    expect(resolveAccountForAliasId('an-alias-we-never-registered')).toBe('');
    expect(resolveAccountForAliasId('')).toBe('');
  });

  it('tags a delivered push with the account it belongs to, not the active one', async () => {
    await bootWithBothAccounts();
    const captured = captureDispatched();

    // Mail arrives for Bob while Alice is the account on screen.
    await callbacks.received({
      data: { event: 'newMessage', alias_id: BOB_ALIAS, mailbox: 'INBOX', subject: 'Hi' },
    });
    captured.stop();

    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]._account).toBe(BOB);
  });

  it('drops a push for an alias no signed-in account claims', async () => {
    await bootWithBothAccounts();
    const captured = captureDispatched();

    // A registration the server has not pruned since the account signed out.
    // Passing it through untagged would make it look like the active account's.
    await callbacks.received({
      data: { event: 'newMessage', alias_id: 'stale-alias-id', mailbox: 'INBOX' },
    });
    captured.stop();

    expect(captured.events).toHaveLength(0);
  });

  it('still delivers a push when no alias map exists yet', async () => {
    // A device whose registrations predate alias capture has nothing to match
    // against. Dropping everything there would silently stop notifications, so
    // the payload passes through untagged and downstream treats it as active.
    registerPushTokenMock.mockResolvedValue({ id: 'legacy-reg', aliasId: '' });
    registerForAccountMock.mockResolvedValue({ id: 'legacy-reg-b', aliasId: '' });
    await bootWithBothAccounts();
    const captured = captureDispatched();

    await callbacks.received({
      data: { event: 'newMessage', alias_id: ALICE_ALIAS, mailbox: 'INBOX' },
    });
    captured.stop();

    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]._account).toBeUndefined();
  });

  it('stays permissive while only some accounts are mapped', async () => {
    // Bob's re-registration failed on a flaky network, so his alias is unknown.
    // Dropping unmatched aliases here would silently suppress Bob's mailbox
    // until the next reconcile, so an incomplete map means deliver-and-let the
    // active-account gate downstream decide.
    registerForAccountMock.mockResolvedValue(null);
    await bootWithBothAccounts();
    const captured = captureDispatched();

    await callbacks.received({
      data: { event: 'newMessage', alias_id: BOB_ALIAS, mailbox: 'INBOX' },
    });
    captured.stop();

    expect(captured.events).toHaveLength(1);
  });

  it('never attributes a push to the signed-out sentinel registration', async () => {
    // reconcileAllAccounts stores a '__active_session__' registration when push
    // is set up with no accounts list. It is a registration, not an account:
    // resolving it as an "email" would feed a non-address into every _account
    // comparison downstream, which all read as "not active" and silently drop
    // the notification.
    const { resolveAccountForAliasId, hasCompleteAliasIdMap } =
      await import('../../src/utils/push-notifications.js');
    localValues.set(
      'push_registrations',
      JSON.stringify({
        __active_session__: { regId: 'r1', token: 't', platform: 'fcm', aliasId: ALICE_ALIAS },
      }),
    );
    accountList.length = 0;

    expect(resolveAccountForAliasId(ALICE_ALIAS)).toBe('');
    // And with only the sentinel known, an unmatched alias proves nothing —
    // the map must not count as complete, or this session's own pushes would
    // be dropped as "unknown".
    expect(hasCompleteAliasIdMap()).toBe(false);
  });
});
