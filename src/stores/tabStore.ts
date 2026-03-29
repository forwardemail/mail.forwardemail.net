/**
 * Tab Store — Thunderbird-style tabs for desktop
 *
 * Tab 1 is always the mailbox (folder list + message list).
 * Clicking a message opens it in a new self-contained reader tab.
 * Compose opens in a separate Tauri window (not a tab).
 *
 * No snapshot/swap — mailbox tab uses global stores directly,
 * message tabs are self-contained components with local state.
 */

import { writable, get, derived } from 'svelte/store';
import type { Writable, Readable } from 'svelte/store';
import type { Message } from '../types';

// ─── Types ───────────────────────────────────────────────────────────

export type TabType = 'mailbox' | 'message';

export interface Tab {
  id: string;
  type: TabType;
  label: string;
  closable: boolean;
  // For message tabs:
  messageId?: string;
  accountEmail?: string;
  folder?: string;
  initialMessage?: Message;
  createdAt: number;
}

// ─── Constants ───────────────────────────────────────────────────────

export const MAX_TABS = 10;

// ─── Stores ──────────────────────────────────────────────────────────

export const tabs: Writable<Tab[]> = writable([]);
export const activeTabId: Writable<string> = writable('');

/** Derived: the currently active tab object. */
export const activeTab: Readable<Tab | undefined> = derived(
  [tabs, activeTabId],
  ([$tabs, $activeTabId]) => $tabs.find((t) => t.id === $activeTabId),
);

// ─── Helpers ─────────────────────────────────────────────────────────

let tabCounter = 0;

function generateTabId(): string {
  return `tab-${Date.now()}-${++tabCounter}`;
}

function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function folderDisplayName(path: string): string {
  if (!path) return 'Inbox';
  const parts = path.split('/');
  const name = parts[parts.length - 1];
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

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Activate a tab. No store swapping — just switches the active tab ID.
 * The UI conditionally renders mailbox or message tab based on type.
 */
export function activateTab(tabId: string) {
  const currentId = get(activeTabId);
  if (tabId === currentId) return;
  const currentTabs = get(tabs);
  if (!currentTabs.find((t) => t.id === tabId)) return;
  activeTabId.set(tabId);
}

/**
 * Close a tab. Activates adjacent tab if closing the active one.
 * The mailbox tab (closable: false) cannot be closed.
 */
export function closeTab(tabId: string) {
  const currentTabs = get(tabs);
  const tab = currentTabs.find((t) => t.id === tabId);
  if (!tab || !tab.closable) return;
  if (currentTabs.length <= 1) return;

  const currentActiveId = get(activeTabId);
  const closingIndex = currentTabs.findIndex((t) => t.id === tabId);

  tabs.update((list) => list.filter((t) => t.id !== tabId));

  if (tabId === currentActiveId) {
    const remaining = get(tabs);
    const newIndex = Math.min(closingIndex, remaining.length - 1);
    if (remaining[newIndex]) {
      activateTab(remaining[newIndex].id);
    }
  }
}

/**
 * Open a message in a new reader tab. If a tab for this message already
 * exists, activate it instead of creating a duplicate.
 */
export function openMessageTab(message: Message): string | null {
  const currentTabs = get(tabs);
  if (!message?.id) return null;

  // Reuse existing tab for the same message
  const existing = currentTabs.find(
    (t) => t.type === 'message' && t.messageId === String(message.id),
  );
  if (existing) {
    activateTab(existing.id);
    return existing.id;
  }

  if (currentTabs.length >= MAX_TABS) return null;

  const tab: Tab = {
    id: generateTabId(),
    type: 'message',
    label: truncate(message.subject || '(No subject)', 30),
    closable: true,
    messageId: String(message.id),
    accountEmail: message.account || '',
    folder: message.folder || '',
    initialMessage: message,
    createdAt: Date.now(),
  };

  tabs.update((list) => [...list, tab]);
  activateTab(tab.id);
  return tab.id;
}

/**
 * Update the mailbox tab's label when the user navigates folders.
 */
export function updateMailboxTabFolder(folder: string) {
  tabs.update((list) =>
    list.map((t) => {
      if (t.type === 'mailbox') {
        return { ...t, folder, label: folderDisplayName(folder) };
      }
      return t;
    }),
  );
}

/**
 * Reset all tabs — called on account switch.
 * Creates a single mailbox tab.
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
      createdAt: Date.now(),
    },
  ]);
  activeTabId.set(id);
}

/**
 * Get the next tab ID (for Ctrl+Tab navigation).
 */
export function getNextTabId(): string | null {
  const currentTabs = get(tabs);
  const currentId = get(activeTabId);
  const idx = currentTabs.findIndex((t) => t.id === currentId);
  if (idx === -1 || currentTabs.length <= 1) return null;
  return currentTabs[(idx + 1) % currentTabs.length].id;
}

/**
 * Get the previous tab ID (for Ctrl+Shift+Tab navigation).
 */
export function getPrevTabId(): string | null {
  const currentTabs = get(tabs);
  const currentId = get(activeTabId);
  const idx = currentTabs.findIndex((t) => t.id === currentId);
  if (idx === -1 || currentTabs.length <= 1) return null;
  return currentTabs[(idx - 1 + currentTabs.length) % currentTabs.length].id;
}

/**
 * Get tab by index (for Ctrl+1 through Ctrl+9 navigation).
 */
export function getTabIdByIndex(index: number): string | null {
  const currentTabs = get(tabs);
  if (index < 0 || index >= currentTabs.length) return null;
  return currentTabs[index].id;
}

/**
 * Close all tabs except the given one (and unclosable tabs).
 */
export function closeOtherTabs(tabId: string) {
  tabs.update((list) => list.filter((t) => t.id === tabId || !t.closable));
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

  const remaining = get(tabs);
  if (!remaining.find((t) => t.id === get(activeTabId))) {
    activateTab(tabId);
  }
}
