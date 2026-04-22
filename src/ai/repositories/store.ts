/**
 * Repository store — CRUD over registered repositories.
 *
 * Piggybacks on the `meta` Dexie table (same pattern as `ai:provider:*`,
 * `ai:audit:*`) under the `ai:repo:{id}` prefix. Paths and labels are
 * metadata only — filesystem access happens through the repo tools, not
 * through this store.
 */

import { dbClient } from '../../utils/db-worker-client.js';
import type { RepositoryConfig, RepositorySummary } from './types';

const META_KEY_PREFIX = 'ai:repo:';
const metaKey = (id: string): string => `${META_KEY_PREFIX}${id}`;

interface MetaRow {
  key: string;
  value?: RepositoryConfig;
  updatedAt?: number;
}

/**
 * Slugify a label into a stable id. ASCII-only, lowercase, hyphenated.
 * Identical labels produce identical ids; callers handle collisions by
 * appending a short counter if needed.
 */
export const slugifyId = (label: string): string =>
  label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export const saveRepository = async (
  partial: Omit<RepositoryConfig, 'createdAt' | 'updatedAt'>,
): Promise<RepositoryConfig> => {
  const existing = (await dbClient.meta.get(metaKey(partial.id))) as MetaRow | undefined;
  const now = Date.now();
  const full: RepositoryConfig = {
    ...partial,
    createdAt: existing?.value?.createdAt ?? now,
    updatedAt: now,
  };
  await dbClient.meta.put({ key: metaKey(full.id), value: full, updatedAt: now });
  return full;
};

export const getRepository = async (id: string): Promise<RepositoryConfig | null> => {
  const row = (await dbClient.meta.get(metaKey(id))) as MetaRow | undefined;
  return row?.value ?? null;
};

export const listRepositories = async (): Promise<RepositorySummary[]> => {
  const rows = (await dbClient.meta
    .where('key')
    .startsWith(META_KEY_PREFIX)
    .toArray()) as MetaRow[];
  return rows
    .map((r) => r.value)
    .filter((v): v is RepositoryConfig => Boolean(v))
    .map((r) => ({
      id: r.id,
      label: r.label,
      path: r.path,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
};

export const deleteRepository = async (id: string): Promise<void> => {
  await dbClient.meta.delete(metaKey(id));
};

/**
 * Generate a fresh id from a label, avoiding collisions with existing repos.
 * Appends `-2`, `-3`, ... as needed. Used by the Settings add-repo form.
 */
export const allocateRepoId = async (label: string): Promise<string> => {
  const base = slugifyId(label) || 'repo';
  const existing = new Set((await listRepositories()).map((r) => r.id));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
};
