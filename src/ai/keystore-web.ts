/**
 * AI Keystore — web (main thread)
 *
 * Provider metadata lives in the Dexie `meta` table under `ai:provider:{id}`
 * keys (decision #4 in the implementation plan — no schema bump). API keys
 * live in `localStorage` under `webmail_ai_provider_key_{id}`, auto-encrypted
 * by the existing `crypto-store` sensitive-localStorage path when app-lock
 * is enabled.
 *
 * Security boundary: keys are plaintext while the app is unlocked, encrypted
 * at rest otherwise (same policy as `api_key` / `alias_auth`). Keys cross the
 * main-thread → ai.worker boundary on the per-request message. They do not
 * persist in worker memory between requests.
 *
 * `localStorage` is not available inside Web Workers. Use `getProviderKey`
 * only from the main thread; pass the returned key to ai.worker in the
 * chat-request payload.
 */

import type { ProviderKind } from './providers/types';
import { dbClient } from '../utils/db-worker-client.js';
import { readSensitiveLocal, writeSensitiveLocal } from '../utils/crypto-store.js';

const META_KEY_PREFIX = 'ai:provider:';
const LOCAL_KEY_PREFIX = 'ai_provider_key_';

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Full endpoint URL (e.g. https://api.anthropic.com, http://localhost:11434). */
  endpoint: string;
  /** Default model for this provider (e.g. claude-sonnet-4-6). */
  model?: string;
  createdAt: number;
  updatedAt: number;
}

interface MetaRow {
  key: string;
  value?: ProviderConfig;
  updatedAt?: number;
}

const metaKey = (id: string): string => `${META_KEY_PREFIX}${id}`;
const storageKey = (id: string): string => `${LOCAL_KEY_PREFIX}${id}`;

const LOCAL_STORAGE_AVAILABLE = typeof localStorage !== 'undefined';

const assertMainThread = (op: string): void => {
  if (!LOCAL_STORAGE_AVAILABLE) {
    throw new Error(`keystore-web.${op}() must be called from the main thread`);
  }
};

/** Persist provider config + API key. Overwrites if `id` exists. */
export const saveProvider = async (
  config: Omit<ProviderConfig, 'createdAt' | 'updatedAt'>,
  apiKey: string,
): Promise<ProviderConfig> => {
  assertMainThread('saveProvider');

  const existing = (await dbClient.meta.get(metaKey(config.id))) as MetaRow | undefined;
  const now = Date.now();
  const full: ProviderConfig = {
    ...config,
    createdAt: existing?.value?.createdAt ?? now,
    updatedAt: now,
  };

  await dbClient.meta.put({ key: metaKey(config.id), value: full, updatedAt: now });
  if (apiKey) {
    writeSensitiveLocal(storageKey(config.id), apiKey);
  }

  return full;
};

/** Read provider metadata (no key). Safe to call from main thread or worker. */
export const getProvider = async (id: string): Promise<ProviderConfig | null> => {
  const row = (await dbClient.meta.get(metaKey(id))) as MetaRow | undefined;
  return row?.value ?? null;
};

/** List all configured providers. Safe to call from main thread or worker. */
export const listProviders = async (): Promise<ProviderConfig[]> => {
  const rows = (await dbClient.meta
    .where('key')
    .startsWith(META_KEY_PREFIX)
    .toArray()) as MetaRow[];
  return rows.map((r) => r.value).filter((v): v is ProviderConfig => Boolean(v));
};

/** Remove provider metadata and its API key. */
export const deleteProvider = async (id: string): Promise<void> => {
  assertMainThread('deleteProvider');
  await dbClient.meta.delete(metaKey(id));
  localStorage.removeItem(`webmail_${storageKey(id)}`);
};

/**
 * Return the provider's API key in plaintext. Main thread only. Returns `null`
 * if no key is stored, or if the app is locked and the key is encrypted at
 * rest (crypto-store returns null when it can't decrypt).
 */
export const getProviderKey = (id: string): string | null => {
  assertMainThread('getProviderKey');
  const value = readSensitiveLocal(storageKey(id));
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
};
