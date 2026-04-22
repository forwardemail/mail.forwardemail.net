/**
 * `list_folders` tool — returns the folder list for the account in scope.
 *
 * Safe at every scope level: folder names aren't message content and don't
 * leak cross-customer data. No scope filtering beyond "this account."
 */

import { dbClient } from '../../utils/db-worker-client.js';
import type { ToolImpl, ToolResult, ToolExecutionContext } from './types';

interface FolderRow {
  account?: string;
  path?: string;
  unread_count?: number;
  specialUse?: string;
}

export const listFoldersTool: ToolImpl = {
  def: {
    name: 'list_folders',
    description:
      'List folders in the current mailbox account. Returns each folder\'s path, unread count, and special-use tag (if any, e.g. "Inbox", "Sent", "Trash").',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },

  availableIn: () => true,

  async run(_args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const folders = (await dbClient.folders
      .where('account')
      .equals(ctx.scope.account)
      .toArray()) as FolderRow[];

    const simplified = folders
      .map((f) => ({
        path: f.path ?? '',
        unread: typeof f.unread_count === 'number' ? f.unread_count : 0,
        special_use: f.specialUse ?? null,
      }))
      .filter((f) => f.path);

    return {
      data: { folders: simplified },
      summary: `Listed ${simplified.length} folder${simplified.length === 1 ? '' : 's'}`,
    };
  },
};
