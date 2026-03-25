/**
 * Tab Store — In-app tab system for desktop power users
 *
 * Uses a snapshot/swap pattern: when switching tabs, the current tab's state
 * is snapshotted from global store singletons, and the target tab's state is
 * restored into those same singletons. This mirrors the existing
 * performAccountSwitch pattern in mailboxActions.ts.
 */

import { writable, get } from 'svelte/store';
import type { Writable } from 'svelte/store';
import { tick } from 'svelte';
import { selectedFolder } from './folderStore';
import {
  messages,
  selectedMessage,
  searchResults,
  searchActive,
  page,
  hasNextPage,
  messageBody,
  attachments,
  messageLoading,
} from './messageStore';
import {
  sortOrder,
  query,
  unreadOnly,
  hasAttachmentsOnly,
  filterByLabel,
  starredOnly,
  showFilters,
} from './viewStore';
import type { SortOrderValue } from './viewStore';
import type { Message, Attachment } from '../types';

// ─── Types ───────────────────────────────────────────────────────────

export type TabType = 'mailbox' | 'message' | 'compose';

export interface TabSnapshot {
  // folderStore
  selectedFolder: string;
  // messageStore
  messages: Message[];
  selectedMessage: Message | null;
  searchResults: Message[];
  searchActive: boolean;
  page: number;
  hasNextPage: boolean;
  messageBody: string;
  attachments: Attachment[];
  messageLoading: boolean;
  // viewStore
  sortOrder: SortOrderValue;
  query: string;
  unreadOnly: boolean;
  hasAttachmentsOnly: boolean;
  filterByLabel: string[];
  starredOnly: boolean;
  showFilters: boolean;
  // conversationStore (via mailboxStore.state)
  selectedConversationIds: string[];
  // UI
  scrollPosition: number;
}

export interface Tab {
  id: string;
  type: TabType;
  label: string;
  closable: boolean;
  folder?: string;
  messageId?: string;
  messageSubject?: string;
  snapshot: TabSnapshot;
  createdAt: number;
}

// ─── Constants ───────────────────────────────────────────────────────

export const MAX_TABS = 10;

const SCROLL_SELECTOR = '.fe-message-list-wrapper';

// ─── Stores ──────────────────────────────────────────────────────────

export const tabs: Writable<Tab[]> = writable([]);
export const activeTabId: Writable<string> = writable('');

// ─── External hooks (set by main.ts / mailboxActions) ────────────────

let incrementLoadGenerationFn: (() => void) | null = null;
let selectedConversationIdsStore: Writable<string[]> | null = null;
let loadMessagesFn: (() => void) | null = null;

export function setLoadGenerationHook(fn: () => void) {
  incrementLoadGenerationFn = fn;
}

export function setConversationIdsStore(store: Writable<string[]>) {
  selectedConversationIdsStore = store;
}

export function setLoadMessagesHook(fn: () => void) {
  loadMessagesFn = fn;
}

// ─── Helpers ─────────────────────────────────────────────────────────

let tabCounter = 0;

function generateTabId(): string {
  return `tab-${Date.now()}-${++tabCounter}`;
}

function createDefaultSnapshot(folder: string = 'INBOX'): TabSnapshot {
  return {
    selectedFolder: folder,
    messages: [],
    selectedMessage: null,
    searchResults: [],
    searchActive: false,
    page: 1,
    hasNextPage: false,
    messageBody: '',
    attachments: [],
    messageLoading: false,
    sortOrder: 'newest',
    query: '',
    unreadOnly: false,
    hasAttachmentsOnly: false,
    filterByLabel: [],
    starredOnly: false,
    showFilters: false,
    selectedConversationIds: [],
    scrollPosition: 0,
  };
}

function readCurrentSnapshot(): TabSnapshot {
  const scrollEl = document.querySelector(SCROLL_SELECTOR);
  return {
    selectedFolder: get(selectedFolder),
    messages: get(messages),
    selectedMessage: get(selectedMessage),
    searchResults: get(searchResults),
    searchActive: get(searchActive),
    page: get(page),
    hasNextPage: get(hasNextPage),
    messageBody: get(messageBody),
    attachments: get(attachments),
    messageLoading: get(messageLoading),
    sortOrder: get(sortOrder),
    query: get(query),
    unreadOnly: get(unreadOnly),
    hasAttachmentsOnly: get(hasAttachmentsOnly),
    filterByLabel: get(filterByLabel),
    starredOnly: get(starredOnly),
    showFilters: get(showFilters),
    selectedConversationIds: selectedConversationIdsStore ? get(selectedConversationIdsStore) : [],
    scrollPosition: scrollEl ? scrollEl.scrollTop : 0,
  };
}

