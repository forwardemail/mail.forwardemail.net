/**
 * Reading mail from inside the sync worker for an account whose backend
 * lives in the main window.
 *
 * The Rust mail engine can only be called from a window, not from a worker.
 * So the worker asks the main window, which runs the same read on the
 * account's backend and posts the answer back.
 */

import type { MailReads, MessageCheck, MessageListPage, ServerRecord } from './types';

export type RelayMethod = 'listFolders' | 'listMessages' | 'getMessage' | 'checkMessage';

export const RELAY_METHODS: readonly RelayMethod[] = [
  'listFolders',
  'listMessages',
  'getMessage',
  'checkMessage',
];

export type RelaySend = (method: RelayMethod, args: unknown[]) => Promise<unknown>;

export function createRelayReads(send: RelaySend): MailReads {
  return {
    listFolders: () => send('listFolders', []) as Promise<ServerRecord[]>,
    listMessages: (query) => send('listMessages', [query]) as Promise<MessageListPage>,
    getMessage: (id, opts) => send('getMessage', [id, opts]) as Promise<ServerRecord>,
    checkMessage: (id) => send('checkMessage', [id]) as Promise<MessageCheck>,
  };
}

/** An error as it crosses between the worker and the window. */
export interface RelayedError {
  message: string;
  status?: number;
  kind?: string;
  code?: string;
}

export function toRelayedError(err: unknown): RelayedError {
  const e = (err || {}) as { message?: unknown; status?: unknown; kind?: unknown; code?: unknown };
  return {
    message: String(e.message ?? err ?? 'Request failed'),
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
    ...(typeof e.kind === 'string' ? { kind: e.kind } : {}),
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
  };
}

export function fromRelayedError(relayed: RelayedError | undefined): Error {
  const { message, ...rest } = relayed || { message: 'Request failed' };
  return Object.assign(new Error(message || 'Request failed'), rest);
}
