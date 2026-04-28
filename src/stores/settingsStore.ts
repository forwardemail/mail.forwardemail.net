import { writable, get, derived } from 'svelte/store';
import type { Writable, Readable } from 'svelte/store';
import { Remote } from '../utils/remote';
import { Local } from '../utils/storage';
import { db, handleDatabaseError } from '../utils/db';
import { validateLabelName } from '../utils/label-validation.ts';
import {
  SETTING_SCOPES,
  getSettingDefinition,
  normalizeLayoutMode,
  resolveLocalKey,
  resolveOverrideKey,
  parseLocalValue,
  serializeLocalValue,
  normalizeRemoteValue,
} from './settingsRegistry';
import type { SettingDefinition } from './settingsRegistry';
import type { Label, PgpKey } from '../types';
import { warn } from '../utils/logger.ts';
import { getAuthHeader } from '../utils/auth';

export interface RemoteSettings {
  mail: {
    archive_folder: string | null;
    sent_folder: string | null;
    drafts_folder: string | null;
  };
  labels: Label[];
  aliases: {
    defaults: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface SyncSettings {
  pageSize: number;
  maxHeaders: number;
  scope: string;
  bodyLimit: number;
}

export interface LabelCreateInput {
  keyword?: string;
  name?: string;
  color?: string;
  hidden?: boolean;
  source?: string;
}

export interface LabelResult {
  success: boolean;
  error?: string;
  status?: number;
  label?: Label;
}

interface SettingsContext {
  account?: string;
  remote?: RemoteSettings;
}

interface OverrideOptions {
  account?: string;
  value?: unknown;
}

// Default remote settings (API-backed, account-scoped)
const DEFAULT_REMOTE_SETTINGS: RemoteSettings = {
  mail: {
    archive_folder: null,
    sent_folder: null,
    drafts_folder: null,
  },
  labels: [],
  aliases: {
    defaults: {},
  },
};

const ACCOUNT_CACHE_TTL = 15000;

interface AccountCacheEntry {
  promise: Promise<unknown> | null;
  fetchAt: number;
  result: unknown;
}

const accountFetchCache = new Map<string, AccountCacheEntry>();

export async function fetchAccountData({ force = false } = {}): Promise<unknown> {
  // Bail early if no credentials are available (e.g. on the login page).
  // Settings.svelte is always mounted and its onMount calls fetchSettings()
  // which calls this function — without this guard it would make an API call
  // with no auth header and produce console errors.
  if (!getAuthHeader({ allowApiKey: true })) {
    throw new Error('No credentials available');
  }

  const account = Local.get('email') || 'default';
  const now = Date.now();
  const entry = accountFetchCache.get(account);

  if (!force && entry?.result) {
    if (now - entry.fetchAt < ACCOUNT_CACHE_TTL) {
      return entry.result;
    }
  }
  if (entry?.promise) {
    return entry.promise;
  }

  const promise = Remote.request('Account', {});
  accountFetchCache.set(account, { promise, fetchAt: 0, result: entry?.result ?? null });
  try {
    const result = await promise;
    accountFetchCache.set(account, { promise: null, fetchAt: Date.now(), result });
    return result;
  } catch (err) {
    // On failure, clear the promise but preserve any previous cached result
    if (accountFetchCache.get(account)?.promise === promise) {
      accountFetchCache.set(account, {
        promise: null,
        fetchAt: entry?.fetchAt ?? 0,
        result: entry?.result ?? null,
      });
    }
    throw err;
  }
}

interface LabelSettingValue {
  name?: string;
  color?: string;
  hidden?: boolean;
  source?: string;
}

/**
 * Convert API label_settings map into an array of labels with keyword
 */
function mapLabelSettingsToArray(labelSettings: Record<string, LabelSettingValue> = {}): Label[] {
  if (!labelSettings || typeof labelSettings !== 'object') return [];
  return Object.entries(labelSettings).map(([keyword, value = {}]) => ({
    keyword,
    name: value.name || keyword,
    color: value.color,
    hidden: Boolean(value.hidden),
    source: value.source || 'custom',
  }));
}

/**
 * Convert label array into API label_settings map
 */
function labelsArrayToMap(labels: Label[] = []): Record<string, LabelSettingValue> {
  const map: Record<string, LabelSettingValue> = {};
  (labels || []).forEach((label) => {
    if (!label?.keyword) return;
    map[label.keyword] = {
      name: label.name || label.keyword,
      color: label.color,
      hidden: Boolean(label.hidden),
      source: label.source || 'custom',
    };
  });
  return map;
}

interface AccountResponse {
  settings?: {
    mail?: {
      archive_folder?: string | null;
      sent_folder?: string | null;
      drafts_folder?: string | null;
    };
    aliases?: {
      defaults?: Record<string, unknown>;
    };
    labels?: Label[];
    label_settings?: Record<string, LabelSettingValue>;
  };
  label_settings?: Record<string, LabelSettingValue>;
  mail_archive_folder?: string | null;
  mail_sent_folder?: string | null;
  mail_drafts_folder?: string | null;
}

/**
 * Extract settings fields from /v1/account response.
 * Supports both legacy nested `settings` and new flat alias fields.
 */
function extractSettingsFromAccount(response: AccountResponse = {}): RemoteSettings {
  const settings = response.settings || {};
  const mail = settings.mail || {};
  const aliases = settings.aliases || {};
  const labelMap = settings.label_settings || response.label_settings;
  const labels = Array.isArray(settings.labels)
    ? settings.labels
    : mapLabelSettingsToArray(labelMap);

  return {
    mail: {
      archive_folder: mail.archive_folder ?? response.mail_archive_folder ?? null,
      sent_folder: mail.sent_folder ?? response.mail_sent_folder ?? null,
      drafts_folder: mail.drafts_folder ?? response.mail_drafts_folder ?? null,
    },
    labels,
    aliases: {
      defaults: aliases.defaults ?? DEFAULT_REMOTE_SETTINGS.aliases.defaults,
    },
  };
}

interface SettingsChanges {
  mail?: {
    archive_folder?: string | null;
    sent_folder?: string | null;
    drafts_folder?: string | null;
  };
  labels?: Label[];
  aliases?: {
    defaults?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

/**
 * Convert internal settings shape into the flat API payload expected by /v1/account
 */
function buildAccountUpdatePayload(changes: SettingsChanges = {}): {
  settings?: Record<string, unknown>;
} {
  const payload: { settings: Record<string, unknown> } = { settings: {} };

  if (changes.mail) {
    const mail: Record<string, unknown> = {};
    if (changes.mail.archive_folder !== undefined) {
      mail.archive_folder = changes.mail.archive_folder;
    }
    if (changes.mail.sent_folder !== undefined) {
      mail.sent_folder = changes.mail.sent_folder;
    }
    if (changes.mail.drafts_folder !== undefined) {
      mail.drafts_folder = changes.mail.drafts_folder;
    }
    if (Object.keys(mail).length) {
      payload.settings.mail = mail;
    }
  }

  if (changes.labels !== undefined) {
    payload.settings.label_settings = labelsArrayToMap(changes.labels);
  }

  if (changes.aliases?.defaults !== undefined) {
    payload.settings.aliases = {
      defaults: changes.aliases.defaults,
    };
  }

  return Object.keys(payload.settings).length ? payload : {};
}

// Remote settings store (per-alias, synced with API)
export const remoteSettings: Writable<RemoteSettings> = writable(
  structuredClone(DEFAULT_REMOTE_SETTINGS),
);

// Settings loading state
export const settingsLoading: Writable<boolean> = writable(false);
export const settingsError: Writable<string | null> = writable(null);
export const settingsSynced: Writable<boolean> = writable(false);
const profileNameKey = (account?: string): string =>
  `profile_name_${(account || Local.get('email') || 'default').toLowerCase()}`;
const profileImageKey = (account?: string): string =>
  `profile_image_${(account || Local.get('email') || 'default').toLowerCase()}`;
export const profileName: Writable<string> = writable(Local.get(profileNameKey()) || '');
export const profileImage: Writable<string> = writable(Local.get(profileImageKey()) || '');

// Labels store (from settings.labels in /v1/account response)
export const settingsLabels: Writable<Label[]> = writable([]);

export const localSettingsVersion: Writable<number> = writable(0);
const bumpLocalSettingsVersion = (): void => {
  localSettingsVersion.update((n) => n + 1);
};
const getRememberPassphraseLocal = (): boolean => Local.get('remember_passphrase_local') === 'true';

// Derived stores for convenience
export const theme: Readable<unknown> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => getEffectiveSettingValue('theme', { remote: $remote }),
);
export const layoutMode: Readable<unknown> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => getEffectiveSettingValue('layout_mode', { remote: $remote }),
);
export const messagesPerPage: Readable<unknown> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => getEffectiveSettingValue('messages_per_page', { remote: $remote }),
);
export const archiveFolder: Readable<string | null> = derived(
  remoteSettings,
  ($s) => $s.mail?.archive_folder || null,
);
export const bodyIndexing: Readable<boolean> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => Boolean(getEffectiveSettingValue('search_body_indexing', { remote: $remote })),
);
export const prefetchConfig: Readable<{ enabled: boolean; folders: string[]; mode: string }> =
  derived([remoteSettings, localSettingsVersion], ([$remote]) => ({
    enabled: Boolean(getEffectiveSettingValue('prefetch_enabled', { remote: $remote })),
    folders: (getEffectiveSettingValue('prefetch_folders', { remote: $remote }) as string[]) || [],
    mode: 'recent',
  }));
