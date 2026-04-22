/**
 * `get_thread` tool — fetch all messages in a thread with bodies.
 *
 * Only available under `participants` or `mailbox` scope (thread scope has
 * the current thread pre-loaded). Enforces: the returned thread's messages
 * must pass `enforceScope` — a model cannot ask for a thread outside the
 * authorized participant set under participants scope.
 */

import { dbClient } from '../../utils/db-worker-client.js';
import type { Message, MessageBody } from '../../types';
import type { ToolImpl, ToolResult, ToolExecutionContext } from './types';
import { ToolError } from './types';
import { enforceScope } from '../context/scope';

const MAX_MESSAGES = 50;
const MAX_BODY_CHARS = 8_000;

export const getThreadTool: ToolImpl = {
  def: {
    name: 'get_thread',
    description:
      'Fetch all messages in a thread by thread_id, ordered oldest→newest. Each message includes headers and up to ~8k chars of body. Use thread ids returned from `search_messages`. Unavailable under thread scope (the current thread is already attached).',
    parameters: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'string',
          description: 'A thread identifier from search_messages.',
        },
      },
      required: ['thread_id'],
      additionalProperties: false,
    },
  },

  availableIn: (scope) => scope.kind !== 'thread',

  async run(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    if (ctx.scope.kind === 'thread') {
      throw new ToolError('out_of_scope', 'get_thread is unavailable under thread scope');
    }
    if (ctx.scope.kind === 'mailbox' && !ctx.scope.confirmed) {
      throw new ToolError('out_of_scope', 'mailbox scope is not confirmed');
    }

    const threadId = typeof args.thread_id === 'string' ? args.thread_id.trim() : '';
    if (!threadId) {
      throw new ToolError('bad_args', 'thread_id is required and must be a string');
    }

    const candidates = (await dbClient.messages
      .where('account')
      .equals(ctx.scope.account)
      .toArray()) as Message[];

    const matching = candidates.filter((m) => m.thread_id === threadId || m.root_id === threadId);
    if (matching.length === 0) {
      throw new ToolError('not_found', `no messages found for thread_id=${threadId}`);
    }

    const scoped = enforceScope(ctx.scope, matching);
    if (scoped.length === 0) {
      throw new ToolError(
        'out_of_scope',
        `thread ${threadId} has no messages within the current scope`,
      );
    }

    scoped.sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
    const page = scoped.slice(-MAX_MESSAGES);
    const truncated = page.length < scoped.length;

    const ids = page.map((m) => [ctx.scope.account, m.id] as [string, string]);
    const bodies = (await dbClient.messageBodies.bulkGet(ids)) as Array<MessageBody | undefined>;

    const messages = page.map((m, i) => {
      const bodyRow = bodies[i];
      const text =
        (bodyRow as { textContent?: string } | undefined)?.textContent ??
        (bodyRow as { body?: string } | undefined)?.body ??
        '';
      return {
        id: m.id,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        date: m.date,
        is_unread: m.is_unread,
        has_attachment: m.has_attachment,
        body:
          text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + '\n\n[…truncated…]' : text,
      };
    });

    return {
      data: { thread_id: threadId, messages, truncated, total_in_thread: scoped.length },
      summary: `Loaded ${messages.length} message${messages.length === 1 ? '' : 's'} from thread`,
    };
  },
};
