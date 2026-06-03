// Pure helpers extracted from settingsStore.ts so they can be unit-tested
// without loading the store's I/O graph (Remote, db, Local, svelte stores).
// These cover the settings <-> /v1/account payload mapping, label map/array
// transforms, and small value parsers. Keep them side-effect-free — anything
// touching Remote/db/Local/stores belongs back in settingsStore.ts.

import type { Label } from '../types';
import type { SettingDefinition } from './settingsRegistry';

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

export interface LabelSettingValue {
  name?: string;
  color?: string;
  hidden?: boolean;
  source?: string;
}

export interface AccountResponse {
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

export interface SettingsChanges {
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

export type TasksSortKey = 'due' | 'title' | 'created';

// Default remote settings (API-backed, account-scoped)
export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = {
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

const VALID_TASKS_SORT: TasksSortKey[] = ['due', 'title', 'created'];

/**
 * Map an API/HTTP error from a label mutation into a user-facing message,
 * disambiguating auth (401), validation (400), and server (5xx) failures.
 */
export function describeLabelError(action: string, err: unknown): string {
  const status =
    (err as { status?: number; statusCode?: number })?.status ??
    (err as { status?: number; statusCode?: number })?.statusCode;
  const baseMsg = err instanceof Error ? err.message : 'Unknown error';
  if (status === 401 || /authorization required/i.test(baseMsg)) {
    return `Couldn't ${action}: sign in with your alias password to sync labels across devices.`;
  }
  if (status === 400) return `Couldn't ${action}: ${baseMsg}`;
  if (status && status >= 500) return `Couldn't ${action}: server error (${status}). Try again.`;
  return `Couldn't ${action}: ${baseMsg}`;
}

/**
 * Convert API label_settings map into an array of labels with keyword
 */
export function mapLabelSettingsToArray(
  labelSettings: Record<string, LabelSettingValue> = {},
): Label[] {
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
export function labelsArrayToMap(labels: Label[] = []): Record<string, LabelSettingValue> {
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

/**
 * Extract settings fields from /v1/account response.
 * Supports both legacy nested `settings` and new flat alias fields.
 */
export function extractSettingsFromAccount(response: AccountResponse = {}): RemoteSettings {
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

/**
 * Convert internal settings shape into the flat API payload expected by /v1/account
 */
export function buildAccountUpdatePayload(changes: SettingsChanges = {}): {
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

/**
 * Coerce an arbitrary stored value into a valid tasks-sort key, defaulting to
 * 'due' for anything unrecognized.
 */
export function normalizeTasksSort(raw: unknown): TasksSortKey {
  const value = String(raw || '').toLowerCase() as TasksSortKey;
  return VALID_TASKS_SORT.includes(value) ? value : 'due';
}

/**
 * Parse a stored override flag ('true'/'1' -> true, 'false'/'0' -> false),
 * returning `fallback` for null/undefined/unrecognized values.
 */
export function parseOverrideValue(raw: unknown, fallback = false): boolean {
  if (raw === null || raw === undefined) return fallback;
  const normalized = String(raw).toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

/**
 * Build the nested object an /v1/account setting expects from a definition's
 * remotePath, e.g. remotePath ['mail','archive_folder'] + value 'X' ->
 * { mail: { archive_folder: 'X' } }.
 */
export function buildRemoteSettingChange(
  def: SettingDefinition,
  value: unknown,
): Record<string, unknown> {
  if (!def?.remotePath?.length) return {};
  return def.remotePath.reduceRight(
    (acc: unknown, key: string) => ({ [key]: acc }),
    value,
  ) as Record<string, unknown>;
}
