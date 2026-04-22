export const SETTING_SCOPES = {
  ACCOUNT: 'account',
  DEVICE: 'device',
  HYBRID: 'hybrid',
} as const;

export type SettingScope = (typeof SETTING_SCOPES)[keyof typeof SETTING_SCOPES];
export type ValueType = 'string' | 'boolean' | 'number' | 'json';

export type SettingDefinition = {
  id: string;
  label: string;
  scope: SettingScope;
  localKey?: string | ((account: string) => string);
  remotePath?: string[];
  valueType?: ValueType;
  defaultValue?: unknown;
  accountScoped?: boolean;
  localFallbackOnDefault?: boolean;
  sensitive?: boolean;
  storage?: string;
  overrideKey?: string;
  defaultOverride?: boolean;
  localParse?: (raw: unknown) => unknown;
  localSerialize?: (value: unknown) => string | undefined;
  normalizeRemote?: (value: unknown) => unknown;
  serializeRemote?: (value: unknown) => unknown;
};

const toLower = (value: unknown): string => (value == null ? '' : String(value).toLowerCase());

export const normalizeLayoutMode = (value: unknown): string => {
  const mode = toLower(value);
  if (!mode) {
    return 'full';
  }

  if (mode === 'personal') {
    return 'classic';
  }

  // Normalize horizontal to full (horizontal view removed)
  if (mode === 'compact' || mode === 'productivity' || mode === 'horizontal') {
    return 'full';
  }

  if (mode === 'classic' || mode === 'full') {
    return mode;
  }

  return 'full';
};

export const serializeLayoutMode = (value: unknown): string => {
  const mode = toLower(value);
  if (!mode || mode === 'classic') {
    return 'personal';
  }

  if (mode === 'full') {
    return 'compact';
  }

  return mode;
};

const parseBoolean = (raw: unknown, fallback = false): boolean => {
  if (raw === null || raw === undefined) {
    return fallback;
  }

  if (typeof raw === 'boolean') {
    return raw;
  }

  const normalized = String(raw).toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }

  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  return fallback;
};

const parseNumber = (raw: unknown, fallback = 0): number => {
  if (raw === null || raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (raw === null || raw === undefined) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(String(raw));
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
};

const serializeBoolean = (value: unknown): string => (value ? 'true' : 'false');

const serializeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(null);
  }
};

