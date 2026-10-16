/**
 * A background contacts refresh runs for one account. If the user switches
 * part way through a multi-page fetch, the remaining pages must still be
 * fetched as that account, or the other account's contacts end up in its
 * autocomplete cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { metaRows, remoteRequest } = vi.hoisted(() => ({
  metaRows: new Map(),
  remoteRequest: vi.fn(),
}));

vi.mock('../../src/utils/db', () => ({
  db: {
    meta: {
      get: async (key) => metaRows.get(key),
      put: async (row) => {
        metaRows.set(row.key, row);
      },
    },
  },
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args) => remoteRequest(...args) },
}));

vi.mock('../../src/utils/network-status', () => ({ isOnline: () => true }));

import { Accounts } from '../../src/utils/storage';
import { getAuthHeader } from '../../src/utils/auth';
import { getContacts } from '../../src/utils/contact-cache.js';

const ALICE = { email: 'alice@example.com', aliasAuth: 'alice@example.com:alice-pw' };
const BOB = { email: 'bob@example.com', aliasAuth: 'bob@example.com:bob-pw' };
const PAGE_SIZE = 500;

const contactsFor = (owner, page, count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${owner}-${page}-${i}`,
    full_name: `${owner} contact ${page}-${i}`,
    emails: [{ value: `${owner}.friend${page}-${i}@example.net` }],
  }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  metaRows.clear();
  remoteRequest.mockReset();
  localStorage.setItem('webmail_accounts', JSON.stringify([ALICE, BOB]));
  Accounts.setActive(ALICE.email);
});

describe('contacts background refresh', () => {
  it('keeps fetching as the account it started for after a switch', async () => {
    // Alice's cache is stale, so getContacts returns it and refreshes behind.
    metaRows.set(`contacts_v2_${ALICE.email}`, {
      key: `contacts_v2_${ALICE.email}`,
      value: [],
      updatedAt: Date.now() - 60 * 60 * 1000,
    });

    // The server answers for whoever the request authenticates as, which is
    // the active account when no header is bound.
    let releaseFirstPage;
    const firstPageGate = new Promise((resolve) => {
      releaseFirstPage = resolve;
    });
    remoteRequest.mockImplementation(async (_action, params, options) => {
      const header = options?.authHeader || getAuthHeader({ allowApiKey: true });
      const owner = header === `Basic ${btoa(ALICE.aliasAuth)}` ? 'alice' : 'bob';
      if (params.page === 1) await firstPageGate;
      const count = params.page === 1 ? PAGE_SIZE : 3;
      return { contacts: contactsFor(owner, params.page, count) };
    });

    await getContacts();
    await vi.waitFor(() => expect(remoteRequest).toHaveBeenCalledTimes(1));

    // The user switches to Bob while page 1 is still loading.
    Accounts.setActive(BOB.email);
    releaseFirstPage();

    await vi.waitFor(() => {
      const row = metaRows.get(`contacts_v2_${ALICE.email}`);
      expect(row?.value?.length).toBe(PAGE_SIZE + 3);
    });

    const cached = metaRows.get(`contacts_v2_${ALICE.email}`).value;
    expect(cached.filter((c) => c.email.startsWith('bob.'))).toEqual([]);
    expect(metaRows.has(`contacts_v2_${BOB.email}`)).toBe(false);
  });
});
