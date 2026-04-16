/**
 * Templates and Signatures store.
 *
 * Per-account reactive state backed by the `meta` KV table via user-content-repo.
 * Mutations update the writable optimistically, then persist. Failures roll back.
 */

import { writable, derived, get } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { warn } from '../utils/logger.ts';
import { Local } from '../utils/storage';
import {
  getTemplates,
  putTemplates,
  getSignatures,
  putSignatures,
} from '../utils/user-content-repo';
import type { Template, Signature, TemplateInput, SignatureInput } from '../types/userContent';

export const templates = writable<Template[]>([]);
export const signatures = writable<Signature[]>([]);
export const userContentLoading = writable<boolean>(false);

export const defaultSignature: Readable<Signature | null> = derived(
  signatures,
  ($signatures) => $signatures.find((s) => s.isDefault) || null,
);

let currentAccount = '';

function activeAccount(account?: string): string {
  return account || currentAccount || Local.get('email') || 'default';
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `uc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadUserContent(account?: string): Promise<void> {
  const acct = activeAccount(account);
  currentAccount = acct;
  userContentLoading.set(true);
  try {
    const [tpl, sig] = await Promise.all([getTemplates(acct), getSignatures(acct)]);
    templates.set(tpl);
    signatures.set(sig);
  } catch (err) {
    warn('[userContentStore] loadUserContent failed', err);
    templates.set([]);
    signatures.set([]);
  } finally {
    userContentLoading.set(false);
  }
}

export function resetUserContent(): void {
  templates.set([]);
  signatures.set([]);
  currentAccount = '';
}

// ── Templates ────────────────────────────────────────────────────────

export async function createTemplate(input: TemplateInput): Promise<Template> {
  const acct = activeAccount();
  const now = Date.now();
  const record: Template = {
    id: uuid(),
    name: input.name.trim(),
    body: input.body,
    useInReplies: input.useInReplies ?? true,
    createdAt: now,
    updatedAt: now,
  };
  const prev = get(templates);
  const next = [...prev, record];
  templates.set(next);
  try {
    await putTemplates(acct, next);
    return record;
  } catch (err) {
    templates.set(prev);
    throw err;
  }
}

export async function updateTemplate(
  id: string,
  updates: Partial<TemplateInput>,
): Promise<Template | null> {
  const acct = activeAccount();
  const prev = get(templates);
  const idx = prev.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const merged: Template = {
    ...prev[idx],
    ...('name' in updates ? { name: (updates.name || '').trim() } : {}),
    ...('body' in updates ? { body: updates.body || '' } : {}),
    ...('useInReplies' in updates ? { useInReplies: Boolean(updates.useInReplies) } : {}),
    updatedAt: Date.now(),
  };
  const next = [...prev];
  next[idx] = merged;
  templates.set(next);
  try {
    await putTemplates(acct, next);
    return merged;
  } catch (err) {
    templates.set(prev);
    throw err;
  }
}

export async function deleteTemplate(id: string): Promise<void> {
  const acct = activeAccount();
  const prev = get(templates);
  const next = prev.filter((t) => t.id !== id);
  if (next.length === prev.length) return;
  templates.set(next);
  try {
    await putTemplates(acct, next);
  } catch (err) {
    templates.set(prev);
    throw err;
  }
}

export function findTemplateByName(name: string): Template | null {
  const target = name.trim().toLowerCase();
  return get(templates).find((t) => t.name.toLowerCase() === target) || null;
}

// ── Signatures ───────────────────────────────────────────────────────

export async function createSignature(input: SignatureInput): Promise<Signature> {
  const acct = activeAccount();
  const now = Date.now();
  const prev = get(signatures);
  const makeDefault = Boolean(input.isDefault) || prev.length === 0;
  const record: Signature = {
    id: uuid(),
    name: input.name.trim(),
    body: input.body,
    isDefault: makeDefault,
    createdAt: now,
    updatedAt: now,
  };
  const next = (makeDefault ? prev.map((s) => ({ ...s, isDefault: false })) : prev).concat(record);
  signatures.set(next);
  try {
    await putSignatures(acct, next);
    return record;
  } catch (err) {
    signatures.set(prev);
    throw err;
  }
}

export async function updateSignature(
  id: string,
  updates: Partial<SignatureInput>,
): Promise<Signature | null> {
  const acct = activeAccount();
  const prev = get(signatures);
  const idx = prev.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const wantsDefault = updates.isDefault === true;
  let next = prev.map((s, i) => {
    if (i === idx) {
      return {
        ...s,
        ...('name' in updates ? { name: (updates.name || '').trim() } : {}),
        ...('body' in updates ? { body: updates.body || '' } : {}),
        ...(wantsDefault ? { isDefault: true } : {}),
        updatedAt: Date.now(),
      } as Signature;
    }
    return wantsDefault ? { ...s, isDefault: false } : s;
  });
  if (!next.some((s) => s.isDefault) && next.length > 0) {
    next = next.map((s, i) => (i === 0 ? { ...s, isDefault: true } : s));
  }
  signatures.set(next);
  try {
    await putSignatures(acct, next);
    return next[idx];
  } catch (err) {
    signatures.set(prev);
    throw err;
  }
}

export async function setDefaultSignature(id: string): Promise<void> {
  const acct = activeAccount();
  const prev = get(signatures);
  if (!prev.some((s) => s.id === id)) return;
  const next = prev.map((s) => ({ ...s, isDefault: s.id === id }));
  signatures.set(next);
  try {
    await putSignatures(acct, next);
  } catch (err) {
    signatures.set(prev);
    throw err;
  }
}

export async function deleteSignature(id: string): Promise<void> {
  const acct = activeAccount();
  const prev = get(signatures);
  const target = prev.find((s) => s.id === id);
  if (!target) return;
  let next = prev.filter((s) => s.id !== id);
  if (target.isDefault && next.length > 0 && !next.some((s) => s.isDefault)) {
    next = next.map((s, i) => (i === 0 ? { ...s, isDefault: true } : s));
  }
  signatures.set(next);
  try {
    await putSignatures(acct, next);
  } catch (err) {
    signatures.set(prev);
    throw err;
  }
}
