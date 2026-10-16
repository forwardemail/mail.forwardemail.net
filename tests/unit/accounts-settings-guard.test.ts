/**
 * Settings requests are made for one account. When the user switches before
 * the answer arrives, the answer belongs in that account's cache and must not
 * be shown on the account now on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

type Deferred = { resolve: (value: unknown) => void; reject: (err: unknown) => void };

const { requests, cachePuts } = vi.hoisted(() => ({
  requests: [] as Array<{
    action: string;
    options: Record<string, unknown> | undefined;
    deferred: Deferred;
  }>,
  cachePuts: [] as Array<{ account: string; settings: Record<string, unknown> }>,
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: {
    request: vi.fn(
      (action: string, _body: unknown, options?: Record<string, unknown>) =>
        new Promise((resolve, reject) => {
          requests.push({ action, options, deferred: { resolve, reject } });
        }),
    ),
  },
}));

vi.mock('../../src/utils/db', () => ({
  db: {
    settings: {
      get: vi.fn(async () => null),
      put: vi.fn(async (row: { account: string; settings: Record<string, unknown> }) => {
        cachePuts.push(row);
      }),
    },
    settingsLabels: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    meta: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
  },
  handleDatabaseError: vi.fn(async () => ({ recovered: false })),
}));

import { Accounts } from '../../src/utils/storage';
import { fetchSettings, updateSettings, remoteSettings } from '../../src/stores/settingsStore';

const ALICE = { email: 'alice@example.com', aliasAuth: 'alice@example.com:alice-pw' };
const BOB = { email: 'bob@example.com', aliasAuth: 'bob@example.com:bob-pw' };

const accountResponse = (sentFolder: string) => ({
  settings: { mail: { sent_folder: sentFolder } },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitForRequest = async (action: string) => {
  for (let i = 0; i < 20; i += 1) {
    const found = requests.find((r) => r.action === action);
    if (found) return found;
    await flush();
  }
  throw new Error(`no ${action} request`);
};

// fetchAccountData keeps answers for 15 seconds. Each test starts a minute
// later so it makes its own request.
let clock = Date.parse('2026-10-15T09:00:00Z');

beforeEach(() => {
  clock += 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  localStorage.clear();
  sessionStorage.clear();
  requests.length = 0;
  cachePuts.length = 0;
  localStorage.setItem('webmail_accounts', JSON.stringify([ALICE, BOB]));
  Accounts.setActive(ALICE.email);
  remoteSettings.set({ mail: { sent_folder: 'Alice Sent' }, labels: [], aliases: {} } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchSettings across an account switch', () => {
  it('caches the late answer for the account that asked and leaves the screen alone', async () => {
    const pending = fetchSettings();
    const request = await waitForRequest('Account');
    expect(request.options?.authHeader).toBe(`Basic ${btoa(ALICE.aliasAuth)}`);

    // The user switches to Bob, whose settings are now on screen.
    Accounts.setActive(BOB.email);
    remoteSettings.set({ mail: { sent_folder: 'Bob Sent' }, labels: [], aliases: {} } as never);

    request.deferred.resolve(accountResponse('Alice Sent v2'));
    await pending;

    expect(get(remoteSettings).mail.sent_folder).toBe('Bob Sent');
    expect(
      cachePuts.map((p) => [p.account, (p.settings.mail as Record<string, unknown>).sent_folder]),
    ).toEqual([[ALICE.email, 'Alice Sent v2']]);
  });

  it('applies the answer when the account is still on screen', async () => {
    const pending = fetchSettings();
    const request = await waitForRequest('Account');
    request.deferred.resolve(accountResponse('Alice Sent v3'));
    await pending;

    expect(get(remoteSettings).mail.sent_folder).toBe('Alice Sent v3');
  });
});

describe('updateSettings across an account switch', () => {
  it("caches Alice's change under Alice, not Bob's settings", async () => {
    const pending = updateSettings({ mail: { sent_folder: 'Alice Outbox' } } as never);
    const request = await waitForRequest('AccountUpdate');
    expect(request.options?.authHeader).toBe(`Basic ${btoa(ALICE.aliasAuth)}`);

    Accounts.setActive(BOB.email);
    remoteSettings.set({ mail: { sent_folder: 'Bob Sent' }, labels: [], aliases: {} } as never);

    request.deferred.resolve({});
    expect(await pending).toBe(true);

    expect(cachePuts).toHaveLength(1);
    expect(cachePuts[0].account).toBe(ALICE.email);
    expect((cachePuts[0].settings.mail as Record<string, unknown>).sent_folder).toBe(
      'Alice Outbox',
    );
    expect(get(remoteSettings).mail.sent_folder).toBe('Bob Sent');
  });

  it("does not roll Bob's screen back to Alice's settings when Alice's save fails", async () => {
    const pending = updateSettings({ mail: { sent_folder: 'Alice Outbox' } } as never);
    const request = await waitForRequest('AccountUpdate');

    Accounts.setActive(BOB.email);
    remoteSettings.set({ mail: { sent_folder: 'Bob Sent' }, labels: [], aliases: {} } as never);

    request.deferred.reject(new Error('Network error'));
    expect(await pending).toBe(false);

    expect(get(remoteSettings).mail.sent_folder).toBe('Bob Sent');
  });
});