export const shortcuts: Readable<Record<string, string>> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) =>
    (getEffectiveSettingValue('keyboard_shortcuts', { remote: $remote }) as Record<
      string,
      string
    >) || {},
);
export const aliasDefaults: Readable<Record<string, unknown>> = derived(
  remoteSettings,
  ($s) => $s.aliases?.defaults || {},
);
export const rememberPassphrase: Readable<boolean> = derived(localSettingsVersion, () =>
  getRememberPassphraseLocal(),
);
export const attachmentReminder: Readable<boolean> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => Boolean(getEffectiveSettingValue('attachment_reminder', { remote: $remote })),
);
export const hideCompletedTodos: Readable<boolean> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => Boolean(getEffectiveSettingValue('hide_completed_todos', { remote: $remote })),
);
export type TasksSortKey = 'due' | 'title' | 'created';
const VALID_TASKS_SORT: TasksSortKey[] = ['due', 'title', 'created'];
const normalizeTasksSort = (raw: unknown): TasksSortKey => {
  const value = String(raw || '').toLowerCase() as TasksSortKey;
  return VALID_TASKS_SORT.includes(value) ? value : 'due';
};
export const tasksSort: Readable<TasksSortKey> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => normalizeTasksSort(getEffectiveSettingValue('tasks_sort', { remote: $remote })),
);

