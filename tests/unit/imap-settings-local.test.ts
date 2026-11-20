/**
 * An account on a custom IMAP server has no Forward Email account to keep
 * its settings and label list, so they live on this device. They used to be
 * sent to the API anyway: the request failed and the change was undone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const h = vi.hoisted(() => ({
  active: 'alice@example.org',
  requests: [] as Array<{ action: string; body: unknown }>,
  settings: new Map<string, unknown>(),
  labels: new Map<string, unknown>(),
}));

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: (key: string) => (key === 'email' ? h.active : null),
    set: vi.fn(),
    remove: vi.fn(),
  },
  Accounts: {
    getAll: () => [
      {
        email: 'alice@example.org',
        kind: 'imap',
        imap: {
          host: 'imap.example.org',
          port: 993,
          security: 'tls',
          username: 'alice@example.org',
          password: 'secret',
        },
      },
      { email: 'bob@example.com', aliasAuth: 'bob@example.com:pw' },
    ],
  },
}));
vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: () => (h.active === 'bob@example.com' ? 'Basic Ym9i' : ''),
  getAuthHeaderForAccount: (email: string) => (email === 'bob@example.com' ? 'Basic Ym9i' : ''),
}));
vi.mock('../../src/utils/remote', () => ({
  Remote: {
    request: vi.fn(async (action: string, body: unknown) => {
      h.requests.push({ action, body });
      return { settings: {} };
    }),
  },
}));
vi.mock('../../src/utils/db', () => {
  const table = (rows: Map<string, unknown>) => ({
    get: vi.fn(async (key: string) => rows.get(String(key)) ?? null),
    put: vi.fn(async (row: { account?: string; key?: string }) => {
      rows.set(String(row.account ?? row.key), row);
    }),
  });
  return {
    db: { settings: table(h.settings), settingsLabels: table(h.labels) },
    handleDatabaseError: vi.fn(async () => {}),
  };
});

import {
  createLabel,
  deleteLabel,
  fetchLabelsWithSource,
  fetchSettings,
  remoteSettings,
  settingsError,
  settingsLabels,
  updateSettings,
} from '../../src/stores/settingsStore';

beforeEach(() => {
  h.active = 'alice@example.org';
  h.requests.length = 0;
  h.settings.clear();
  h.labels.clear();
  settingsLabels.set([]);
  settingsError.set(null);
});

describe('settings for an account on a custom IMAP server', () => {
  it('keeps a changed setting, without asking the API to save it', async () => {
    const saved = await updateSettings({ mail: { undo_send_delay: 10000 } } as never);

    expect(saved).toBe(true);
    expect(h.requests).toEqual([]);
    expect(
      (get(remoteSettings) as { mail: { undo_send_delay?: number } }).mail.undo_send_delay,
    ).toBe(10000);
    expect(get(settingsError)).toBeNull();
    // Written to this device, so it is still there after a restart.
    expect(h.settings.size).toBe(1);
  });

  it('loads without asking the API, and without reporting a failure', async () => {
    await fetchSettings();

    expect(h.requests).toEqual([]);
    expect(get(settingsError)).toBeNull();
  });

  it('creates and deletes a label on this device', async () => {
    const created = await createLabel({ name: 'Clients', color: '#0a0' });
    expect(created).toMatchObject({
      success: true,
      label: { keyword: 'clients', name: 'Clients' },
    });
    expect(get(settingsLabels)).toHaveLength(1);

    const removed = await deleteLabel('clients');
    expect(removed.success).toBe(true);
    expect(get(settingsLabels)).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it('does not show the labels of the account that was on screen before', async () => {
    settingsLabels.set([{ keyword: 'bobs', name: "Bob's label" }] as never);

    const { labels, authoritative } = await fetchLabelsWithSource(true);

    expect(labels).toEqual([]);
    // This device holds the whole list, so it can be trusted as complete.
    expect(authoritative).toBe(true);
  });

  it('still saves a Forward Email account to the API', async () => {
    h.active = 'bob@example.com';

    await updateSettings({ mail: { undo_send_delay: 5000 } } as never);
    await createLabel({ name: 'Work' });

    expect(h.requests.map((r) => r.action)).toEqual(['AccountUpdate', 'AccountUpdate']);
  });
});