function writeSnapshot(snap: TabSnapshot) {
  selectedFolder.set(snap.selectedFolder);
  messages.set(snap.messages);
  selectedMessage.set(snap.selectedMessage);
  searchResults.set(snap.searchResults);
  searchActive.set(snap.searchActive);
  page.set(snap.page);
  hasNextPage.set(snap.hasNextPage);
  messageBody.set(snap.messageBody);
  attachments.set(snap.attachments);
  messageLoading.set(snap.messageLoading);
  sortOrder.set(snap.sortOrder);
  query.set(snap.query);
  unreadOnly.set(snap.unreadOnly);
  hasAttachmentsOnly.set(snap.hasAttachmentsOnly);
  filterByLabel.set(snap.filterByLabel);
  starredOnly.set(snap.starredOnly);
  showFilters.set(snap.showFilters);
  if (selectedConversationIdsStore) {
    selectedConversationIdsStore.set(snap.selectedConversationIds);
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Snapshot the current active tab's state from global stores.
 */
export function snapshotCurrentTab() {
  const currentId = get(activeTabId);
  if (!currentId) return;

  const snap = readCurrentSnapshot();
  tabs.update((list) =>
    list.map((t) => {
      if (t.id === currentId) {
        return { ...t, snapshot: snap, folder: snap.selectedFolder };
      }
      return t;
    }),
  );
}

/**
 * Create a new tab. Returns the new tab's ID.
 */
export function createTab(
  type: TabType,
  options: {
    folder?: string;
    closable?: boolean;
    label?: string;
    messageId?: string;
    messageSubject?: string;
    activate?: boolean;
  } = {},
): string | null {
  const currentTabs = get(tabs);
  if (currentTabs.length >= MAX_TABS) return null;

  const folder = options.folder || get(selectedFolder) || 'INBOX';
  const label = options.label || folderDisplayName(folder);

  // For new mailbox tabs, snapshot current state as starting point
  // so the new tab inherits the current folder's messages
  const snapshot =
    type === 'mailbox' && options.activate !== false
      ? { ...readCurrentSnapshot(), selectedFolder: folder }
      : createDefaultSnapshot(folder);

  // If the new tab is for a different folder than current, use a clean snapshot
  if (type === 'mailbox' && folder !== get(selectedFolder)) {
    Object.assign(snapshot, createDefaultSnapshot(folder));
  }

  const tab: Tab = {
    id: generateTabId(),
    type,
    label,
    closable: options.closable !== undefined ? options.closable : true,
    folder,
    messageId: options.messageId,
    messageSubject: options.messageSubject,
    snapshot,
    createdAt: Date.now(),
  };

  tabs.update((list) => [...list, tab]);

  if (options.activate !== false) {
    activateTab(tab.id);
  }

  return tab.id;
}

/**
 * Close a tab. Activates adjacent tab if closing the active one.
 */
export function closeTab(tabId: string) {
  const currentTabs = get(tabs);
  const tab = currentTabs.find((t) => t.id === tabId);
  if (!tab || !tab.closable) return;
  if (currentTabs.length <= 1) return;

  const currentActiveId = get(activeTabId);
  const closingIndex = currentTabs.findIndex((t) => t.id === tabId);

  tabs.update((list) => list.filter((t) => t.id !== tabId));

  // If we closed the active tab, activate the nearest neighbor
  if (tabId === currentActiveId) {
    const remaining = get(tabs);
    const newIndex = Math.min(closingIndex, remaining.length - 1);
    if (remaining[newIndex]) {
      activateTab(remaining[newIndex].id);
    }
  }
}

/**
 * Activate a tab — core function. Snapshots current tab, restores target tab.
 */
export function activateTab(tabId: string) {
  const currentActiveId = get(activeTabId);
  if (tabId === currentActiveId) return;

  const currentTabs = get(tabs);
  const targetTab = currentTabs.find((t) => t.id === tabId);
  if (!targetTab) return;

  // Snapshot current tab before switching
  if (currentActiveId) {
    snapshotCurrentTab();
  }

  // Discard in-flight API responses for previous tab
  if (incrementLoadGenerationFn) {
    incrementLoadGenerationFn();
  }

  // Switch active tab
  activeTabId.set(tabId);

  // Restore target tab's state into global stores
  writeSnapshot(targetTab.snapshot);

  // If the tab has no messages yet (e.g., newly created for a different folder),
  // trigger a message load so the user doesn't see an empty list.
  const needsLoad =
    targetTab.snapshot.selectedFolder &&
    targetTab.snapshot.messages.length === 0 &&
    !targetTab.snapshot.searchActive;
  if (needsLoad && loadMessagesFn) {
    loadMessagesFn();
  }

  // Restore scroll position after DOM update
  tick().then(() => {
    const scrollEl = document.querySelector(SCROLL_SELECTOR);
    if (scrollEl) {
      scrollEl.scrollTop = targetTab.snapshot.scrollPosition;
    }
  });
}

/**
 * Update a tab's display label.
 */
export function updateTabLabel(tabId: string, label: string) {
  tabs.update((list) =>
    list.map((t) => {
      if (t.id === tabId) {
        return { ...t, label };
      }
      return t;
    }),
  );
}

/**
 * Update the active tab's folder reference (used when navigating folders).
 */
export function updateActiveTabFolder(folder: string) {
  const currentId = get(activeTabId);
  if (!currentId) return;
  tabs.update((list) =>
    list.map((t) => {
      if (t.id === currentId) {
        return { ...t, folder, label: folderDisplayName(folder) };
      }
      return t;
    }),
  );
}

/**
 * Reset all tabs — called on account switch.
 */
export function resetTabs(defaultFolder: string = 'INBOX') {
  tabCounter = 0;
  const id = generateTabId();
  tabs.set([
    {
      id,
      type: 'mailbox',
      label: folderDisplayName(defaultFolder),
      closable: false,
      folder: defaultFolder,
      snapshot: createDefaultSnapshot(defaultFolder),
      createdAt: Date.now(),
    },
  ]);
  activeTabId.set(id);
}

/**
 * Get the next tab ID (for Cmd+Tab navigation).
 */
export function getNextTabId(): string | null {
  const currentTabs = get(tabs);
  const currentId = get(activeTabId);
  const idx = currentTabs.findIndex((t) => t.id === currentId);
  if (idx === -1 || currentTabs.length <= 1) return null;
  return currentTabs[(idx + 1) % currentTabs.length].id;
}

/**
 * Get the previous tab ID (for Cmd+Shift+Tab navigation).
 */
export function getPrevTabId(): string | null {
  const currentTabs = get(tabs);
  const currentId = get(activeTabId);
  const idx = currentTabs.findIndex((t) => t.id === currentId);
  if (idx === -1 || currentTabs.length <= 1) return null;
  return currentTabs[(idx - 1 + currentTabs.length) % currentTabs.length].id;
}

/**
 * Get tab by index (for Cmd+1 through Cmd+9 navigation).
 */
export function getTabIdByIndex(index: number): string | null {
  const currentTabs = get(tabs);
  if (index < 0 || index >= currentTabs.length) return null;
  return currentTabs[index].id;
}

/**
 * Duplicate a tab — creates a copy of the given tab's state.
 */
export function duplicateTab(tabId: string): string | null {
  const currentTabs = get(tabs);
  if (currentTabs.length >= MAX_TABS) return null;

  const source = currentTabs.find((t) => t.id === tabId);
  if (!source) return null;

  // If duplicating the active tab, snapshot first to get latest state
  if (tabId === get(activeTabId)) {
    snapshotCurrentTab();
  }

  const freshSource = get(tabs).find((t) => t.id === tabId);
  if (!freshSource) return null;

  const newTab: Tab = {
    id: generateTabId(),
    type: freshSource.type,
    label: freshSource.label,
    closable: true,
    folder: freshSource.folder,
    messageId: freshSource.messageId,
    messageSubject: freshSource.messageSubject,
    snapshot: { ...freshSource.snapshot },
    createdAt: Date.now(),
  };

  // Insert after source tab
  const sourceIdx = get(tabs).findIndex((t) => t.id === tabId);
  tabs.update((list) => {
    const copy = [...list];
    copy.splice(sourceIdx + 1, 0, newTab);
    return copy;
  });

  return newTab.id;
}

/**
 * Close all tabs except the given one.
 */
export function closeOtherTabs(tabId: string) {
  tabs.update((list) => list.filter((t) => t.id === tabId || !t.closable));
  // Ensure the kept tab is active
  if (get(activeTabId) !== tabId) {
    activateTab(tabId);
  }
}

/**
 * Close all tabs to the right of the given one.
 */
export function closeTabsToRight(tabId: string) {
  const currentTabs = get(tabs);
  const idx = currentTabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  tabs.update((list) => list.filter((t, i) => i <= idx || !t.closable));

  // If active tab was to the right, switch to the target tab
  const remaining = get(tabs);
  if (!remaining.find((t) => t.id === get(activeTabId))) {
    activateTab(tabId);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────

function folderDisplayName(path: string): string {
  if (!path) return 'New Tab';
  // Show the last segment for nested folders, e.g., "Work/Projects" → "Projects"
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  // Capitalize common folder names
  const map: Record<string, string> = {
    INBOX: 'Inbox',
    Drafts: 'Drafts',
    Sent: 'Sent',
    Trash: 'Trash',
    Spam: 'Spam',
    Archive: 'Archive',
    Junk: 'Junk',
  };
  return map[name] || name;
}