const getAccountKey = (account?: string): string => account || Local.get('email') || 'default';

const parseOverrideValue = (raw: unknown, fallback = false): boolean => {
  if (raw === null || raw === undefined) return fallback;
  const normalized = String(raw).toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
};

const getLocalSettingValue = (def: SettingDefinition | null, account?: string): unknown => {
  if (!def) return undefined;
  const key = resolveLocalKey(def, account);
  if (!key) return def.defaultValue;
  const raw = Local.get(key);
  if (raw === null || raw === undefined) return def.defaultValue;
  return parseLocalValue(def, raw);
};

const setLocalSettingValue = (
  def: SettingDefinition | null,
  value: unknown,
  account?: string,
): boolean => {
  if (!def) return false;
  const key = resolveLocalKey(def, account);
  if (!key) return false;
  const serialized = serializeLocalValue(def, value);
  if (serialized === null || serialized === undefined) {
    Local.remove(key);
  } else {
    Local.set(key, serialized);
  }
  bumpLocalSettingsVersion();
  return true;
};

const getRemoteSettingValue = (def: SettingDefinition | null, remote?: RemoteSettings): unknown => {
  if (!def?.remotePath) return def?.defaultValue;
  const base = remote || get(remoteSettings);
  const raw = def.remotePath.reduce(
    (acc: unknown, key: string) =>
      acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined,
    base as unknown,
  );
  return normalizeRemoteValue(def, raw);
};

export const isSettingOverrideEnabled = (id: string, account?: string): boolean => {
  const def = getSettingDefinition(id);
  if (!def || def.scope !== SETTING_SCOPES.HYBRID) return false;
  const acct = getAccountKey(account);
  const key = resolveOverrideKey(def, acct);
  if (!key) return Boolean(def.defaultOverride);
  const stored = Local.get(key);
  return parseOverrideValue(stored, Boolean(def.defaultOverride));
};

export const setSettingOverrideEnabled = (
  id: string,
  enabled: boolean,
  { account, value }: OverrideOptions = {},
): boolean => {
  const def = getSettingDefinition(id);
  if (!def || def.scope !== SETTING_SCOPES.HYBRID) return false;
  const acct = getAccountKey(account);
  const key = resolveOverrideKey(def, acct);
  if (!key) return false;
  Local.set(key, enabled ? 'true' : 'false');
  if (enabled && value !== undefined) {
    setLocalSettingValue(def, value, acct);
    return true;
  }
  bumpLocalSettingsVersion();
  return true;
};

