/**
 * Persistence adapter for Templates and Signatures.
 *
 * v1: IndexedDB `meta` KV table, scoped per account.
 * v2: swap this module for one that reads/writes through
 *     `Remote.request('AccountUpdate', { settings: { templates, signatures } })`
 *     and caches in a dedicated Dexie table. Public API stays stable.
 */

import { db } from './db';
import type { Template, Signature } from '../types/userContent';

const TEMPLATES_KEY_PREFIX = 'templates_';
const SIGNATURES_KEY_PREFIX = 'signatures_';

function templatesKey(account: string): string {
  return `${TEMPLATES_KEY_PREFIX}${account || 'default'}`;
}

function signaturesKey(account: string): string {
  return `${SIGNATURES_KEY_PREFIX}${account || 'default'}`;
}

async function readList<T>(key: string): Promise<T[]> {
  try {
    const record = await db.meta.get(key);
    if (!record?.value) return [];
    return Array.isArray(record.value) ? (record.value as T[]) : [];
  } catch {
    return [];
  }
}

async function writeList<T>(key: string, list: T[]): Promise<void> {
  await db.meta.put({ key, value: list, updatedAt: Date.now() });
}

export async function getTemplates(account: string): Promise<Template[]> {
  return readList<Template>(templatesKey(account));
}

export async function putTemplates(account: string, list: Template[]): Promise<void> {
  await writeList(templatesKey(account), list);
}

export async function getSignatures(account: string): Promise<Signature[]> {
  return readList<Signature>(signaturesKey(account));
}

export async function putSignatures(account: string, list: Signature[]): Promise<void> {
  await writeList(signaturesKey(account), list);
}
