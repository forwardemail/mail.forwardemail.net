/**
 * The demo mailbox as a mail backend.
 *
 * The demo shows generated mail (src/utils/demo-data.js) and never talks to a
 * server. Reading works, marking read and starring are remembered for the
 * session, and anything that would change the mailbox (move, delete, folder
 * changes) shows the "not in the demo" toast and fails.
 *
 * Calendar, contacts and sending are not mail backend calls. They are still
 * answered by the request interceptor in src/utils/demo-mode.js.
 */

import { demoMail, isDemoMode } from '../utils/demo-mode';
import { FORWARD_EMAIL_CAPABILITIES } from './capabilities';
import type {
  FlagChange,
  IdRemap,
  LabelChange,
  MailBackend,
  MessageId,
  MessageRequestOptions,
  ServerRecord,
} from './types';

const SEEN = '\\Seen';
const has = (list: unknown, flag: string): boolean => Array.isArray(list) && list.includes(flag);

export class DemoBackend implements MailBackend {
  readonly kind = 'demo' as const;
  // The demo shows the whole product, so nothing is hidden.
  readonly capabilities = FORWARD_EMAIL_CAPABILITIES;

  constructor(readonly account: string) {}

  isReady(): boolean {
    return isDemoMode();
  }

  /** Nothing to replay: a demo change never leaves this device. */
  backgroundReplay(): null {
    return null;
  }

  async changeFlags(id: MessageId, change: FlagChange): Promise<void> {
    if (has(change.remove, SEEN)) demoMail.setRead(id, false);
    else if (has(change.add, SEEN) || has(change.flags, SEEN)) demoMail.setRead(id, true);
  }

  async changeLabels(_id: MessageId, _change: LabelChange): Promise<void> {
    // Shown from the app's own state until the next reload.
  }

  /** `label` names the action in the toast ("Archive", "Delete message"). */
  async moveMessage(
    _id: MessageId,
    _destFolder: string,
    { label = 'Move' }: { label?: string } = {},
  ): Promise<IdRemap> {
    return demoMail.block(label);
  }

  async deleteMessage(): Promise<void> {
    demoMail.block('Delete message');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async requestMessageList(query: object): Promise<any> {
    return demoMail.messages(query as Record<string, unknown>);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async requestMessage(id: MessageId, opts: MessageRequestOptions = {}): Promise<any> {
    return demoMail.message(id, opts.folder);
  }

  async listFolders(): Promise<ServerRecord[]> {
    return demoMail.folders();
  }

  async getFolder(id: MessageId): Promise<ServerRecord> {
    return demoMail.folder(id);
  }

  async createFolder(): Promise<void> {
    demoMail.block('Create folder');
  }

  async renameFolder(): Promise<void> {
    demoMail.block('Update folder');
  }

  async deleteFolder(): Promise<void> {
    demoMail.block('Delete folder');
  }
}
