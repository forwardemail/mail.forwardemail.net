import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// Mock navigator.storage before importing the module under test
Object.defineProperty(globalThis, 'navigator', {
  value: {
    ...globalThis.navigator,
    storage: {
      estimate: vi.fn().mockResolvedValue({ usage: 1000, quota: 50_000 }),
    },
  },
  writable: true,
  configurable: true,
});

// Mock the db module to avoid Dexie/IndexedDB issues in jsdom
vi.mock('../../src/utils/db', () => ({
  db: {
    messages: {
      count: vi.fn().mockResolvedValue(0),
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      }),
    },
  },
}));

// Mock Remote to prevent real network calls
vi.mock('../../src/utils/remote', () => ({
  Remote: {
    request: vi.fn().mockResolvedValue({}),
  },
}));

// Mock Local storage
vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn().mockReturnValue('test@example.com'),
    set: vi.fn(),
  },
  Session: { get: vi.fn(), set: vi.fn() },
  Accounts: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

// Track fetchAccountData calls
let mockFetchAccountData = vi.fn().mockResolvedValue({});

// Mock settingsStore with ALL exports that mailboxActions.ts imports
vi.mock('../../src/stores/settingsStore', () => {
  const { writable: w, readable: r } = require('svelte/store');
  const stubReadable = r('default');
  return {
    fetchAccountData: (...args) => mockFetchAccountData(...args),
    syncSettings: vi.fn().mockResolvedValue(undefined),
    clearSettings: vi.fn(),
    settingsActions: {
      setBodyIndexing: vi.fn(),
    },
    remoteSettings: w({}),
    settingsLoading: w(false),
    settingsError: w(null),
    settingsSynced: w(false),
    profileName: w(''),
    profileImage: w(''),
    settingsLabels: w([]),
    localSettingsVersion: w(0),
    theme: stubReadable,
    layoutMode: stubReadable,
    messagesPerPage: r(25),
    archiveFolder: r(null),
    bodyIndexing: r(false),
    prefetchConfig: r({ enabled: false, folders: [], mode: 'headers' }),
    shortcuts: r({}),
    aliasDefaults: r({}),
    rememberPassphrase: r(false),
    attachmentReminder: r(true),
    effectiveTheme: stubReadable,
    effectiveLayoutMode: r('list'),
    effectiveMessagesPerPage: r(25),
    effectiveComposePlainDefault: r(false),
    effectiveArchiveFolder: r('Archive'),
    isSettingOverrideEnabled: vi.fn().mockReturnValue(false),
    setSettingOverrideEnabled: vi.fn(),
    getEffectiveSettingValue: vi.fn(),
    setSettingValue: vi.fn().mockResolvedValue(undefined),
    LocalSettings: {},
    loadProfileName: vi.fn(),
    setProfileName: vi.fn(),
    loadProfileImage: vi.fn(),
    setProfileImage: vi.fn(),
    applySettings: vi.fn((x) => x),
    fetchSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue(true),
    updateSetting: vi.fn().mockResolvedValue(true),
    fetchLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue({}),
    updateLabel: vi.fn().mockResolvedValue({}),
    deleteLabel: vi.fn().mockResolvedValue({}),
    settingsStore: {},
    SETTING_SCOPES: {},
    getSettingDefinition: vi.fn(),
  };
});

