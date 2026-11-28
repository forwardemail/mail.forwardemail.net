import { readable, writable } from 'svelte/store';

/**
 * Executes an action when Enter or Space key is pressed
 * @param {KeyboardEvent} event - The keyboard event
 * @param {Function} action - The action to execute
 */
export const activateOnKeys = (event, action) => {
  if (event?.key === 'Enter' || event?.key === ' ') {
    event.preventDefault();
    event.stopPropagation();
    action?.();
  }
};

/**
 * Converts a value to a readable store, or creates a fallback store
 * @param {*} store - Potential store object
 * @param {*} fallback - Fallback value if store is invalid
 * @returns {Object} Readable store
 */
export const storeToStore = (store, fallback = null) =>
  store && typeof store.subscribe === 'function' ? store : readable(fallback, () => () => {});

/**
 * Converts a value to a writable store, or creates a fallback store
 * @param {*} store - Potential store object
 * @param {*} fallback - Fallback value if store is invalid
 * @returns {Object} Writable store
 */
export const storeToWritableStore = (store, fallback = null) =>
  store && typeof store.subscribe === 'function' ? store : writable(fallback);

/**
 * Chooses between two store candidates or creates a fallback readable store
 * @param {*} storeCandidate - Primary store candidate
 * @param {*} fallbackCandidate - Fallback store candidate
 * @param {*} fallback - Default fallback value
 * @returns {Object} Readable store
 */
export const chooseStore = (storeCandidate, fallbackCandidate, fallback = null) => {
  if (storeCandidate && typeof storeCandidate.subscribe === 'function') return storeCandidate;
  if (fallbackCandidate && typeof fallbackCandidate.subscribe === 'function') {
    return fallbackCandidate;
  }
  return readable(fallback, () => () => {});
};

/**
 * Chooses between two store candidates or creates a fallback writable store
 * @param {*} storeCandidate - Primary store candidate
 * @param {*} fallbackCandidate - Fallback store candidate
 * @param {*} fallback - Default fallback value
 * @returns {Object} Writable store
 */
export const chooseWritableStore = (storeCandidate, fallbackCandidate, fallback = null) => {
  if (storeCandidate && typeof storeCandidate.subscribe === 'function') return storeCandidate;
  if (fallbackCandidate && typeof fallbackCandidate.subscribe === 'function') {
    return fallbackCandidate;
  }
  return writable(fallback);
};

/**
 * Removes duplicate messages by ID
 * @param {Array} messages - Array of message objects
 * @returns {Array} Deduplicated array of messages
 */
export const dedupeMessages = (messages = []) => {
  const seen = new Set();
  return (messages || []).filter((msg) => {
    const id = msg?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/**
 * Resolves delete targets from items (handles conversations with multiple messages)
 * @param {Array} items - Array of items (messages or conversations)
 * @returns {Array} Flat array of message objects
 */
export const resolveDeleteTargets = (items = []) =>
  dedupeMessages(
    (items || []).flatMap((item) => {
      if (!item) return [];
      if (item.messages?.length) return item.messages;
      return [item];
    }),
  );

/**
 * Returns the next candidate message/conversation for selection.
 *
 * Apple Mail-style smart direction: after deleting a message, if the item
 * below is read and the item above is unread, move UP instead of down.
 * This supports users who work from the bottom of their unread list upward
 * in chronological order.
 *
 * @param {Object} options - Options object
 * @param {Array} options.list - List of conversations or messages
 * @param {boolean} options.threadingEnabled - Whether threading is enabled
 * @param {Object} options.selectedConversation - Currently selected conversation
 * @param {Object} options.selectedMessage - Currently selected message
 * @param {string} options.advance - The reader_advance setting (auto, below, above, list)
 * @returns {Object|null} Next candidate item
 */
/**
 * The selected conversation, when it is the one the reader shows. The store
 * can open a message by itself (the first one after a folder reloads, say)
 * and set only the selected message, leaving the selected conversation on an
 * older thread. Actions on "the open message" then went to that thread.
 *
 * @param {Object|null} selectedConversation - Currently selected conversation
 * @param {Object|null} selectedMessage - Message the reader shows
 * @returns {Object|null} The conversation, or null when it is another thread
 */
export const openConversation = (selectedConversation, selectedMessage) => {
  if (!selectedConversation) return null;
  const openId = selectedMessage?.id;
  if (!openId) return selectedConversation;
  if (selectedConversation.id === openId) return selectedConversation;
  const members = [
    ...(selectedConversation.messages || []),
    ...(selectedConversation.previewMessages || []),
  ];
  if (!members.length) return selectedConversation;
  return members.some((m) => m?.id === openId) ? selectedConversation : null;
};

export const nextCandidate = ({
  list = [],
  threadingEnabled = false,
  selectedConversation = null,
  selectedMessage = null,
  advance = 'auto',
}) => {
  if (!list.length) return null;
  // The reader_advance setting: 'list' opens nothing.
  if (advance === 'list') return null;
  const conversation = openConversation(selectedConversation, selectedMessage);
  let idx = -1;
  if (threadingEnabled) {
    idx = conversation ? list.findIndex((item) => item.id === conversation.id) : -1;
    // No conversation for the open message: find the row that holds it.
    if (idx === -1 && selectedMessage?.id) {
      idx = list.findIndex(
        (item) =>
          item.id === selectedMessage.id ||
          item.messages?.some?.((m) => m?.id === selectedMessage.id),
      );
    }
  } else {
    idx = list.findIndex((item) => item.id === selectedMessage?.id);
  }
  if (idx === -1) return list[0] || null;

  const below = list[idx + 1] || null;
  const above = list[idx - 1] || null;

  // A fixed direction, falling back to the other side at the end of the list.
  if (advance === 'below') return below || above;
  if (advance === 'above') return above || below;

  // If there's nothing below, go above (or null)
  if (!below) return above;
  // If there's nothing above, go below
  if (!above) return below;

  // Smart direction: if below is read and above is unread, prefer above
  const belowIsUnread = below.hasUnread || below.is_unread;
  const aboveIsUnread = above.hasUnread || above.is_unread;
  if (!belowIsUnread && aboveIsUnread) return above;

  // Default: go below (standard behavior)
  return below;
};

/**
 * Folders shown in the folder list: the top level, and the folders whose
 * parents are all expanded. A parent that is not itself a folder (deleted
 * while its subfolders stayed, as IMAP keeps them, or never created) cannot
 * be expanded, so it does not hide the folders below it.
 *
 * @param {Array<{ path?: string, level?: number }>} folders
 * @param {Set<string>} expanded - paths of the expanded folders
 */
export const getVisibleFolders = (folders = [], expanded = new Set()) => {
  const paths = new Set(folders.map((folder) => folder?.path).filter(Boolean));
  return folders.filter((folder) => {
    if ((folder?.level || 0) === 0) return true;
    const parts = (folder?.path || '').split('/');
    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join('/');
      if (paths.has(parentPath) && !expanded.has(parentPath)) return false;
    }

    return true;
  });
};