export const SETTINGS_REGISTRY: Record<string, SettingDefinition> = {
  locale: {
    id: 'locale',
    label: 'Locale',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'formatting_locale',
    valueType: 'string',
    defaultValue: 'auto',
  },
  theme: {
    id: 'theme',
    label: 'Theme',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'theme',
    valueType: 'string',
    defaultValue: 'system',
  },
  layout_mode: {
    id: 'layout_mode',
    label: 'Layout',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'layout_mode',
    valueType: 'string',
    defaultValue: 'full',
  },
  compose_plain_default: {
    id: 'compose_plain_default',
    label: 'Plain Text Default',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'compose_plain_default',
    valueType: 'boolean',
    defaultValue: false,
    localParse: (raw) => parseBoolean(raw, false),
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
  attachment_reminder: {
    id: 'attachment_reminder',
    label: 'Attachment Reminder',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'attachment_reminder',
    valueType: 'boolean',
    defaultValue: true,
    localParse: (raw) => parseBoolean(raw, true),
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
  default_reply_all: {
    id: 'default_reply_all',
    label: 'Default Reply All',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'default_reply_all',
    valueType: 'boolean',
    defaultValue: false,
    localParse: (raw) => parseBoolean(raw, false),
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
  send_and_archive_default: {
    id: 'send_and_archive_default',
    label: 'Send & Archive Default',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'send_and_archive_default',
    valueType: 'boolean',
    defaultValue: false,
    localParse: (raw) => parseBoolean(raw, false),
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
  messages_per_page: {
    id: 'messages_per_page',
    label: 'Messages Per Page',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'messages_per_page',
    valueType: 'number',
    defaultValue: 50,
  },
  archive_folder: {
    id: 'archive_folder',
    label: 'Archive Folder',
    scope: SETTING_SCOPES.ACCOUNT,
    remotePath: ['mail', 'archive_folder'],
    localKey: (account) => `archive_folder_${account}`,
    valueType: 'string',
    defaultValue: '',
    accountScoped: true,
    localFallbackOnDefault: true,
  },
  sent_folder: {
    id: 'sent_folder',
    label: 'Sent Folder',
    scope: SETTING_SCOPES.ACCOUNT,
    remotePath: ['mail', 'sent_folder'],
    localKey: (account) => `sent_folder_${account}`,
    valueType: 'string',
    defaultValue: '',
    accountScoped: true,
    localFallbackOnDefault: true,
  },
  drafts_folder: {
    id: 'drafts_folder',
    label: 'Drafts Folder',
    scope: SETTING_SCOPES.ACCOUNT,
    remotePath: ['mail', 'drafts_folder'],
    localKey: (account) => `drafts_folder_${account}`,
    valueType: 'string',
    defaultValue: '',
    accountScoped: true,
    localFallbackOnDefault: true,
  },
  font: {
    id: 'font',
    label: 'Font',
    scope: SETTING_SCOPES.DEVICE,
    localKey: (account) => `font_${account}`,
    valueType: 'string',
    defaultValue: 'system',
    accountScoped: true,
  },
  external_browser_override: {
    id: 'external_browser_override',
    label: 'External Browser Override',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'external_browser_override',
    valueType: 'string',
    defaultValue: '',
    localParse: (raw) => (raw == null ? '' : String(raw).trim()),
    localSerialize: (value) => String(value ?? '').trim(),
  },
  block_remote_images: {
    id: 'block_remote_images',
    label: 'Block Remote Images',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'block_remote_images',
    valueType: 'boolean',
    defaultValue: false,
    localParse: (raw) => parseBoolean(raw, false),
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
  block_tracking_pixels: {
    id: 'block_tracking_pixels',
    label: 'Block Tracking Pixels',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'block_tracking_pixels',
    valueType: 'boolean',
    defaultValue: true,
    localParse: (raw) => parseBoolean(raw, true),
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
  prefetch_enabled: {
    id: 'prefetch_enabled',
    label: 'Background Sync',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'prefetch_enabled',
    valueType: 'boolean',
    defaultValue: true,
    localParse: () => true,
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
  cache_prefetch_enabled: {
    id: 'cache_prefetch_enabled',
    label: 'Body Prefetch',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'cache_prefetch_enabled',
    valueType: 'boolean',
    defaultValue: true,
    localParse: () => true,
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
  prefetch_folders: {
    id: 'prefetch_folders',
    label: 'Extra Prefetch Folders',
    scope: SETTING_SCOPES.DEVICE,
    localKey: (account) => `prefetch_folders_${account}`,
    valueType: 'json',
    defaultValue: [],
    accountScoped: true,
    localParse: (raw) => parseJson(raw, []),
    localSerialize: (value) => serializeJson(Array.isArray(value) ? value : []),
  },
  sync_scope: {
    id: 'sync_scope',
    label: 'Sync Scope',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'sync_scope',
    valueType: 'string',
    defaultValue: 'all',
  },
  sync_page_size: {
    id: 'sync_page_size',
    label: 'Sync Page Size',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'sync_page_size',
    valueType: 'number',
    defaultValue: 50,
  },
  sync_max_headers: {
    id: 'sync_max_headers',
    label: 'Sync Max Headers',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'sync_max_headers',
    valueType: 'number',
    defaultValue: 500,
  },
  sync_body_limit: {
    id: 'sync_body_limit',
    label: 'Sync Body Limit',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'sync_body_limit',
    valueType: 'number',
    defaultValue: 100,
  },
  search_body_indexing: {
    id: 'search_body_indexing',
    label: 'Body Indexing',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'search_body_indexing',
    valueType: 'boolean',
    defaultValue: true,
    localParse: (raw) => parseBoolean(raw, true),
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
  labels: {
    id: 'labels',
    label: 'Labels',
    scope: SETTING_SCOPES.ACCOUNT,
  },
  saved_searches: {
    id: 'saved_searches',
    label: 'Saved Searches',
    scope: SETTING_SCOPES.DEVICE,
    storage: 'indexeddb',
  },
  keyboard_shortcuts: {
    id: 'keyboard_shortcuts',
    label: 'Keyboard Shortcuts',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'keyboard_shortcuts',
    valueType: 'json',
    defaultValue: {},
    localParse: (raw) => parseJson(raw, {}),
    localSerialize: (value) => serializeJson(value || {}),
  },
  pgp_keys: {
    id: 'pgp_keys',
    label: 'PGP Keys',
    scope: SETTING_SCOPES.DEVICE,
    localKey: (account) => `pgp_keys_${account}`,
    valueType: 'json',
    defaultValue: [],
    accountScoped: true,
    sensitive: true,
    localParse: (raw) => parseJson(raw, []),
    localSerialize: (value) => serializeJson(Array.isArray(value) ? value : []),
  },
  pgp_passphrases: {
    id: 'pgp_passphrases',
    label: 'PGP Passphrases',
    scope: SETTING_SCOPES.DEVICE,
    localKey: (account) => `pgp_passphrases_${account}`,
    valueType: 'json',
    defaultValue: {},
    accountScoped: true,
    sensitive: true,
    localParse: (raw) => parseJson(raw, {}),
    localSerialize: (value) => serializeJson(value || {}),
  },
  hide_completed_todos: {
    id: 'hide_completed_todos',
    label: 'Hide Completed Todos',
    scope: SETTING_SCOPES.DEVICE,
    localKey: 'hide_completed_todos',
    valueType: 'boolean',
    defaultValue: false,
    localParse: (raw) => parseBoolean(raw, false),
    localSerialize: (value) => serializeBoolean(Boolean(value)),
  },
};

export const getSettingDefinition = (id: string): SettingDefinition | undefined =>
  SETTINGS_REGISTRY[id] || null;

export const resolveLocalKey = (
  def: SettingDefinition | undefined,
  account?: string,
): string | undefined => {
  if (!def?.localKey) {
    return null;
  }

  if (typeof def.localKey === 'function') {
    return def.localKey(account || 'default');
  }

  return def.localKey;
};

export const resolveOverrideKey = (
  def: SettingDefinition | undefined,
  account?: string,
): string | undefined => {
  if (def?.scope !== SETTING_SCOPES.HYBRID) {
    return null;
  }

  const suffix = def.accountScoped ? `_${account || 'default'}` : '';
  return def.overrideKey || `setting_override_${def.id}${suffix}`;
};

export const parseLocalValue = (def: SettingDefinition | undefined, raw: unknown): unknown => {
  if (!def) {
    return raw;
  }

  if (def.localParse) {
    return def.localParse(raw);
  }

  const fallback = def.defaultValue;
  if (def.valueType === 'boolean') {
    return parseBoolean(raw, fallback as boolean);
  }

  if (def.valueType === 'number') {
    return parseNumber(raw, fallback as number);
  }

  if (def.valueType === 'json') {
    return parseJson(raw, fallback);
  }

  if (raw === null || raw === undefined) {
    return fallback;
  }

  return raw;
};

export const serializeLocalValue = (
  def: SettingDefinition | undefined,
  value: unknown,
): string | undefined => {
  if (!def) {
    return value == null ? null : String(value);
  }

  if (def.localSerialize) {
    return def.localSerialize(value);
  }

  if (def.valueType === 'boolean') {
    return serializeBoolean(Boolean(value));
  }

  if (def.valueType === 'number') {
    return value == null ? null : String(value);
  }

  if (def.valueType === 'json') {
    return serializeJson(value);
  }

  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
};

export const normalizeRemoteValue = (
  def: SettingDefinition | undefined,
  value: unknown,
): unknown => {
  if (!def) {
    return value;
  }

  if (def.normalizeRemote) {
    return def.normalizeRemote(value);
  }

  return value ?? def.defaultValue;
};

export const serializeRemoteValue = (
  def: SettingDefinition | undefined,
  value: unknown,
): unknown => {
  if (!def) {
    return value;
  }

  if (def.serializeRemote) {
    return def.serializeRemote(value);
  }

  return value;
};
