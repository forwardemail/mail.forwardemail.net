/**
 * AI Audit Log Store
 *
 * Every outbound AI request and every tool call is appended to a local-only
 * audit log. The goal is transparency, not debugging: the user can check what
 * the AI actually did on their behalf, verify it stayed in scope, and notice
 * anomalies.
 *
 * Storage: Dexie `meta` table under `ai:audit:{YYYY-MM-DD}` keys, one row per
 * day with an array of events (same meta-table pattern as `ai:provider:*`,
 * `ai:repo:*`). 30-day retention; daily bucketing keeps cardinality bounded
 * so `meta.get` hot paths stay fast (see the tripwire test in
 * `dexie-schema.test.ts`).
 *
 * Events are deliberately lightweight — no message bodies, no full tool args,
 * no API keys. Short summaries only. If the user wants to understand what
 * Claude actually received, they should use the egress preview before
 * sending, not the audit log after.
 */

import { writable } from 'svelte/store';
import { dbClient } from '../utils/db-worker-client.js';

export type AuditEventKind = 'chat_start' | 'chat_done' | 'chat_error' | 'tool_call' | 'tool_error';

export interface AuditEvent {
  /** Monotonic within a session. Useful for grouping related events. */
  session_id: string;
  kind: AuditEventKind;
  /** Unix ms. */
  timestamp: number;
  /** Feature that triggered the event ("summarize", "draft_support_reply", ...). */
  feature?: string;
  /** Provider id (for chat events). */
  provider_id?: string;
  /** Tool name (for tool events). */
  tool_name?: string;
  /** Short summary surfaced to the user — no bodies, no full args. */
  summary: string;
  /** Error code from AIError, for tool_error / chat_error events. */
  error_code?: string;
  /** Scope the request ran under. */
  scope_kind?: 'thread' | 'participants' | 'mailbox';
}

interface MetaRow {
  key: string;
  value?: AuditEvent[];
  updatedAt?: number;
}

const AUDIT_KEY_PREFIX = 'ai:audit:';
const RETENTION_DAYS = 30;
const MAX_EVENTS_PER_DAY = 500;

const dayKey = (timestamp: number): string => {
  const d = new Date(timestamp);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${AUDIT_KEY_PREFIX}${y}-${m}-${day}`;
};

const events = writable<AuditEvent[]>([]);

export const auditEvents = { subscribe: events.subscribe };

/**
 * Append an event to today's row. Bounded at MAX_EVENTS_PER_DAY — further
 * appends drop the oldest of the day to keep the row size sane.
 */
export const appendAuditEvent = async (event: AuditEvent): Promise<void> => {
  const key = dayKey(event.timestamp);
  try {
    const existing = (await dbClient.meta.get(key)) as MetaRow | undefined;
    const list = [...(existing?.value ?? []), event];
    if (list.length > MAX_EVENTS_PER_DAY) list.splice(0, list.length - MAX_EVENTS_PER_DAY);
    await dbClient.meta.put({ key, value: list, updatedAt: Date.now() });
  } catch (err) {
    console.warn('[aiAuditStore] append failed', err);
  }
  void refreshAuditEvents();
};

/** Load all in-retention audit events into the reactive store. */
export const refreshAuditEvents = async (): Promise<void> => {
  try {
    const rows = (await dbClient.meta
      .where('key')
      .startsWith(AUDIT_KEY_PREFIX)
      .toArray()) as MetaRow[];
    const all: AuditEvent[] = [];
    for (const row of rows) {
      if (row.value) all.push(...row.value);
    }
    all.sort((a, b) => b.timestamp - a.timestamp);
    events.set(all);
  } catch (err) {
    console.warn('[aiAuditStore] refresh failed', err);
    events.set([]);
  }
};

/** Drop rows older than RETENTION_DAYS. Safe to call periodically. */
export const pruneOldAudit = async (): Promise<void> => {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    const rows = (await dbClient.meta
      .where('key')
      .startsWith(AUDIT_KEY_PREFIX)
      .toArray()) as MetaRow[];
    const toDelete = rows
      .filter((r) => {
        const iso = r.key.slice(AUDIT_KEY_PREFIX.length);
        const t = Date.parse(`${iso}T00:00:00Z`);
        return Number.isFinite(t) && t < cutoff;
      })
      .map((r) => r.key);
    if (toDelete.length > 0) await dbClient.meta.bulkDelete(toDelete);
  } catch (err) {
    console.warn('[aiAuditStore] prune failed', err);
  }
};

export const clearAudit = async (): Promise<void> => {
  try {
    const rows = (await dbClient.meta
      .where('key')
      .startsWith(AUDIT_KEY_PREFIX)
      .toArray()) as MetaRow[];
    const keys = rows.map((r) => r.key);
    if (keys.length > 0) await dbClient.meta.bulkDelete(keys);
  } catch (err) {
    console.warn('[aiAuditStore] clear failed', err);
  }
  events.set([]);
};

export const exportAuditAsJSON = (all: AuditEvent[]): string => JSON.stringify(all, null, 2);

/** Generate a session id. Shared by all events in one chat request's lifecycle. */
export const newAuditSessionId = (): string =>
  `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
