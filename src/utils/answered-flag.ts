/**
 * Marks the message a reply answers as answered (the IMAP \Answered flag):
 * in the visible list, in IndexedDB and on the server. The server is what
 * other mail clients read, so Thunderbird shows the message as replied to
 * only once the server has the flag.
 *
 * Three send paths call this: the compose form, the outbox (undo send and
 * offline sends), and main.ts for the desktop compose window.
 *
 * The server is always told, with the flag as an addition (flags_add) so it
 * changes nothing else on the message. It used to be told only when the
 * message was in IndexedDB without the flag. A message that was not there
 * (opened from search, or not cached) was never flagged on the server, and
 * neither was one whose local copy had the flag from an earlier attempt that
 * failed. A change that fails for a reason that can pass (offline, a server
 * error) is queued and retried like a star.
 */
import { markMessageAnsweredInStore } from '../stores/messageStore';
import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { isActiveAccount } from './account-scope.ts';
import { addFlagsBody } from './message-changes';
import { queueMutation } from './mutation-queue';
import { isOnline } from './network-status';
import { warn } from './logger.ts';

export const ANSWERED = '\\Answered';

// Offline, a timeout, rate limiting or a server error. A 4xx such as a
// message deleted since would only fail again.
const canRetry = (error: unknown) => {
  const status = (error as { status?: number })?.status;
  return !status || status === 408 || status === 429 || status >= 500;
};

/**
 * @param messageId - the API id of the message replied to
 * @param options.account - the account whose mailbox holds it (default: the
 *   active one)
 */
export async function markOriginalAnswered(
  messageId: string | null | undefined,
  { account }: { account?: string | null } = {},
): Promise<void> {
  if (!messageId) return;
  const id = String(messageId);
  const shownFlags = markMessageAnsweredInStore(id);
  const key = [account || Local.get('email') || 'default', id];

  let storedFlags: string[] | null = null;
  try {
    const [record] = await db.messages.where('[account+id]').equals(key).toArray();
    if (record) storedFlags = Array.isArray(record.flags) ? record.flags : [];
  } catch {
    // IndexedDB unavailable; the server is still told below.
  }

  // null when this client does not know the message's flags
  const known = storedFlags ?? shownFlags;
  const flags = known && !known.includes(ANSWERED) ? [...known, ANSWERED] : known;
  if (storedFlags && flags !== storedFlags) {
    await db.messages
      .where('[account+id]')
      .equals(key)
      .modify({ flags })
      .catch(() => {});
  }

  // Requests go out as the account on screen. The user may have switched
  // since an outbox send began; that account cannot change this message.
  if (account && !isActiveAccount(account)) return;

  const change = { messageId: id, flags, add: [ANSWERED] };
  try {
    if (!isOnline()) {
      await queueMutation('addFlags', change);
      return;
    }
    try {
      await Remote.request('MessageUpdate', addFlagsBody(flags, [ANSWERED]), {
        method: 'PUT',
        pathOverride: `/v1/messages/${encodeURIComponent(id)}`,
      });
    } catch (error) {
      if (!canRetry(error)) {
        warn('[answered-flag] The server refused \\Answered', error);
        return;
      }
      warn('[answered-flag] Setting \\Answered failed, queuing for retry', error);
      await queueMutation('addFlags', change);
    }
  } catch (error) {
    warn('[answered-flag] Could not queue \\Answered', error);
  }
}