export const getEffectiveSettingValue = (
  id: string,
  { account, remote }: SettingsContext = {},
): unknown => {
  const def = getSettingDefinition(id);
  if (!def) return undefined;
  const acct = getAccountKey(account);
  if (def.scope === SETTING_SCOPES.DEVICE) {
    return getLocalSettingValue(def, acct);
  }
  if (def.scope === SETTING_SCOPES.ACCOUNT) {
    const remoteValue = getRemoteSettingValue(def, remote);
    if (def.localFallbackOnDefault && def.localKey) {
      const localValue = getLocalSettingValue(def, acct);
      if (localValue !== def.defaultValue && remoteValue === def.defaultValue) {
        return localValue;
      }
    }
    return remoteValue;
  }
  if (def.scope === SETTING_SCOPES.HYBRID) {
    if (isSettingOverrideEnabled(id, acct)) {
      return getLocalSettingValue(def, acct);
    }
    return getRemoteSettingValue(def, remote);
  }
  return def.defaultValue;
};

const buildRemoteSettingChange = (
  def: SettingDefinition,
  value: unknown,
): Record<string, unknown> => {
  if (!def?.remotePath?.length) return {};
  return def.remotePath.reduceRight(
    (acc: unknown, key: string) => ({ [key]: acc }),
    value,
  ) as Record<string, unknown>;
};

export const setSettingValue = async (
  id: string,
  value: unknown,
  { account }: { account?: string } = {},
): Promise<boolean> => {
  const def = getSettingDefinition(id);
  if (!def) return false;
  const acct = getAccountKey(account);
  const nextValue = def.normalizeRemote ? def.normalizeRemote(value) : value;
  if (def.scope === SETTING_SCOPES.DEVICE) {
    return setLocalSettingValue(def, nextValue, acct);
  }
  if (def.scope === SETTING_SCOPES.ACCOUNT) {
    if (def.localKey) {
      setLocalSettingValue(def, nextValue, acct);
    }
    return updateSettings(buildRemoteSettingChange(def, nextValue) as SettingsChanges);
  }
  if (def.scope === SETTING_SCOPES.HYBRID) {
    if (isSettingOverrideEnabled(id, acct)) {
      return setLocalSettingValue(def, nextValue, acct);
    }
    return updateSettings(buildRemoteSettingChange(def, nextValue) as SettingsChanges);
  }
  return false;
};

export const effectiveTheme: Readable<unknown> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => getEffectiveSettingValue('theme', { remote: $remote }),
);
export const effectiveLayoutMode: Readable<unknown> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => getEffectiveSettingValue('layout_mode', { remote: $remote }),
);
export const effectiveMessagesPerPage: Readable<unknown> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => getEffectiveSettingValue('messages_per_page', { remote: $remote }),
);
export const effectiveComposePlainDefault: Readable<boolean> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => Boolean(getEffectiveSettingValue('compose_plain_default', { remote: $remote })),
);
export const effectiveArchiveFolder: Readable<string> = derived(
  [remoteSettings, localSettingsVersion],
  ([$remote]) => (getEffectiveSettingValue('archive_folder', { remote: $remote }) as string) || '',
);

/**
 * Local-only settings helpers
 * These are device-specific and never synced to the server
 */
