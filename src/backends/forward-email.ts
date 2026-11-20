/**
 * The Forward Email REST API as a mail backend.
 *
 * Every request is sent with the credentials of the account the backend was
 * made for. Without them it throws rather than send: Remote would otherwise
 * fall back to the active account's credentials and act on the wrong mailbox.
 */

import { Remote } from '../utils/remote';
import { getAuthHeaderForAccount } from '../utils/auth';
import { config } from '../config';
import { flagChangeBody, labelChangeBody } from '../utils/message-changes';
import { FORWARD_EMAIL_CAPABILITIES } from './capabilities';
import {
  BackendNotReadyError,
  type FlagChange,
  type IdRemap,
  type LabelChange,
  type BackgroundReplay,
  type ListRequestOptions,
  type MailBackend,
  type MessageId,
  type MessageRequestOptions,
  type ServerRecord,
} from './types';

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const messagePath = (id: MessageId): string => `/v1/messages/${encodeURIComponent(id)}`;
const folderPath = (id: MessageId): string => `/v1/folders/${encodeURIComponent(id)}`;

// A large mailbox can take this long to list its folders.
const FOLDER_LIST_TIMEOUT_MS = 120_000;

/**
 * The PUT body for a flag change. With the whole list the server gets both
 * the list and what changed. Without it only what changed is sent, so a
 * server that ignores those fields changes nothing.
 */
export function flagChangeRequestBody(change: FlagChange): Record<string, string[]> {
  const add = strings(change.add);
  const remove = strings(change.remove);
  if (Array.isArray(change.flags)) return { ...flagChangeBody(change.flags, { add, remove }) };
  const body: Record<string, string[]> = {};
  if (add.length > 0) body.flags_add = add;
  if (remove.length > 0) body.flags_remove = remove;
  return body;
}

export class ForwardEmailBackend implements MailBackend {
  readonly kind = 'forwardemail' as const;
  readonly capabilities = FORWARD_EMAIL_CAPABILITIES;

  constructor(readonly account: string) {}

  private authHeader(): string {
    try {
      return getAuthHeaderForAccount(this.account) || '';
    } catch {
      return '';
    }
  }

  isReady(): boolean {
    return Boolean(this.authHeader());
  }

  /**
   * The service worker replays queued changes over the REST API when the app
   * is closed. It cannot read the account list, so the address and header go
   * on each queued record.
   */
  backgroundReplay(): BackgroundReplay | null {
    const authHeader = this.authHeader();
    return authHeader ? { apiBase: config.apiBase || '', authHeader } : null;
  }

  private requireAuth(): string {
    const header = this.authHeader();
    if (!header) throw new BackendNotReadyError(this.account);
    return header;
  }

  private async updateMessage(id: MessageId, body: object): Promise<void> {
    const authHeader = this.requireAuth();
    await Remote.request('MessageUpdate', body, {
      method: 'PUT',
      pathOverride: messagePath(id),
      authHeader,
    });
  }

  changeFlags(id: MessageId, change: FlagChange): Promise<void> {
    return this.updateMessage(id, flagChangeRequestBody(change));
  }

  changeLabels(id: MessageId, change: LabelChange): Promise<void> {
    return this.updateMessage(id, labelChangeBody(change.labels, change.previous ?? undefined));
  }

  async moveMessage(id: MessageId, destFolder: string): Promise<IdRemap> {
    await this.updateMessage(id, { folder: destFolder });
    // The API keeps a message's id when it moves.
    return {};
  }

  async deleteMessage(id: MessageId, { permanent = false } = {}): Promise<void> {
    const authHeader = this.requireAuth();
    const path = messagePath(id);
    await Remote.request(
      'MessageDelete',
      {},
      {
        method: 'DELETE',
        pathOverride: permanent ? `${path}?permanent=1` : path,
        authHeader,
      },
    );
  }

  async requestMessageList(
    query: object,
    opts: ListRequestOptions = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const authHeader = this.requireAuth();
    return Remote.request('MessageList', query, {
      method: 'GET',
      pathOverride: '/v1/messages',
      ...(opts.timeout ? { timeout: opts.timeout } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.perfLabel ? { perfLabel: opts.perfLabel } : {}),
      authHeader,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestMessage(id: MessageId, opts: MessageRequestOptions = {}): Promise<any> {
    const query = [`folder=${encodeURIComponent(opts.folder || '')}`];
    if (opts.eml) query.push('eml=true');
    else query.push(`raw=${opts.raw ? 'true' : 'false'}`);
    return Remote.request(
      'Message',
      {},
      {
        method: 'GET',
        pathOverride: `${messagePath(id)}?${query.join('&')}`,
        authHeader: this.requireAuth(),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.responseAs ? { responseAs: opts.responseAs } : {}),
      },
    );
  }

  async listFolders(): Promise<ServerRecord[]> {
    const authHeader = this.requireAuth();
    const res = await Remote.request(
      'Folders',
      {},
      {
        method: 'GET',
        // The API returns 25 folders unless asked for more.
        pathOverride: '/v1/folders?limit=100',
        timeout: FOLDER_LIST_TIMEOUT_MS,
        authHeader,
      },
    );
    const raw = res?.Result || res || [];
    return Array.isArray(raw) ? raw : raw.Items || raw.items || [];
  }

  async getFolder(id: MessageId): Promise<ServerRecord> {
    const authHeader = this.requireAuth();
    return Remote.request(
      'FolderGet',
      {},
      { method: 'GET', pathOverride: folderPath(id), authHeader },
    );
  }

  async createFolder(path: string): Promise<void> {
    const authHeader = this.requireAuth();
    await Remote.request(
      'FolderCreate',
      { path },
      { method: 'POST', pathOverride: '/v1/folders', authHeader },
    );
  }

  async renameFolder(id: MessageId, newPath: string): Promise<void> {
    const authHeader = this.requireAuth();
    await Remote.request(
      'FolderUpdate',
      { path: newPath },
      { method: 'PUT', pathOverride: folderPath(id), authHeader },
    );
  }

  async deleteFolder(id: MessageId): Promise<void> {
    const authHeader = this.requireAuth();
    await Remote.request(
      'FolderDelete',
      {},
      { method: 'DELETE', pathOverride: folderPath(id), authHeader },
    );
  }
}
