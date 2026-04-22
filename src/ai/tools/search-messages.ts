/**
 * `search_messages` tool — the NL→DSL path the model uses to find messages
 * beyond the pre-loaded thread.
 *
 * Not available at `thread` scope (the whole thread is already in the prompt;
 * searching would escape scope). Under `participants` scope, every filter is
 * ANDed with the allowed participant set — the model cannot widen beyond
 * what the user authorized. Under `mailbox` scope (confirmed), filters run
 * as given.
 *
 * Returns summaries only — no full bodies. The model calls `get_thread` to
 * pull a full conversation once it's found the candidate.
 */

import { dbClient } from '../../utils/db-worker-client.js';
import type { ToolImpl, ToolResult, ToolExecutionContext } from './types';
import { ToolError } from './types';
import { validateSearchQuery } from '../dsl/search-query';
import { mergeScopedFilters, enforceScope } from '../context/scope';
import type { Message } from '../../types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const searchMessagesTool: ToolImpl = {
  def: {
    name: 'search_messages',
    description:
      'Search the mailbox for messages matching filters. Returns summaries (id, from, subject, snippet, date, thread_id, folder). Use `get_thread` to fetch full bodies for threads you want to read. Under thread scope this tool is unavailable — the current thread is already attached to the prompt.',
    parameters: {
      type: 'object',
      properties: {
        text_query: {
          type: 'string',
          description:
            'Free text matched against subject and snippet (case-insensitive substring).',
        },
        from: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sender addresses or domains (substring match).',
        },
        subject_contains: {
          type: 'array',
          items: { type: 'string' },
        },
        folder: {
          type: 'string',
          description: 'Restrict to a single folder path (e.g. "INBOX").',
        },
        after: { type: 'string', description: 'ISO 8601 date lower bound.' },
        before: { type: 'string', description: 'ISO 8601 date upper bound.' },
        is_unread: { type: 'boolean' },
        has_attachment: { type: 'boolean' },
        limit: {
          type: 'integer',
          description: `Max results. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
  },

  availableIn: (scope) => scope.kind !== 'thread',

  async run(rawArgs: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    if (ctx.scope.kind === 'thread') {
      throw new ToolError('out_of_scope', 'search_messages is unavailable under thread scope');
    }
    if (ctx.scope.kind === 'mailbox' && !ctx.scope.confirmed) {
      throw new ToolError('out_of_scope', 'mailbox scope is not confirmed');
    }

    // Translate incoming args to a SearchQuery DSL, then merge with scope.
    // The merge is where privacy enforcement lives.
    const dslShape: Record<string, unknown> = {
      filters: {
        ...(rawArgs.from ? { from: rawArgs.from } : {}),
        ...(rawArgs.subject_contains ? { subject_contains: rawArgs.subject_contains } : {}),
        ...(rawArgs.folder ? { folder: rawArgs.folder } : {}),
        ...(rawArgs.after ? { after: rawArgs.after } : {}),
        ...(rawArgs.before ? { before: rawArgs.before } : {}),
        ...(typeof rawArgs.is_unread === 'boolean' ? { is_unread: rawArgs.is_unread } : {}),
        ...(typeof rawArgs.has_attachment === 'boolean'
          ? { has_attachment: rawArgs.has_attachment }
          : {}),
      },
      ...(rawArgs.text_query ? { text_query: rawArgs.text_query } : {}),
    };

    let query;
    try {
      query = validateSearchQuery(dslShape);
    } catch (err) {
      throw new ToolError('bad_args', err instanceof Error ? err.message : String(err));
    }

    const mergedFilters = mergeScopedFilters(ctx.scope, query.filters ?? {});
    const limit = Math.min(
      Math.max(typeof rawArgs.limit === 'number' ? rawArgs.limit : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    // Candidate fetch: folder-scoped if a folder filter is present, else account-wide.
    const account = ctx.scope.account;
    const candidates = (
      mergedFilters.folder
        ? await dbClient.messages
            .where('[account+folder]')
            .equals([account, mergedFilters.folder])
            .toArray()
        : await dbClient.messages.where('account').equals(account).toArray()
    ) as Message[];

    const afterMs = mergedFilters.after ? Date.parse(mergedFilters.after) : null;
    const beforeMs = mergedFilters.before ? Date.parse(mergedFilters.before) : null;

    const fromMatchers = (mergedFilters.from ?? []).map((f) => f.toLowerCase());
    const subjectMatchers = (mergedFilters.subject_contains ?? []).map((s) => s.toLowerCase());
    const textMatch = query.text_query?.trim().toLowerCase() ?? '';

    const filtered = candidates.filter((m) => {
      if (mergedFilters.is_unread === true && !m.is_unread) return false;
      if (mergedFilters.is_unread === false && m.is_unread) return false;
      if (mergedFilters.has_attachment === true && !m.has_attachment) return false;
      if (typeof m.date === 'number') {
        if (afterMs !== null && m.date < afterMs) return false;
        if (beforeMs !== null && m.date > beforeMs) return false;
      }
      if (fromMatchers.length > 0) {
        const from = (m.from ?? '').toLowerCase();
        if (!fromMatchers.some((f) => from.includes(f))) return false;
      }
      if (subjectMatchers.length > 0) {
        const subject = (m.subject ?? '').toLowerCase();
        if (!subjectMatchers.some((s) => subject.includes(s))) return false;
      }
      if (textMatch) {
        const subject = (m.subject ?? '').toLowerCase();
        const snippet = (m.snippet ?? '').toLowerCase();
        if (!subject.includes(textMatch) && !snippet.includes(textMatch)) return false;
      }
      return true;
    });

    // Belt-and-suspenders scope enforcement: even if the above somehow leaks,
    // enforceScope strips out-of-scope rows before they reach the model.
    const scoped = enforceScope(ctx.scope, filtered);

    scoped.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
    const page = scoped.slice(0, limit);

    const summaries = page.map((m) => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      snippet: m.snippet,
      date: m.date,
      thread_id: m.thread_id ?? m.root_id ?? null,
      folder: m.folder,
      is_unread: m.is_unread,
      has_attachment: m.has_attachment,
    }));

    return {
      data: { results: summaries, total_matches: scoped.length, limit },
      summary: `Found ${scoped.length} message${scoped.length === 1 ? '' : 's'}${
        scoped.length > limit ? ` (showing ${limit})` : ''
      }`,
    };
  },
};