export const LocalSettings = {
  // PGP keys stored locally (account-scoped)
  getPgpKeys(): PgpKey[] {
    try {
      const currentAcct = Local.get('email') || 'default';
      const data = Local.get(`pgp_keys_${currentAcct}`);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  setPgpKeys(keys: PgpKey[]): void {
    const currentAcct = Local.get('email') || 'default';
    Local.set(`pgp_keys_${currentAcct}`, JSON.stringify(keys || []));
  },

  addPgpKey(key: PgpKey): void {
    const keys = this.getPgpKeys();
    keys.push(key);
    this.setPgpKeys(keys);
  },

  removePgpKey(keyName: string): void {
    const keys = this.getPgpKeys().filter((k) => k.name !== keyName);
    this.setPgpKeys(keys);
  },

  // PGP passphrases (device-local, account-scoped)
  getPgpPassphrases(): Record<string, string> {
    try {
      const currentAcct = Local.get('email') || 'default';
      const data = Local.get(`pgp_passphrases_${currentAcct}`);
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  },

  setPgpPassphrase(keyId: string, passphrase: string): void {
    const currentAcct = Local.get('email') || 'default';
    const passphrases = this.getPgpPassphrases();
    passphrases[keyId] = passphrase;
    Local.set(`pgp_passphrases_${currentAcct}`, JSON.stringify(passphrases));
  },

  removePgpPassphrase(keyId: string): void {
    const currentAcct = Local.get('email') || 'default';
    const passphrases = this.getPgpPassphrases();
    delete passphrases[keyId];
    Local.set(`pgp_passphrases_${currentAcct}`, JSON.stringify(passphrases));
  },

  // Device-specific remember passphrase
  getRememberPassphraseLocal(): boolean {
    return getRememberPassphraseLocal();
  },

  setRememberPassphraseLocal(value: boolean): void {
    Local.set('remember_passphrase_local', value ? 'true' : 'false');
    bumpLocalSettingsVersion();
  },

  // Cache prefetch enabled (device-specific)
  getCachePrefetchEnabled(): boolean {
    return Local.get('cache_prefetch_enabled') !== 'false';
  },

  setCachePrefetchEnabled(value: boolean): void {
    Local.set('cache_prefetch_enabled', value ? 'true' : 'false');
  },

  // Sync settings (device-specific)
  getSyncSettings(): SyncSettings {
    return {
      pageSize: parseInt(Local.get('sync_page_size') || '15', 10),
      maxHeaders: parseInt(Local.get('sync_max_headers') || '300', 10),
      scope: Local.get('sync_scope') || 'core',
      bodyLimit: parseInt(Local.get('sync_body_limit') || '50', 10),
    };
  },

  setSyncSettings(settings: Partial<SyncSettings>): void {
    if (settings.pageSize !== undefined) Local.set('sync_page_size', String(settings.pageSize));
    if (settings.maxHeaders !== undefined)
      Local.set('sync_max_headers', String(settings.maxHeaders));
    if (settings.scope !== undefined) Local.set('sync_scope', settings.scope);
    if (settings.bodyLimit !== undefined) Local.set('sync_body_limit', String(settings.bodyLimit));
  },
};

export const loadProfileName = (account?: string): void => {
  profileName.set(Local.get(profileNameKey(account)) || '');
};

export const setProfileName = (value: string | null, account?: string): void => {
  const next = value == null ? '' : String(value);
  Local.set(profileNameKey(account), next);
  profileName.set(next);
};

export const loadProfileImage = (account?: string): void => {
  profileImage.set(Local.get(profileImageKey(account)) || '');
};

export const setProfileImage = (value: string | null, account?: string): void => {
  const key = profileImageKey(account);
  const next = value || '';
  if (!next) {
    Local.remove(key);
    profileImage.set('');
    return;
  }
  Local.set(key, next);
  profileImage.set(next);
};

/**
 * Cache settings in IndexedDB for offline access
 */
async function cacheSettings(account: string, settings: RemoteSettings): Promise<void> {
  try {
    await db.settings.put({
      account,
      settings,
      updatedAt: Date.now(),
    });
  } catch (err) {
    warn('[settingsStore] Failed to cache settings:', err);
    // Attempt recovery if this is a database worker error
    const recovery = await handleDatabaseError(err);
    if (recovery.recovered) {
      // Retry the operation after recovery
      try {
        await db.settings.put({
          account,
          settings,
          updatedAt: Date.now(),
        });
      } catch (retryErr) {
        warn('[settingsStore] Retry after recovery failed:', retryErr);
      }
    }
  }
}

/**
 * Load cached settings from IndexedDB
 */
async function loadCachedSettings(account: string): Promise<RemoteSettings | null> {
  try {
    const cached = await db.settings.get(account);
    return cached?.settings || null;
  } catch (err) {
    warn('[settingsStore] Failed to load cached settings:', err);
    // Attempt recovery if this is a database worker error
    await handleDatabaseError(err);
    return null;
  }
}

/**
 * Cache labels in IndexedDB
 */
async function cacheLabels(account: string, labels: Label[]): Promise<void> {
  try {
    await db.settingsLabels.put({
      account,
      labels,
      updatedAt: Date.now(),
    });
  } catch (err) {
    warn('[settingsStore] Failed to cache labels:', err);
    // Attempt recovery if this is a database worker error
    const recovery = await handleDatabaseError(err);
    if (recovery.recovered) {
      // Retry the operation after recovery
      try {
        await db.settingsLabels.put({
          account,
          labels,
          updatedAt: Date.now(),
        });
      } catch (retryErr) {
        warn('[settingsStore] Retry after recovery failed:', retryErr);
      }
    }
  }
}

/**
 * Load cached labels from IndexedDB
 */
async function loadCachedLabels(account: string): Promise<Label[]> {
  try {
    const cached = await db.settingsLabels.get(account);
    return cached?.labels || [];
  } catch (err) {
    warn('[settingsStore] Failed to load cached labels:', err);
    // Attempt recovery if this is a database worker error
    await handleDatabaseError(err);
    return [];
  }
}

/**
 * Apply API response to settings store
 * Merges response with defaults to ensure all fields exist
 */
export function applySettings(response: RemoteSettings): RemoteSettings {
  const merged: RemoteSettings = {
    mail: { ...DEFAULT_REMOTE_SETTINGS.mail, ...response.mail },
    labels: response.labels || DEFAULT_REMOTE_SETTINGS.labels,
    aliases: { ...DEFAULT_REMOTE_SETTINGS.aliases, ...response.aliases },
  };
  remoteSettings.set(merged);
  return merged;
}

/**
 * Fetch settings from the API via /v1/account endpoint
 * Settings are embedded in the account response under the 'settings' property
 */
export async function fetchSettings(): Promise<RemoteSettings> {
  const account = Local.get('email') || 'default';

  settingsLoading.set(true);
  settingsError.set(null);

  try {
    // Load cached settings first for immediate UI hydration
    const cached = await loadCachedSettings(account);
    if (cached) {
      applySettings(cached);
    }

    // Load cached labels
    const cachedLabels = await loadCachedLabels(account);
    if (cachedLabels.length) {
      settingsLabels.set(cachedLabels);
    }

    // Fetch account data which includes settings
    const response = await fetchAccountData();

    const settingsData = extractSettingsFromAccount(response as AccountResponse);
    const merged = applySettings(settingsData);
    await cacheSettings(account, merged);

    // Also cache labels from settings (converted to array)
    if (Array.isArray(merged.labels)) {
      settingsLabels.set(merged.labels);
      await cacheLabels(account, merged.labels);
    }

    settingsSynced.set(true);

    return get(remoteSettings);
  } catch (err: unknown) {
    // Suppress warning for expected no-credentials case (login page)
    const errMsg = err instanceof Error ? err.message : '';
    if (!errMsg.includes('No credentials available')) {
      warn('[settingsStore] Failed to fetch settings:', err);
    }
    const message = err instanceof Error ? err.message : 'Failed to fetch settings';
    settingsError.set(message);

    // Use cached settings if API fails
    const cached = await loadCachedSettings(account);
    if (cached) {
      applySettings(cached);
    }

    return get(remoteSettings);
  } finally {
    settingsLoading.set(false);
  }
}

/**
 * Update settings on the server via PUT /v1/account
 * Settings can be sent directly at the top level of the request body
 */
export async function updateSettings(changes: SettingsChanges): Promise<boolean> {
  const account = Local.get('email') || 'default';
  const previousSettings = structuredClone(get(remoteSettings));
  const previousLabels = get(settingsLabels);

  // Optimistic update - apply changes to local store
  remoteSettings.update((current) => {
    const updated = structuredClone(current);
    for (const [section, values] of Object.entries(changes)) {
      if (typeof values === 'object' && values !== null && !Array.isArray(values)) {
        (updated as Record<string, unknown>)[section] = {
          ...((updated as Record<string, unknown>)[section] as object),
          ...values,
        };
      } else {
        (updated as Record<string, unknown>)[section] = values;
      }
    }
    return updated;
  });

  if (changes.labels) {
    settingsLabels.set(changes.labels);
  }

  try {
    // Convert to API payload (nested settings + label_settings map)
    const payload = buildAccountUpdatePayload(changes);
    await Remote.request('AccountUpdate', payload, { method: 'PUT' });
    await cacheSettings(account, get(remoteSettings));
    if (changes.labels) {
      await cacheLabels(account, get(settingsLabels));
    }
    return true;
  } catch (err: unknown) {
    warn('[settingsStore] Failed to update settings:', err);
    // Revert on error
    remoteSettings.set(previousSettings);
    if (changes.labels) {
      settingsLabels.set(previousLabels);
    }
    const message = err instanceof Error ? err.message : 'Failed to update settings';
    settingsError.set(message);
    return false;
  }
}

/**
 * Update a specific setting value
 */
export async function updateSetting(
  section: string,
  key: string,
  value: unknown,
): Promise<boolean> {
  return updateSettings({
    [section]: {
      [key]: value,
    },
  });
}

/**
 * Convenience methods for common settings
 */
export const settingsActions = {
  async setTheme(theme: string): Promise<boolean> {
    return setSettingValue('theme', theme);
  },

  async setLayoutMode(mode: string): Promise<boolean> {
    const normalized = normalizeLayoutMode(mode);
    return setSettingValue('layout_mode', normalized);
  },

  async setMessagesPerPage(count: number): Promise<boolean> {
    return setSettingValue('messages_per_page', count);
  },

  async setArchiveFolder(folder: string): Promise<boolean> {
    return setSettingValue('archive_folder', folder);
  },

  async setBodyIndexing(enabled: boolean): Promise<boolean> {
    return setSettingValue('search_body_indexing', enabled);
  },

  async setPrefetch(config: { enabled?: boolean; folders?: string[] } = {}): Promise<boolean> {
    const results: boolean[] = [];
    if (config.enabled !== undefined) {
      results.push(await setSettingValue('prefetch_enabled', config.enabled));
    }
    if (config.folders !== undefined) {
      results.push(await setSettingValue('prefetch_folders', config.folders));
    }
    return results.every(Boolean);
  },

  async setShortcuts(shortcuts: Record<string, string>): Promise<boolean> {
    return setSettingValue('keyboard_shortcuts', shortcuts);
  },

  async setShortcut(action: string, key: string): Promise<boolean> {
    const current =
      (getEffectiveSettingValue('keyboard_shortcuts') as Record<string, string>) || {};
    return setSettingValue('keyboard_shortcuts', { ...current, [action]: key });
  },

  async setAliasDefaults(defaults: Record<string, unknown>): Promise<boolean> {
    return updateSettings({
      aliases: { defaults },
    });
  },

  async setRememberPassphrase(enabled: boolean): Promise<boolean> {
    LocalSettings.setRememberPassphraseLocal(Boolean(enabled));
    return true;
  },

  async setAttachmentReminder(enabled: boolean): Promise<boolean> {
    return setSettingValue('attachment_reminder', enabled);
  },
};

/**
 * Fetch labels from /v1/account (labels are part of settings)
 */
export async function fetchLabels(includeHidden = false, { force = false } = {}): Promise<Label[]> {
  const account = Local.get('email') || 'default';

  try {
    // Load cached labels first
    const cached = await loadCachedLabels(account);
    if (cached.length) {
      settingsLabels.set(cached);
    }

    // Fetch account data which includes settings.labels
    const response = await fetchAccountData({ force });

    const settingsData = extractSettingsFromAccount(response as AccountResponse);
    const labelArray = Array.isArray(settingsData.labels) ? settingsData.labels : [];
    let labels = labelArray;
    // Filter hidden labels client-side if requested
    if (!includeHidden) {
      labels = labels.filter((l) => !l.hidden);
    }
    settingsLabels.set(labels);
    await cacheLabels(account, labelArray); // Cache all labels

    return get(settingsLabels);
  } catch (err) {
    // Suppress warning for expected no-credentials case (login page)
    const errMsg = err instanceof Error ? err.message : '';
    if (!errMsg.includes('No credentials available')) {
      warn('[settingsStore] Failed to fetch labels:', err);
    }
    // Keep using cached labels
    return get(settingsLabels);
  }
}

/**
 * Create a new label via PUT /v1/account
 */
export async function createLabel(label: LabelCreateInput): Promise<LabelResult> {
  const account = Local.get('email') || 'default';
  const keyword = (label?.keyword || '').trim();
  const name = (label?.name || '').trim();
  const keywordCheck = validateLabelName(keyword || name);
  if (!keywordCheck.ok) {
    return { success: false, error: keywordCheck.error, status: 400 };
  }
  const nameCheck = validateLabelName(name || keyword);
  if (!nameCheck.ok) {
    return { success: false, error: nameCheck.error, status: 400 };
  }

  try {
    // Get current labels and add the new one
    const currentLabels = get(settingsLabels) || [];

    // Check if label with same keyword already exists
    if (currentLabels.some((l) => l.keyword === label.keyword)) {
      return {
        success: false,
        error: 'A label with this keyword already exists',
        status: 409,
      };
    }

    const newLabel: Label = {
      keyword: keyword || keywordCheck.value,
      name: name || nameCheck.value,
      color: label.color,
      hidden: label.hidden || false,
      source: label.source || 'custom',
    };

    const updatedLabels = [...currentLabels, newLabel];

    // Optimistic update
    settingsLabels.set(updatedLabels);

    // Send updated labels array to API
    await Remote.request(
      'AccountUpdate',
      { settings: { label_settings: labelsArrayToMap(updatedLabels) } },
      { method: 'PUT' },
    );

    // Keep remoteSettings.labels in sync for consumers that rely on it
    remoteSettings.update((current) => ({ ...current, labels: updatedLabels }));

    // Update cache
    await cacheLabels(account, updatedLabels);

    return { success: true, label: newLabel };
  } catch (err: unknown) {
    warn('[settingsStore] Failed to create label:', err);
    // Revert optimistic update
    await fetchLabels();
    const error = err instanceof Error ? err.message : 'Failed to create label';
    const status = (err as { status?: number })?.status;
    return {
      success: false,
      error,
      status,
    };
  }
}

/**
 * Update an existing label via PUT /v1/account
 */
export async function updateLabel(keyword: string, updates: Partial<Label>): Promise<LabelResult> {
  const account = Local.get('email') || 'default';

  try {
    const currentLabels = get(settingsLabels) || [];
    const labelIndex = currentLabels.findIndex((l) => l.keyword === keyword);

    if (labelIndex === -1) {
      return {
        success: false,
        error: 'Label not found',
        status: 404,
      };
    }

    // Create updated labels array
    const updatedLabels = currentLabels.map((l, i) =>
      i === labelIndex ? { ...l, ...updates } : l,
    );

    // Optimistic update
    settingsLabels.set(updatedLabels);

    // Send updated labels array to API
    await Remote.request(
      'AccountUpdate',
      { settings: { label_settings: labelsArrayToMap(updatedLabels) } },
      { method: 'PUT' },
    );

    remoteSettings.update((current) => ({ ...current, labels: updatedLabels }));

    // Update cache
    await cacheLabels(account, updatedLabels);

    return { success: true };
  } catch (err: unknown) {
    warn('[settingsStore] Failed to update label:', err);
    // Revert optimistic update
    await fetchLabels();
    const error = err instanceof Error ? err.message : 'Failed to update label';
    const status = (err as { status?: number })?.status;
    return {
      success: false,
      error,
      status,
    };
  }
}

/**
 * Delete a label via PUT /v1/account
 */
export async function deleteLabel(keyword: string): Promise<LabelResult> {
  const account = Local.get('email') || 'default';
  const previousLabels = get(settingsLabels) || [];

  try {
    // Remove label from array
    const updatedLabels = previousLabels.filter((l) => l.keyword !== keyword);

    if (updatedLabels.length === previousLabels.length) {
      return {
        success: false,
        error: 'Label not found',
        status: 404,
      };
    }

    // Optimistic update
    settingsLabels.set(updatedLabels);

    // Send updated labels array to API
    await Remote.request(
      'AccountUpdate',
      { settings: { label_settings: labelsArrayToMap(updatedLabels) } },
      { method: 'PUT' },
    );

    remoteSettings.update((current) => ({ ...current, labels: updatedLabels }));

    // Update cache
    await cacheLabels(account, updatedLabels);

    return { success: true };
  } catch (err: unknown) {
    warn('[settingsStore] Failed to delete label:', err);
    // Revert optimistic update
    settingsLabels.set(previousLabels);
    const error = err instanceof Error ? err.message : 'Failed to delete label';
    const status = (err as { status?: number })?.status;
    return {
      success: false,
      error,
      status,
    };
  }
}

/**
 * Sync all settings for the current account
 * Call this on login and account switch
 * Note: fetchSettings now also loads labels from the account response
 */
export async function syncSettings(): Promise<boolean> {
  settingsSynced.set(false);

  try {
    // fetchSettings now handles both settings and labels from /v1/account
    await fetchSettings();
    settingsSynced.set(true);
    return true;
  } catch (err) {
    warn('[settingsStore] Failed to sync settings:', err);
    return false;
  }
}

/**
 * Clear settings for account switch
 */
export function clearSettings(): void {
  remoteSettings.set(structuredClone(DEFAULT_REMOTE_SETTINGS));
  settingsLabels.set([]);
  settingsSynced.set(false);
  settingsError.set(null);
  // Note: accountFetchCache is intentionally preserved across clearSettings()
  // so switching back to a recently-viewed account can reuse cached data.
}

// Export all actions as a single object
export const settingsStore = {
  // Stores
  remoteSettings,
  settingsLabels,
  settingsLoading,
  settingsError,
  settingsSynced,
  localSettingsVersion,

  // Derived stores
  theme,
  layoutMode,
  messagesPerPage,
  archiveFolder,
  bodyIndexing,
  prefetchConfig,
  shortcuts,
  aliasDefaults,
  rememberPassphrase,
  attachmentReminder,
  effectiveTheme,
  effectiveLayoutMode,
  effectiveMessagesPerPage,
  effectiveComposePlainDefault,
  effectiveArchiveFolder,

  // Actions
  actions: {
    fetchSettings,
    updateSettings,
    updateSetting,
    setSettingValue,
    setSettingOverrideEnabled,
    getEffectiveSettingValue,
    fetchLabels,
    createLabel,
    updateLabel,
    deleteLabel,
    syncSettings,
    clearSettings,
    ...settingsActions,
  },

  // Local settings
  local: LocalSettings,
};

export { SETTING_SCOPES, getSettingDefinition };
