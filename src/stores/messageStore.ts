import { writable, derived } from 'svelte/store';
import type { Writable, Readable } from 'svelte/store';
import { deferredWritable } from '../utils/deferred-store';
import { shallowArrayEqual } from '../utils/store-utils.ts';
import { sortMessages } from '../utils/message-sort.ts';
import { selectedFolder } from './folderStore';
import {
  query,
  unreadOnly,
  hasAttachmentsOnly,
  filterByLabel,
  starredOnly,
  sortOrder,
} from './viewStore';
import type { Message, Attachment } from '../types';

// Use deferredWritable so that any .set() call that shrinks the array
// (i.e. removes messages from the list) is automatically routed through
// requestAnimationFrame.  This prevents a WebKit use-after-free crash on
// macOS 26+ where synchronous DOM node removal races with the webview
// compositor's dispatchSetObscuredContentInsets.  See deferred-store.ts.
export const messages = deferredWritable<Message[]>([]);

/**
 * Optimistically flag a message as replied-to in the in-memory list so the
 * reply indicator appears immediately. The reply paths already persist
 * `\Answered` to IndexedDB and the server, but the row renders from this
 * in-memory list, which otherwise doesn't reflect the flag until the folder
 * is reloaded. That reload gap is why the indicator only showed "sometimes".
 */
export function markMessageAnsweredInStore(messageId: string | null | undefined): void {
  if (!messageId) return;
  const target = String(messageId);
  let nextFlags: string[] | null = null;
  messages.update((list) =>
    (list || []).map((m) => {
      if (String(m?.id) !== target) return m;
      const flags = Array.isArray(m.flags) ? m.flags : [];
      const withAnswered = flags.includes('\\Answered') ? flags : [...flags, '\\Answered'];
      nextFlags = withAnswered;
      if (flags.includes('\\Answered') && m.is_answered) return m;
      return { ...m, flags: withAnswered, is_answered: true };
    }),
  );
  if (answeredFlagHook) {
    try {
      answeredFlagHook(target, nextFlags);
    } catch {
      // The hook only protects the optimistic state; never let it break a send.
    }
  }
}

type AnsweredFlagHook = (messageId: string, flags: string[] | null) => void;
let answeredFlagHook: AnsweredFlagHook | null = null;

/**
 * Registered by mailboxStore so the optimistic \Answered flag is re-applied on
 * top of the list reload that follows every send. Without it, loadMessages()
 * replaced the in-memory list a moment after markMessageAnsweredInStore and
 * the indicator vanished until the server echoed the flag. `flags` is the
 * message's full flag list when it was on screen, null when it was not (the
 * hook then registers only is_answered so it cannot clobber unknown flags).
 */
export function setAnsweredFlagHook(hook: AnsweredFlagHook | null): void {
  answeredFlagHook = hook;
}

export const selectedMessage: Writable<Message | null> = writable(null);
export const searchResults: Writable<Message[]> = writable([]);
export const searchActive: Writable<boolean> = writable(false);
export const searching: Writable<boolean> = writable(false);
export const loading: Writable<boolean> = writable(true);
export const page: Writable<number> = writable(1);
export const hasNextPage: Writable<boolean> = writable(false);
export const messageBody: Writable<string> = writable('');
export const attachments: Writable<Attachment[]> = writable([]);
export const messageLoading: Writable<boolean> = writable(false);

let lastFilteredMessages: Message[] = [];

export const filteredMessages: Readable<Message[]> = derived(
  [
    messages,
    searchResults,
    selectedFolder,
    query,
    unreadOnly,
    hasAttachmentsOnly,
    filterByLabel,
    starredOnly,
    searchActive,
    sortOrder,
  ],
  ([
    $messages,
    $searchResults,
    $selectedFolder,
    $query,
    $unreadOnly,
    $hasAttachmentsOnly,
    $filterByLabel,
    $starredOnly,
    $searchActive,
    $sortOrder,
  ]) => {
    const selectedUpper = $selectedFolder?.toUpperCase();
    const base = $searchActive
      ? ($searchResults || []).filter(
          (m) => !$selectedFolder || m.folder?.toUpperCase() === selectedUpper,
        )
      : ($messages || []).filter((m) => m.folder?.toUpperCase() === selectedUpper);
    let list = base;
    if ($unreadOnly) list = list.filter((m) => m.is_unread);
    if ($hasAttachmentsOnly) list = list.filter((m) => m.has_attachment);
    if ($filterByLabel && $filterByLabel.length > 0) {
      list = list.filter((m) => {
        const messageLabels = m.labels || [];
        const normalizedLabels = messageLabels.map((l) => String(l));
        return $filterByLabel.some((labelId) => normalizedLabels.includes(String(labelId)));
      });
    }
    if ($starredOnly) {
      list = list.filter((m) => m.is_starred || (m.flags || []).includes('\\Flagged'));
    }
    if ($query && !$searchActive) {
      const q = $query.toLowerCase();
      list = list.filter(
        (m) =>
          m.subject?.toLowerCase().includes(q) ||
          m.from?.toLowerCase().includes(q) ||
          m.snippet?.toLowerCase().includes(q),
      );
    }
    const sorted = sortMessages(list, $sortOrder) as Message[];

    if (shallowArrayEqual(sorted, lastFilteredMessages)) {
      return lastFilteredMessages;
    }

    lastFilteredMessages = sorted;
    return sorted;
  },
);
