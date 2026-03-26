import { writable, derived } from 'svelte/store';
import type { Writable, Readable } from 'svelte/store';
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

export const messages: Writable<Message[]> = writable([]);
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