// Mock mailboxStore
vi.mock('../../src/stores/mailboxStore', () => {
  const { writable: w } = require('svelte/store');
  return {
    mailboxStore: {
      state: {
        folders: w([]),
        messages: w([]),
        loading: w(false),
        error: w(null),
        selectedFolder: w(null),
        selectedMessage: w(null),
        query: w(''),
        unreadOnly: w(false),
        hasAttachmentsOnly: w(false),
        starredOnly: w(false),
        filterByLabel: w([]),
      },
      actions: {
        loadFolders: vi.fn().mockResolvedValue(undefined),
        loadMessages: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

// Mock searchStore
vi.mock('../../src/stores/searchStore', () => ({
  searchStore: {
    actions: {
      setIncludeBody: vi.fn().mockResolvedValue(undefined),
      rebuildFromCache: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

// Now import the stores and function under test
import { updateStorageStats, storageUsed, storageTotal } from '../../src/stores/mailboxActions.ts';

describe('updateStorageStats', () => {
  beforeEach(() => {
    // Reset stores to 0 before each test
    storageUsed.set(0);
    storageTotal.set(0);
    // Reset the mock function (but don't restore module-level mocks)
    mockFetchAccountData = vi.fn().mockResolvedValue({});
  });

  it('reads storage_quota and storage_used from API response', async () => {
    mockFetchAccountData = vi.fn().mockResolvedValue({
      storage_used: 15_728_640,
      storage_quota: 10_737_418_240,
    });

    await updateStorageStats('test@example.com');

    expect(get(storageUsed)).toBe(15_728_640);
    expect(get(storageTotal)).toBe(10_737_418_240);
  });

  it('reads max_quota_per_alias when storage_quota is absent', async () => {
    mockFetchAccountData = vi.fn().mockResolvedValue({
      storage_used: 5_000_000,
      max_quota_per_alias: 5_368_709_120,
    });

    await updateStorageStats('test@example.com');

    expect(get(storageUsed)).toBe(5_000_000);
    expect(get(storageTotal)).toBe(5_368_709_120);
  });

  it('reads max_quota when higher-priority fields are absent', async () => {
    mockFetchAccountData = vi.fn().mockResolvedValue({
      storage_used: 1_000_000,
      max_quota: 2_147_483_648,
    });

    await updateStorageStats('test@example.com');

    expect(get(storageUsed)).toBe(1_000_000);
    expect(get(storageTotal)).toBe(2_147_483_648);
  });

  it('reads storage_used_by_aliases when storage_used is absent', async () => {
    mockFetchAccountData = vi.fn().mockResolvedValue({
      storage_used_by_aliases: 42_000,
      storage_quota: 10_737_418_240,
    });

    await updateStorageStats('test@example.com');

    expect(get(storageUsed)).toBe(42_000);
    expect(get(storageTotal)).toBe(10_737_418_240);
  });

  it('does not update stores when total is 0 (no quota fields)', async () => {
    storageUsed.set(999);
    storageTotal.set(888);

    mockFetchAccountData = vi.fn().mockResolvedValue({
      email: 'test@example.com',
      plan: 'free',
    });

    await updateStorageStats('test@example.com');

    // Stores should remain unchanged because total was 0
    expect(get(storageUsed)).toBe(999);
    expect(get(storageTotal)).toBe(888);
  });

  it('does not crash when fetchAccountData throws', async () => {
    mockFetchAccountData = vi.fn().mockRejectedValue(new Error('Network error'));

    // Should not throw
    await updateStorageStats('test@example.com');

    expect(get(storageUsed)).toBe(0);
    expect(get(storageTotal)).toBe(0);
  });

  it('passes force option through to fetchAccountData', async () => {
    mockFetchAccountData = vi.fn().mockResolvedValue({
      storage_used: 100,
      storage_quota: 200,
    });

    await updateStorageStats('test@example.com', { force: true });

    expect(mockFetchAccountData).toHaveBeenCalledWith({ force: true });
    expect(get(storageTotal)).toBe(200);
  });

  it('defaults force to false when not specified', async () => {
    mockFetchAccountData = vi.fn().mockResolvedValue({
      storage_used: 100,
      storage_quota: 200,
    });

    await updateStorageStats('test@example.com');

    expect(mockFetchAccountData).toHaveBeenCalledWith({ force: false });
  });

  it('handles storage_used of 0 correctly (new/empty account)', async () => {
    mockFetchAccountData = vi.fn().mockResolvedValue({
      storage_used: 0,
      storage_quota: 10_737_418_240,
    });

    await updateStorageStats('test@example.com');

    // storage_used should be 0 (valid), total should be set
    expect(get(storageUsed)).toBe(0);
    expect(get(storageTotal)).toBe(10_737_418_240);
  });

  it('prefers storage_quota over max_quota_per_alias when both present', async () => {
    mockFetchAccountData = vi.fn().mockResolvedValue({
      storage_used: 100,
      storage_quota: 1_000_000,
      max_quota_per_alias: 2_000_000,
    });

    await updateStorageStats('test@example.com');

    // storage_quota should take precedence
    expect(get(storageTotal)).toBe(1_000_000);
  });
});
