import { beforeEach, describe, expect, it, vi } from 'vitest';

let actionHandler;
let signedIn = [];
const localStore = new Map();

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  isTauriMobile: false,
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (key) => localStore.get(key) ?? null,
    set: (key, value) => localStore.set(key, value),
    remove: (key) => localStore.delete(key),
  },
  Accounts: {
    getAll: () => signedIn.map((email) => ({ email })),
  },
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true),
  sendNotification: vi.fn(),
  onAction: vi.fn(async (handler) => {
    actionHandler = handler;
  }),
  registerActionTypes: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: vi.fn(async () => () => {}),
  }),
}));

// Clicking a notification for another signed-in account used to switch
// accounts and set the hash 150ms later. The switch itself takes longer and
// re-selects the new account's inbox, so the user ended up on the inbox.
// Opening now goes through notification-open.ts, which waits for the switch.
describe('notification click → account switch', () => {
  let switched;
  let navigated;
  let finishSwitch;
  let ready;

  const configure = async () => {
    const { configureNotificationOpen, __resetNotificationOpenForTests } =
      await import('../../src/utils/notification-open.ts');
    __resetNotificationOpenForTests();
    configureNotificationOpen({
      isReady: () => ready,
      switchAccount: (email) => {
        switched.push(email);
        return new Promise((resolve) => {
          finishSwitch = () => {
            localStore.set('email', email);
            resolve();
          };
        });
      },
      navigate: (path) => navigated.push(path),
    });
  };

  const click = async (extra) => {
    const { initTauriNotificationClickHandler } =
      await import('../../src/utils/notification-bridge.js');
    await initTauriNotificationClickHandler();
    expect(typeof actionHandler).toBe('function');
    actionHandler({ extra });
    await Promise.resolve();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    actionHandler = undefined;
    localStore.clear();
    localStore.set('email', 'alice@example.com');
    signedIn = ['alice@example.com', 'bob@example.com'];
    switched = [];
    navigated = [];
    finishSwitch = undefined;
    ready = true;
    await configure();
  });

  it('switches to the notification account and navigates only once the switch is done', async () => {
    await click({ account: 'bob@example.com', folder: 'INBOX', messageId: 'm-99' });

    expect(switched).toEqual(['bob@example.com']);
    // The switch has not finished: navigating now is what used to be undone.
    expect(navigated).toEqual([]);

    finishSwitch();
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/m-99']));
  });

  it('does not switch when the notification is for the active account', async () => {
    await click({ account: 'alice@example.com', folder: 'INBOX', messageId: 'm-42' });
    expect(switched).toEqual([]);
    expect(navigated).toEqual(['/mailbox#INBOX/m-42']);
  });

  it('compares accounts case-insensitively', async () => {
    localStore.set('email', 'Alice@Example.COM');
    await click({ account: 'alice@example.com', folder: 'INBOX', messageId: 'm-10' });
    expect(switched).toEqual([]);
    expect(navigated).toEqual(['/mailbox#INBOX/m-10']);
  });

  it('opens older notifications that only carry a path', async () => {
    await click({ path: '#inbox/55' });
    expect(navigated).toEqual(['/mailbox#INBOX/55']);
  });

  it('ignores a notification for an account that is no longer signed in', async () => {
    signedIn = ['alice@example.com'];
    await click({ account: 'carol@example.com', folder: 'INBOX', messageId: 'm-1' });
    expect(switched).toEqual([]);
    expect(navigated).toEqual([]);
  });

  it('holds a click made while the app is locked until it is unlocked', async () => {
    ready = false;
    await click({ account: 'alice@example.com', folder: 'INBOX', messageId: 'm-7' });
    expect(navigated).toEqual([]);

    ready = true;
    const { flushPendingNotificationOpen } = await import('../../src/utils/notification-open.ts');
    await flushPendingNotificationOpen();
    expect(navigated).toEqual(['/mailbox#INBOX/m-7']);
  });

  it('lets the newest click win when one arrives during an account switch', async () => {
    await click({ account: 'bob@example.com', folder: 'INBOX', messageId: 'm-old' });
    expect(switched).toEqual(['bob@example.com']);
    await click({ account: 'alice@example.com', folder: 'INBOX', messageId: 'm-new' });

    finishSwitch();
    // bob is now active, so the newer click (for alice) switches back.
    await vi.waitFor(() => expect(switched).toEqual(['bob@example.com', 'alice@example.com']));
    finishSwitch();
    await vi.waitFor(() => expect(navigated).toEqual(['/mailbox#INBOX/m-new']));
  });
});

describe('notification data includes account field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStore.clear();
    localStore.set('email', 'alice@example.com');
  });

  it('notify() passes account through to Tauri extra payload', async () => {
    const tauriNotif = await import('@tauri-apps/plugin-notification');
    const { notify } = await import('../../src/utils/notification-bridge.js');

    await notify({
      title: 'New email',
      body: 'Hello',
      data: {
        path: '#inbox/1',
        uid: '1',
        account: 'bob@example.com',
      },
    });

    expect(tauriNotif.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({
          account: 'bob@example.com',
        }),
      }),
    );
  });

  it('notify() omits account from extra when not provided', async () => {
    const tauriNotif = await import('@tauri-apps/plugin-notification');
    const { notify } = await import('../../src/utils/notification-bridge.js');

    await notify({
      title: 'New email',
      body: 'Hello',
      data: {
        path: '#inbox/1',
        uid: '1',
      },
    });

    const call = tauriNotif.sendNotification.mock.calls[0][0];
    expect(call.extra).not.toHaveProperty('account');
  });
});
