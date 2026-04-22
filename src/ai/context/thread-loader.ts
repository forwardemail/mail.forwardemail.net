/**
 * Thread Loader — fetches all messages in a thread from Dexie.
 *
 * For the `thread` scope, we pre-load the full thread so the AI sees the
 * conversation history it needs to draft or summarize. Bodies come from the
 * `messageBodies` table (separate from `messages` metadata). A thread is
 * defined by `thread_id` equality, with `root_id` as a fallback for messages
 * that only have the root reference.
 *
 * Budget: hard cap at 50 messages or ~80 KB of body text, whichever hits
 * first. Older messages are dropped (oldest first) with a marker. This keeps
 * the prompt bounded on long threads without silently losing the most recent
 * conversation.
 */

import type { Message, MessageBody } from '../../types';
import { dbClient } from '../../utils/db-worker-client.js';

const MAX_MESSAGES = 50;
const MAX_TOTAL_BYTES = 80_000;

export interface LoadedThreadMessage {
  message: Message;
  body: string;
}

export interface LoadedThread {
  messages: LoadedThreadMessage[];
  /** True when we had to drop older messages to fit the budget. */
  truncated: boolean;
  /** Number of messages that existed in the thread before budget-trimming. */
  totalAvailable: number;
}

const normalizeBody = (row: MessageBody | undefined): string => {
  if (!row) return '';
  const text = (row as { textContent?: string }).textContent;
  if (typeof text === 'string' && text.trim().length > 0) return text;
  return (row as { body?: string }).body ?? '';
};

/**
 * Return all messages sharing the seed message's thread, ordered chronologically.
 * Returns an empty array (and `totalAvailable: 0`) when the seed has no thread
 * identifier — callers fall back to `buildThreadContext` on the single message.
 */
export const loadThreadMessages = async (
  account: string,
  seed: Pick<Message, 'id' | 'thread_id' | 'root_id'>,
): Promise<LoadedThread> => {
  const threadId = seed.thread_id ?? null;
  const rootId = seed.root_id ?? null;

  if (!threadId && !rootId) {
    return { messages: [], truncated: false, totalAvailable: 0 };
  }

  // `thread_id` is not a Dexie index (see plan Appendix A). Post-filter from
  // the account candidates. For typical accounts this is bounded; for very
  // large inboxes we'll revisit with an index once benchmarks justify it.
  const candidates = (await dbClient.messages
    .where('account')
    .equals(account)
    .toArray()) as Message[];

  const inThread = candidates.filter((m) => {
    if (threadId && m.thread_id === threadId) return true;
    if (rootId && (m.thread_id === rootId || m.root_id === rootId)) return true;
    if (threadId && m.root_id === threadId) return true;
    return false;
  });

  inThread.sort((a, b) => (a.date ?? 0) - (b.date ?? 0));

  const totalAvailable = inThread.length;

  // Budget trim: keep the most recent N messages. If that still exceeds the
  // byte budget, trim from the front (oldest) until it fits. The seed message
  // and the absolute latest are always retained.
  let kept = inThread.length > MAX_MESSAGES ? inThread.slice(-MAX_MESSAGES) : inThread;
  const truncatedByCount = kept.length < inThread.length;

  const ids = kept.map((m) => [account, m.id] as [string, string]);
  const bodies = ids.length
    ? ((await dbClient.messageBodies.bulkGet(ids)) as Array<MessageBody | undefined>)
    : [];

  const loaded: LoadedThreadMessage[] = kept.map((message, i) => ({
    message,
    body: normalizeBody(bodies[i]),
  }));

  // Byte-budget trim: drop oldest first until under budget.
  let totalBytes = loaded.reduce((sum, m) => sum + m.body.length, 0);
  let truncatedByBytes = false;
  while (totalBytes > MAX_TOTAL_BYTES && loaded.length > 1) {
    const dropped = loaded.shift();
    if (dropped) {
      totalBytes -= dropped.body.length;
      truncatedByBytes = true;
    }
  }

  return {
    messages: loaded,
    truncated: truncatedByCount || truncatedByBytes,
    totalAvailable,
  };
};
