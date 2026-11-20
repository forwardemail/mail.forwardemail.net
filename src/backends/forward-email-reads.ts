/**
 * Reading mail from the Forward Email REST API.
 *
 * This is the read half of the backend, kept apart from forward-email.ts
 * because the sync worker runs it and a worker cannot load Remote or the
 * account storage. The worker hands in its own fetch (timeout and circuit
 * breaker) and a way to get the account's header.
 */

import { parseResultList } from '../workers/sync-pure';
import type { MailReads, MessageCheck, MessageId, MessageListPage, ServerRecord } from './types';

type FetchLike = (url: string, options?: Record<string, unknown>) => Promise<Response>;

export interface ForwardEmailReadsOptions {
  /** Read on every call: the worker learns the API address after it starts. */
  apiBase: () => string;
  /** The account's header. Throws when there is none, so nothing is sent. */
  authHeader: () => string;
  fetch: FetchLike;
}

async function failure(res: Response): Promise<Error & { status: number }> {
  const text = await res.text();
  // The status tells an API outage from a message the server will never return.
  return Object.assign(new Error(text || res.statusText || 'Request failed'), {
    status: res.status,
  });
}

export function createForwardEmailReads(options: ForwardEmailReadsOptions): MailReads {
  const base = () => options.apiBase().replace(/\/$/, '');
  const messageUrl = (id: MessageId) => `${base()}/v1/messages/${encodeURIComponent(id)}`;
  const get = (url: string, contentType = true) =>
    options.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: options.authHeader(),
        ...(contentType ? { 'Content-Type': 'application/json' } : {}),
      },
    });

  return {
    async listFolders() {
      const url = new URL(`${base()}/v1/folders`);
      // The API returns 25 folders unless asked for more.
      url.searchParams.set('limit', '100');
      const res = await get(url.toString());
      if (!res.ok) throw await failure(res);
      const json = await res.json();
      const raw = json?.Result || json || [];
      return Array.isArray(raw) ? raw : raw.Items || raw.items || [];
    },

    async listMessages(query): Promise<MessageListPage> {
      const url = new URL(`${base()}/v1/messages`);
      Object.entries(query).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      });
      const res = await get(url.toString());
      if (!res.ok) throw await failure(res);
      const header = res.headers?.get?.('X-Item-Count');
      const headerTotal =
        header === null || header === undefined || header === '' ? NaN : Number(header);
      const total = Number.isFinite(headerTotal) && headerTotal >= 0 ? headerTotal : null;
      if (res.status === 204) return { rows: [], total, notModified: true };
      const rows = parseResultList<ServerRecord>(await res.json());
      return { rows: Array.isArray(rows) ? rows : [], total, notModified: false };
    },

    async getMessage(id, { folder, raw = false } = {}) {
      const query: string[] = [];
      if (folder !== undefined) query.push(`folder=${encodeURIComponent(folder)}`);
      if (raw) query.push('raw=true');
      const url = messageUrl(id) + (query.length ? `?${query.join('&')}` : '');
      const res = await get(url);
      if (!res.ok) throw await failure(res);
      const json = await res.json();
      return json?.Result || json;
    },

    async checkMessage(id): Promise<MessageCheck> {
      const url = new URL(messageUrl(id));
      // Only the answer's status and folder are used, so ask for the smallest one.
      url.searchParams.set('raw', 'false');
      url.searchParams.set('nodemailer', 'false');
      url.searchParams.set('attachments', 'false');
      const res = await get(url.toString(), false);
      if (res.status === 401 || res.status === 403) return { state: 'rejected' };
      if (res.status === 404) return { state: 'gone' };
      if (!res.ok) return { state: 'unknown' };
      try {
        const json = await res.json();
        return { state: 'found', detail: json?.Result || json };
      } catch {
        return { state: 'found', detail: null };
      }
    },
  };
}
