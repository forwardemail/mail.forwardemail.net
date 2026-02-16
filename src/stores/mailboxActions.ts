import { writable, derived, get } from 'svelte/store';
import Dexie from 'dexie';
import { Remote } from '../utils/remote';
import { Local, Accounts } from '../utils/storage';
import { db } from '../utils/db';
import { mailboxStore } from './mailboxStore';
import { searchStore } from './searchStore';
import {
  syncSettings,
  clearSettings,
  applySettings,
  createLabel as createSettingsLabel,
  updateLabel as updateSettingsLabel,
  deleteLabel as deleteSettingsLabel,
  settingsActions,
  bodyIndexing,
  loadProfileName,
  loadProfileImage,
  settingsLabels,
  fetchAccountData,
  effectiveLayoutMode,
  setSettingValue,
} from './settingsStore';
import { normalizeLayoutMode } from './settingsRegistry';
import { getMessageApiId } from '../utils/sync-helpers';
import { startInitialSync, queueBodiesForFolder } from '../utils/sync-controller';
import { resetSyncWorkerReady } from '../utils/sync-worker-client.js';
import { clearMailServiceState } from './mailService';
import { normalizeEmail, dedupeAddresses, extractAddressList } from '../utils/address.ts';
import { validateLabelName } from '../utils/label-validation.ts';
import { resolveSearchBodyIndexing } from '../utils/search-body-indexing.js';
import { LABEL_PALETTE } from '../utils/labels.js';
import { queueMutation } from '../utils/mutation-queue';
import { config } from '../config';
import { createInboxUpdater } from '../utils/inbox-poller';
import { warn } from '../utils/logger.ts';

/**
 * Additional mailbox actions that were in MailboxView
 * These complement the core actions in mailboxStore
 */

// Additional state stores
export const storageUsed = writable(0);
export const storageTotal = writable(0);
export const localUsage = writable(0);
export const localQuota = writable(0);
export const indexCount = writable(0);
export const indexSize = writable(0);
export const syncPending = writable(0);

// Sync progress state
export const syncProgress = writable({
  active: false,
  stage: '', // 'metadata' | 'bodies'
  folder: '',
  current: 0,
  total: 0,
  message: '',
});
export const initialSyncStarted = writable(false);

// Index progress state
export const indexProgress = writable({
  active: false,
  current: 0,
  total: 0,
  message: '',
});

export const bodyIndexingEnabled = writable(resolveSearchBodyIndexing());
export const accounts = writable([]);
export const currentAccount = writable(Local.get('email') || '');
export const accountMenuOpen = writable(false);
export const mobileReader = writable(false);
export const bulkMoveOpen = writable(false);
export const availableMoveTargets = writable([]);
export const availableLabels = writable([]);
export const selectedConversation = writable(null);
export const starredOnly = mailboxStore.state.starredOnly;
export const layoutMode = derived(effectiveLayoutMode, ($mode) => normalizeLayoutMode($mode));

// Navigation reference (set by main.js)
let navigateRef = null;
export const setNavigate = (fn) => {
  navigateRef = fn;
};

// Toast reference (set by main.js)
let toastsRef = null;
export const setToasts = (toasts) => {
  toastsRef = toasts;
};
let missingMessageIdToastShown = false;
const showMissingMessageIdToast = (action) => {
  if (missingMessageIdToastShown) return;
  toastsRef?.show?.(`Unable to ${action}: missing server message id.`, 'error');
  missingMessageIdToastShown = true;
};

let loadPromise = null;
let loadAccount = null;
let loadGeneration = 0;
let inboxUpdater = null;

// Compose modal reference (set by main.js)
let composeModalRef = null;
export const setComposeModal = (modal) => {
  composeModalRef = modal;
};

const getUserEmails = () => {
  const emails = new Set();
  const primary = Local.get('email');
  if (primary) emails.add(normalizeEmail(primary));

  const aliasAuth = Local.get('alias_auth');
  if (aliasAuth && aliasAuth.includes(':')) {
    emails.add(normalizeEmail(aliasAuth.split(':')[0]));
  }

  const acctList = get(accounts) || [];
  acctList.forEach((acct) => {
    if (acct?.email) emails.add(normalizeEmail(acct.email));
  });

  return emails;
};

export const computeReplyTargets = (msg = {}, options = {}) => {
  const { replyAll = false } = options;
  const selfEmails = getUserEmails();
  const isSelf = (addr) => selfEmails.has(normalizeEmail(addr));

  const replyToList = extractAddressList(msg, 'replyTo').length
    ? extractAddressList(msg, 'replyTo')
    : extractAddressList(msg, 'reply_to');
  const fromList = extractAddressList(msg, 'from');
  const toList = extractAddressList(msg, 'to').length
    ? extractAddressList(msg, 'to')
    : extractAddressList(msg, 'recipients');
  const ccList = extractAddressList(msg, 'cc');

  const nonMeReplyTo = replyToList.filter((a) => !isSelf(a));
  const nonMeFrom = fromList.filter((a) => !isSelf(a));
  const nonMeTo = toList.filter((a) => !isSelf(a));
  const nonMeCc = ccList.filter((a) => !isSelf(a));

  // For simple reply, prioritize the sender (FROM/Reply-To), not the TO recipients
  const pickReplyAnchor = () =>
    nonMeReplyTo[0] || replyToList[0] || nonMeFrom[0] || fromList[0] || nonMeTo[0] || toList[0];

  let toRecipients = [];
  if (replyAll) {
    // Step 1: Add the sender (prefer reply-to, fallback to from)
    if (nonMeReplyTo.length) {
      toRecipients.push(...nonMeReplyTo);
    } else if (nonMeFrom.length) {
      toRecipients.push(...nonMeFrom);
    }

    // Step 2: Add all non-self TO recipients
    toRecipients.push(...nonMeTo);
  } else {
    // For simple reply, always include the anchor (even if it's yourself)
    const anchor = pickReplyAnchor();
    if (anchor) toRecipients = [anchor];
  }

  // For reply all, include non-self CC only
  let ccRecipients = replyAll ? dedupeAddresses(nonMeCc) : [];

  return {
    to: dedupeAddresses(toRecipients),
    cc: ccRecipients,
    anchor: pickReplyAnchor() || '',
  };
};

export const setLayoutMode = (mode) => {
  return setSettingValue('layout_mode', mode, { account: Local.get('email') || 'default' });
};

/**
 * Load initial mailbox data
 */
export const load = async () => {
  const nextAccount = Local.get('email') || 'default';
  initialSyncStarted.set(true);
  if (loadPromise && loadAccount === nextAccount) {
    return loadPromise;
  }
  const thisGeneration = ++loadGeneration;
  loadAccount = nextAccount;
  loadPromise = (async () => {
    await loadAccounts();
    if (thisGeneration !== loadGeneration) return;

    // Sync settings in background — don't block the load chain on network.
    // Cache is applied synchronously by fetchSettings(); the network refresh
    // updates stores when it arrives but doesn't gate folder/message display.
    const settingsPromise = syncSettings().catch((err) => {
      warn('syncSettings background refresh failed', err);
    });

    // loadFolders must complete before loadMessages (sets selectedFolder)
    const foldersResult = await mailboxStore.actions.loadFolders().then(
      () => ({ status: 'fulfilled' }),
      (err) => ({ status: 'rejected', reason: err }),
    );
    if (thisGeneration !== loadGeneration) return;

    // If loadFolders() failed and we have no folders, bail with error state
    if (foldersResult.status === 'rejected') {
      const hasFolders = get(mailboxStore.state.folders)?.length > 0;
      if (!hasFolders) {
        mailboxStore.state.loading.set(false);
        mailboxStore.state.error.set('Failed to load folders. Please try again.');
        warn('load() bailing: loadFolders failed with no cached folders', foldersResult.reason);
        return;
      }
      warn('loadFolders failed but using cached folders', foldersResult.reason);
    }

    const bodyIndexingValue = get(bodyIndexing);
    bodyIndexingEnabled.set(Boolean(bodyIndexingValue));
    searchStore.actions.setIncludeBody(Boolean(bodyIndexingValue)).catch(() => {});

    // Run loadLabels and loadMessages in parallel — labels only affect the
    // filter dropdown, not message rendering. No reason to serialize them.
    await Promise.all([loadLabels(), mailboxStore.actions.loadMessages()]);
    if (thisGeneration !== loadGeneration) return;

    // Incrementally index any new labels from the freshly loaded messages
    const loadedMsgs = get(mailboxStore.state.messages) || [];
    mergeNewLabels(loadedMsgs, nextAccount).catch(() => {});

    const folders = get(mailboxStore.state.folders) || [];
    if (folders.length) {
      startInitialSync(nextAccount, folders, { wantBodies: false });
      queueBodiesForFolder('INBOX', nextAccount, { bodyLimit: 100 });
    }

    // Start polling for INBOX updates (replaces commented-out AUTO_SYNC_INTERVAL)
    if (inboxUpdater) inboxUpdater.destroy();
    inboxUpdater = createInboxUpdater();
    inboxUpdater.start();

    updateStorageStats(nextAccount);

    // Prefetch adjacent accounts' INBOX in the SW background
    prefetchAdjacentAccounts(nextAccount);

    // Ensure settings network refresh finishes (best effort, non-blocking for UI)
    await settingsPromise;
  })();
  try {
    return await loadPromise;
  } finally {
    if (loadPromise && loadAccount === nextAccount) {
      loadPromise = null;
      loadAccount = null;
    }
  }
};

/**
 * Prefetch adjacent accounts' INBOX via the service worker.
 * Runs after the active account finishes loading so the SW can
 * cache the first page of metadata for instant account switching.
 */
function prefetchAdjacentAccounts(activeAccount) {
  if (!navigator.onLine || !('serviceWorker' in navigator)) return;
  const allAccounts = Accounts.getAll();
  if (allAccounts.length <= 1) return;

  // Delay prefetch to avoid competing with the active account's initial sync
  setTimeout(async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      for (const acct of allAccounts) {
        if (acct.email === activeAccount) continue;
        const authToken = acct.aliasAuth || (acct.apiKey ? `${acct.apiKey}:` : '');
        if (!authToken) continue;
        reg.active?.postMessage({
          type: 'startSync',
          accountId: acct.email,
          folderId: 'INBOX',
          apiBase: config.apiBase,
          authToken,
          pageSize: 50,
          maxMessages: 50,
          fetchBodies: false,
        });
      }
    } catch (err) {
      warn('[prefetchAdjacentAccounts] failed', err);
    }
  }, 5000);
}

/**
 * Toggle read/unread status for a message
 */
export const toggleRead = async (msg) => {
  if (!msg?.id) return;

  const isUnread = msg.is_unread;
  const newFlags = isUnread
    ? [...(msg.flags || []), '\\Seen']
    : (msg.flags || []).filter((f) => f !== '\\Seen');

  // Optimistic update
  const messages = get(mailboxStore.state.messages);
  const nextUnread = !isUnread;
  mailboxStore.state.messages.set(
    messages.map((m) =>
      m.id === msg.id
        ? { ...m, is_unread: nextUnread, is_unread_index: nextUnread ? 1 : 0, flags: newFlags }
        : m,
    ),
  );

  const apiId = getMessageApiId(msg);
  if (!apiId) {
    warn('toggleRead failed: missing message id');
    mailboxStore.state.messages.set(messages);
    showMissingMessageIdToast('update read status');
    return;
  }

  // Update IDB cache immediately (optimistic)
  const account = Local.get('email') || 'default';
  await db.messages
    .where('[account+id]')
    .equals([account, msg.id])
    .modify({ is_unread: nextUnread, is_unread_index: nextUnread ? 1 : 0, flags: newFlags })
    .catch(() => {});

  mailboxStore.actions.updateFolderUnreadCounts();

  // Sync to server or queue for later
  const mutationPayload = {
    messageId: apiId,
    isUnread: isUnread,
    flags: msg.flags || [],
    folder: msg.folder,
  };

  if (!navigator.onLine) {
    await queueMutation('toggleRead', mutationPayload);
    return;
  }

  try {
    await Remote.request(
      'MessageUpdate',
      { flags: newFlags, folder: msg.folder },
      { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(apiId)}` },
    );
  } catch (err) {
    warn('toggleRead failed, queuing for retry', err);
    await queueMutation('toggleRead', mutationPayload);
  }
};

/**
 * Toggle star/flag on a message
 */
export const toggleStar = async (msg) => {
  if (!msg?.id) return;

  const isStarred = msg.is_starred || (msg.flags || []).includes('\\Flagged');
  const newFlags = new Set(msg.flags || []);

  if (isStarred) {
    newFlags.delete('\\Flagged');
  } else {
    newFlags.add('\\Flagged');
  }

  // Optimistic update in message list and selected message
  const messages = get(mailboxStore.state.messages);
  mailboxStore.state.messages.set(
    messages.map((m) =>
      m.id === msg.id ? { ...m, is_starred: !isStarred, flags: Array.from(newFlags) } : m,
    ),
  );
  const currentSelected = get(mailboxStore.state.selectedMessage);
  if (currentSelected?.id === msg.id) {
    mailboxStore.state.selectedMessage.set({
      ...currentSelected,
      is_starred: !isStarred,
      flags: Array.from(newFlags),
    });
  }

  const apiId = getMessageApiId(msg);
  if (!apiId) {
    warn('toggleStar failed: missing message id');
    mailboxStore.state.messages.set(messages);
    if (currentSelected?.id === msg.id) {
      mailboxStore.state.selectedMessage.set(currentSelected);
    }
    showMissingMessageIdToast('update star');
    return;
  }

  // Update IDB cache immediately (optimistic)
  const account = Local.get('email') || 'default';
  await db.messages
    .where('[account+id]')
    .equals([account, msg.id])
    .modify({ flags: Array.from(newFlags), is_starred: !isStarred })
    .catch(() => {});

  // Sync to server or queue for later
  const mutationPayload = {
    messageId: apiId,
    isStarred: isStarred,
    flags: msg.flags || [],
    folder: msg.folder,
  };

  if (!navigator.onLine) {
    await queueMutation('toggleStar', mutationPayload);
    return;
  }

  try {
    await Remote.request(
      'MessageUpdate',
      { flags: Array.from(newFlags), folder: msg.folder },
      { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(apiId)}` },
    );
  } catch (err) {
    warn('toggleStar failed, queuing for retry', err);
    await queueMutation('toggleStar', mutationPayload);
  }
};

/**
 * Archive a message
 */
export const archiveMessage = async (msg) => {
  return mailboxStore.actions.archiveMessage(msg);
};

/**
 * Delete a message
 */
export const deleteMessage = async (msg, options) => {
  return mailboxStore.actions.deleteMessage(msg, options);
};

/**
 * Validate and sanitize cached body content
 * Returns sanitized content or empty string if content is corrupted
 */
const validateCachedBody = (content) => {
  if (!content || typeof content !== 'string') return '';

  // Check for escaped HTML entities that indicate corrupted cache
  // This happens when HTML was double-encoded or stored incorrectly
  const hasEscapedHtml = /&lt;[a-zA-Z/]|&gt;|&amp;lt;|&amp;gt;/.test(content);

  if (hasEscapedHtml) {
    warn('[validateCachedBody] Detected escaped HTML in cached body, attempting to fix');
    try {
      // Attempt to unescape the content
      const textarea = typeof document !== 'undefined' ? document.createElement('textarea') : null;
      if (textarea) {
        textarea.innerHTML = content;
        const unescaped = textarea.value;
        // Check if unescaping produced valid HTML
        if (unescaped && !/&lt;[a-zA-Z/]|&gt;/.test(unescaped)) {
          return unescaped;
        }
      }
    } catch {
      // If unescaping fails, return empty to trigger re-fetch
    }
    // Content is corrupted beyond repair, return empty to use fallback
    warn('[validateCachedBody] Could not fix corrupted cache, using fallback');
    return '';
  }

  return content;
};

/**
 * Get the body for a message - checks store first, then fetches from cache
 */
const getMessageBodyForReply = async (msg) => {
  const msgId = getMessageApiId(msg);
  if (!msgId) return '';

  // Check if this is the currently selected message - use store value if so
  const selectedMessage = get(mailboxStore.state.selectedMessage);
  const selectedId = getMessageApiId(selectedMessage);
  const storeBody = get(mailboxStore.state.messageBody);

  if (selectedId && selectedId === msgId && storeBody) {
    return validateCachedBody(storeBody);
  }

  // Otherwise fetch from the database cache
  const account = Local.get('email') || 'default';
  try {
    const cached = await db.messageBodies.get([account, msgId]);
    if (cached?.body) {
      const validated = validateCachedBody(cached.body);
      if (!validated && cached.body) {
        // Cache was corrupted, delete it so it gets re-fetched next time
        try {
          await db.messageBodies.delete([account, msgId]);
        } catch {
          // Ignore deletion errors
        }
      }
      return validated;
    }
    if (cached?.textContent) return validateCachedBody(cached.textContent);
  } catch (err) {
    warn('[getMessageBodyForReply] Failed to fetch message body from cache:', err);
  }

  // If not in cache, return empty string (caller will use snippet as fallback)
  // No network fetch to keep replies instant
  return '';
};

/**
 * Format a date for reply/forward attribution
 */
const formatAttributionDate = (date) => {
  if (!date) return '';
  const d = new Date(typeof date === 'number' ? date : date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/**
 * Build quoted body HTML for reply
 */
const buildReplyQuotedBody = (msg, originalBody) => {
  const fromName = msg?.from || 'Unknown';
  const dateStr = formatAttributionDate(msg?.date || msg?.dateMs);
  const attribution = dateStr ? `On ${dateStr}, ${fromName} wrote:` : `${fromName} wrote:`;

  // Create reply structure with cursor at top
  return `<p><br></p><p class="fe-reply-attribution">${attribution}</p><blockquote class="fe-reply-quote">${originalBody}</blockquote>`;
};

/**
 * Build quoted body HTML for forward
 */
const buildForwardQuotedBody = (msg, originalBody) => {
  const from = msg?.from || '';
  const to = Array.isArray(msg?.to) ? msg.to.join(', ') : msg?.to || '';
  const dateStr = formatAttributionDate(msg?.date || msg?.dateMs);
  const subject = msg?.subject || '';

  const headerLines = [
    '---------- Forwarded message ---------',
    `From: ${from}`,
    `Date: ${dateStr}`,
    `Subject: ${subject}`,
    `To: ${to}`,
  ].join('<br>');

  return `<p><br></p><p class="fe-reply-attribution">${headerLines}</p><blockquote class="fe-reply-quote">${originalBody}</blockquote>`;
};

/**
 * Add RE: prefix if not already present
 */
const addReplyPrefix = (subject) => {
  if (!subject) return 'Re: ';
  const trimmed = subject.trim();
  if (/^re:\s*/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
};

/**
 * Add Fwd: prefix if not already present
 */
const addForwardPrefix = (subject) => {
  if (!subject) return 'Fwd: ';
  const trimmed = subject.trim();
  if (/^fwd?:\s*/i.test(trimmed)) return trimmed;
  return `Fwd: ${trimmed}`;
};

/**
 * Reply to a message
 * Opens compose immediately and loads body asynchronously
 */
export const replyTo = async (msg, options = {}) => {
  if (!composeModalRef) return;
  const targets = computeReplyTargets(msg, options);
  const headerRecord =
    msg?.nodemailer?.headers?.['message-id'] || msg?.nodemailer?.headers?.['Message-ID'];
  const headerValue = headerRecord?.value || headerRecord?.text || headerRecord;
  const headerId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const inReplyTo =
    msg?.message_id ||
    msg?.messageId ||
    msg?.header_message_id ||
    msg?.headerMessageId ||
    msg?.['Message-ID'] ||
    msg?.['message-id'] ||
    msg?.nodemailer?.messageId ||
    msg?.nodemailer?.message_id ||
    headerId ||
    '';

  // Open compose immediately with loading state
  composeModalRef.reply?.({
    subject: addReplyPrefix(msg?.subject),
    from: msg?.from,
    to: targets.to,
    cc: targets.cc,
    date: msg?.date || msg?.dateMs,
    html: '<p><br></p>', // Start with empty paragraph for cursor position
    bodyLoading: true, // Signal that body is loading
    inReplyTo,
  });

  // Fetch body from cache (no network request)
  try {
    const messageBodyValue = await getMessageBodyForReply(msg);

    // If we got a cached body, use it; otherwise use snippet (no error shown)
    const bodyToUse = messageBodyValue || msg?.snippet || msg?.textContent || '';
    const quotedBody = buildReplyQuotedBody(msg, bodyToUse);
    composeModalRef.updateReplyBody?.(quotedBody, { inReplyTo, focusTop: true });
  } catch (err) {
    warn('[replyTo] Failed to load body:', err);
    // Use snippet as fallback
    const fallbackBody = msg?.snippet || msg?.textContent || '';
    const quotedBody = buildReplyQuotedBody(msg, fallbackBody);
    composeModalRef.updateReplyBody?.(quotedBody, { inReplyTo, focusTop: true });
  }
};

export const replyAll = (msg) => replyTo(msg, { replyAll: true });

export const forwardMessage = async (msg) => {
  if (!composeModalRef) return;

  // Try to get cached body first
  const messageBodyValue = await getMessageBodyForReply(msg);

  // Use fallback values if body is not available (same as replyTo)
  const bodyToUse = messageBodyValue || msg?.snippet || msg?.textContent || '';
  const quotedBody = buildForwardQuotedBody(msg, bodyToUse);

  composeModalRef.forward?.({
    subject: addForwardPrefix(msg?.subject),
    html: quotedBody,
  });
};

/**
 * Search handler
 */
export const onSearch = async (term) => {
  try {
    await mailboxStore.actions.searchMessages(term);
  } catch (err) {
    warn('[mailboxActions] search failed', err);
    mailboxStore.state.query.set(term || '');
  }
};

/**
 * Load messages (wrapper)
 */
export const loadMessages = () => {
  return mailboxStore.actions.loadMessages();
};

/**
 * Get selected conversations
 */
export const getSelectedConversations = () => {
  const selectedIds = get(mailboxStore.state.selectedConversationIds);
  const conversations = get(mailboxStore.state.filteredConversations);
  return conversations.filter((c) => selectedIds.includes(c.id));
};

/**
 * Get selected messages from conversations
 */
export const getSelectedMessagesFromConversations = () => {
  const convs = getSelectedConversations();
  return convs.flatMap((c) => c.messages || []);
};

/**
 * Bulk move selected conversations
 */
export const bulkMoveTo = async (target) => {
  const messages = getSelectedMessagesFromConversations();
  if (!messages.length || !target) return;

  let successCount = 0;
  for (const msg of messages) {
    const result = await mailboxStore.actions.moveMessage(msg, target, { stayInFolder: true });
    if (result.success) successCount++;
  }

  mailboxStore.state.selectedConversationIds.set([]);
  bulkMoveOpen.set(false);

  if (successCount > 0) {
    toastsRef?.show?.(`Moved ${successCount} message(s)`, 'success');
    await mailboxStore.actions.loadMessages();
  } else {
    toastsRef?.show?.('Failed to move messages', 'error');
  }
};

/**
 * Context menu: move message
 */
export const contextMoveTo = async (msg, target) => {
  if (!msg || !target) return;
  const result = await mailboxStore.actions.moveMessage(msg, target, { stayInFolder: true });
  if (result.success) {
    toastsRef?.show?.('Message moved', 'success');
    await mailboxStore.actions.loadMessages();
  } else {
    toastsRef?.show?.('Failed to move message', 'error');
  }
};

/**
 * Context menu: label message (placeholder)
 */
export const contextLabel = async (msgOrLabel, labelMaybe, options = {}) => {
  const msg = labelMaybe
    ? msgOrLabel
    : msgOrLabel && msgOrLabel.id
      ? msgOrLabel
      : get(mailboxStore.state.selectedMessage);
  const label = labelMaybe || msgOrLabel;
  const { action = 'toggle', silent = false } = options || {};
  if (!msg || !label) return;
  const msgId = msg?.id;
  const messageList = get(mailboxStore.state.messages) || [];
  const latest = msgId != null ? messageList.find((entry) => entry?.id === msgId) : null;
  const targetMsg = latest || msg;
  const labelId =
    typeof label === 'object' ? label.id || label.keyword || label.value || label.name : label;
  const account = Local.get('email') || 'default';
  const currentLabels = Array.isArray(targetMsg.labels) ? targetMsg.labels.map(String) : [];
  const hasLabel = currentLabels.includes(String(labelId));
  let nextLabels = currentLabels;
  if (action === 'add') {
    if (hasLabel) return;
    nextLabels = currentLabels.concat(String(labelId));
  } else if (action === 'remove') {
    if (!hasLabel) return;
    nextLabels = currentLabels.filter((l) => l !== String(labelId));
  } else {
    nextLabels = hasLabel
      ? currentLabels.filter((l) => l !== String(labelId))
      : currentLabels.concat(String(labelId));
  }

  // Optimistic update in memory
  const msgs = get(mailboxStore.state.messages);
  mailboxStore.state.messages.set(
    msgs.map((m) => (m.id === msgId ? { ...m, labels: nextLabels } : m)),
  );
  const selectedMsg = get(mailboxStore.state.selectedMessage);
  if (selectedMsg?.id === msgId) {
    mailboxStore.state.selectedMessage.set({ ...selectedMsg, labels: nextLabels });
  }

  const apiId = getMessageApiId(targetMsg);
  if (!apiId) {
    warn('contextLabel failed: missing message id');
    mailboxStore.state.messages.set(msgs);
    if (selectedMsg?.id === msgId) {
      mailboxStore.state.selectedMessage.set(selectedMsg);
    }
    if (!silent) {
      showMissingMessageIdToast('update labels');
    }
    return;
  }

  // Update IDB cache immediately (optimistic)
  const candidateIds = new Set();
  const addCandidate = (value) => {
    if (value === undefined || value === null || value === '') return;
    candidateIds.add(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      candidateIds.add(Number(value));
    }
  };
  addCandidate(msgId);
  addCandidate(targetMsg?.uid);
  addCandidate(targetMsg?.message_id);
  addCandidate(targetMsg?.header_message_id);

  for (const candidate of candidateIds) {
    await db.messages
      .where('[account+id]')
      .equals([account, candidate])
      .modify({ labels: nextLabels })
      .catch(() => {});
  }
  await searchStore.actions.indexMessages([{ ...targetMsg, labels: nextLabels }]).catch(() => {});

  const labelList = get(availableLabels);
  const lbl = labelList.find(
    (l) =>
      (l.id || l.keyword || l.value || l.name) === labelId ||
      String(l.id || l.keyword || l.value || l.name) === String(labelId),
  );
  const labelName = lbl?.name || lbl?.label || lbl?.value || labelId;

  // Sync to server or queue for later
  const mutationPayload = {
    messageId: apiId,
    labels: nextLabels,
  };

  if (!navigator.onLine) {
    await queueMutation('label', mutationPayload);
    if (!silent) {
      const verb =
        action === 'add'
          ? 'Applied'
          : action === 'remove'
            ? 'Removed'
            : hasLabel
              ? 'Removed'
              : 'Applied';
      toastsRef?.show?.(`${verb} label ${labelName}`, 'success');
    }
    return;
  }

  try {
    await Remote.request(
      'MessageUpdate',
      { labels: nextLabels },
      { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(apiId)}` },
    );
    if (!silent) {
      const verb =
        action === 'add'
          ? 'Applied'
          : action === 'remove'
            ? 'Removed'
            : hasLabel
              ? 'Removed'
              : 'Applied';
      toastsRef?.show?.(`${verb} label ${labelName}`, 'success');
    }
  } catch (err) {
    warn('contextLabel failed, queuing for retry', err);
    await queueMutation('label', mutationPayload);
    if (!silent) {
      const verb =
        action === 'add'
          ? 'Applied'
          : action === 'remove'
            ? 'Removed'
            : hasLabel
              ? 'Removed'
              : 'Applied';
      toastsRef?.show?.(`${verb} label ${labelName} (will sync when online)`, 'success');
    }
  }
};

/**
 * Load labels for the current account
 */
export const loadLabels = async (options = {}) => {
  const { includeFolderFlags = false } = options;
  const account = Local.get('email') || 'default';
  const initialAccount = account;
  const labelMap = new Map();
  const reservedFlags = new Set(
    [
      'NonJunk',
      'Junk',
      'NotJunk',
      '$NotJunk',
      '$MDNSent',
      '\\Seen',
      '\\Flagged',
      '\\Answered',
      '\\Draft',
      '\\Drafts',
      '\\Trash',
      '\\Junk',
      '\\Sent',
      '\\Inbox',
      '\\Archive',
      '$Forwarded',
    ].map((f) => f.toLowerCase()),
  );
  const hiddenPatterns = [
    /^\$label\d+$/i,
    /^\$maillabel\d+$/i,
    /^\$mailflagbit\d+$/i,
    /^\d+$/i,
    /^calendar$/i,
    /^purge_issue$/i,
    /^purge-issue$/i,
    /^purge issue$/i,
    /^enterprise$/i,
    /^webmail$/i,
    /^notjunk$/i,
    /^\$notjunk$/i,
  ];
  const isHiddenFlag = (flag = '') => {
    const key = String(flag || '').trim();
    if (!key) return true;
    if (/^\[\s*\]$/.test(key)) return true;
    const lower = key.toLowerCase();
    if (reservedFlags.has(lower)) return true;
    if (key.startsWith('\\') || key.startsWith('$')) return true;
    return hiddenPatterns.some((re) => re.test(key));
  };
  const palette = LABEL_PALETTE;
  const colorFor = (name = '') => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash << 5) - hash + name.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % palette.length;
    return palette[idx];
  };
  const normalizeLabel = (flag = '', folderPath = '') => {
    const id = String(flag || '').trim();
    if (isHiddenFlag(id)) return null;
    const normalized = id.replace(/^\$?label/i, '').replace(/^[\s-_]+/, '');
    const readable = normalized || id.replace(/^[\\$]+/, '');
    const name = readable.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || id;
    return {
      id,
      name,
      color: colorFor(id),
      account,
      folder: folderPath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  };
  try {
    // Load any cached labels table first
    const cached = await db.labels
      .where('account')
      .equals(account)
      .toArray()
      .catch(() => []);
    (cached || []).forEach((l) => {
      if (!l?.id || isHiddenFlag(l.id)) return;
      labelMap.set(l.id, l);
    });
  } catch (err) {
    warn('loadLabels cache failed', err);
  }

  try {
    const settingsLabelsList = get(settingsLabels) || [];
    if ((Local.get('email') || 'default') !== initialAccount) return;
    (settingsLabelsList || []).forEach((lbl) => {
      const id = lbl.keyword || lbl.id || lbl.name;
      if (!id || isHiddenFlag(id)) return;
      const existing = labelMap.get(id);
      labelMap.set(id, {
        ...existing,
        id,
        name: lbl.name || existing?.name || id,
        color: lbl.color || existing?.color || colorFor(id),
        account,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      });
    });
  } catch (err) {
    warn('loadLabels settings labels failed', err);
  }

  // Only scan messages for label discovery on first load (no cached labels).
  // On subsequent loads the labels table already has all previously discovered labels.
  if (labelMap.size === 0) {
    try {
      const allMessages = await db.messages
        .where('account')
        .equals(account)
        .toArray()
        .catch(() => []);
      if (!allMessages?.length) return;
      for (const msg of allMessages) {
        if ((Local.get('email') || 'default') !== initialAccount) break;
        for (const lbl of msg.labels || []) {
          const key = String(lbl);
          if (!labelMap.has(key) && !isHiddenFlag(key)) {
            labelMap.set(key, {
              id: key,
              name: key,
              color: colorFor(key),
              account,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        }
      }
    } catch (err) {
      warn('loadLabels from messages failed', err);
    }
  }

  if (includeFolderFlags) {
    try {
      let folderList = get(mailboxStore.state.folders) || [];
      if (!folderList.length) {
        await mailboxStore.actions.loadFolders();
        folderList = get(mailboxStore.state.folders) || [];
      }
      if ((Local.get('email') || 'default') !== initialAccount) return;
      for (const folder of folderList) {
        if (!folder?.id) continue;
        try {
          const detail = await Remote.request(
            'FolderGet',
            {},
            { method: 'GET', pathOverride: `/v1/folders/${encodeURIComponent(folder.id)}` },
          );
          const flags = detail?.flags || detail?.Flags || [];
          (flags || []).forEach((flag) => {
            const label = normalizeLabel(flag, folder.path);
            if (label && !labelMap.has(label.id)) {
              labelMap.set(label.id, label);
            }
          });
        } catch (err) {
          warn('loadLabels folder detail failed', err);
        }
      }
    } catch (err) {
      warn('loadLabels from folders failed', err);
    }
  }

  if ((Local.get('email') || 'default') !== initialAccount) return;

  const normalized = Array.from(labelMap.values()).filter(
    (l) => l.id && l.name && !isHiddenFlag(l.id),
  );
  availableLabels.set(normalized);
  try {
    await db.labels
      .where('account')
      .equals(account)
      .delete()
      .catch(() => {});
    if (normalized.length) {
      await db.labels.bulkPut(
        normalized.map((l) => ({
          ...l,
          account,
        })),
      );
    }
  } catch (err) {
    warn('loadLabels persist failed', err);
  }
};

/**
 * Incrementally merge labels discovered in a batch of messages
 * into the availableLabels store and db.labels table.
 * Called after messages are loaded/synced to avoid a full table scan.
 */
export const mergeNewLabels = async (messages, account) => {
  if (!messages?.length) return;
  const existing = get(availableLabels) || [];
  const existingIds = new Set(existing.map((l) => l.id));
  const palette = LABEL_PALETTE;
  const colorFor = (name = '') => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash << 5) - hash + name.charCodeAt(i);
      hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
  };
  const newLabels = [];
  for (const msg of messages) {
    for (const lbl of msg.labels || []) {
      const key = String(lbl);
      if (!key || existingIds.has(key)) continue;
      if (key.startsWith('\\') || key.startsWith('$')) continue;
      existingIds.add(key);
      newLabels.push({
        id: key,
        name: key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || key,
        color: colorFor(key),
        account,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }
  if (!newLabels.length) return;
  const activeAccount = Local.get('email') || 'default';
  if (activeAccount !== account) return;
  availableLabels.set([...existing, ...newLabels]);
  try {
    await db.labels.bulkPut(newLabels);
  } catch {
    // Best effort
  }
};

/**
 * Create a label and refresh available labels
 */
export const createLabel = async (name, color = '') => {
  const validation = validateLabelName(name);
  if (!validation.ok) {
    toastsRef?.show?.(validation.error, 'error');
    return { success: false, error: validation.error };
  }
  const trimmed = validation.value;
  try {
    const res = await createSettingsLabel({
      keyword: trimmed,
      name: trimmed,
      color: color || undefined,
    });
    if (!res?.success) {
      const msg = res?.error || 'Failed to create label';
      toastsRef?.show?.(msg, 'error');
      return { success: false, error: msg };
    }
    await loadLabels();
    toastsRef?.show?.(`Created label ${trimmed}`, 'success');
    return { success: true, label: res.label };
  } catch (err) {
    warn('createLabel failed', err);
    const msg = err?.message || 'Failed to create label';
    toastsRef?.show?.(msg, 'error');
    return { success: false, error: msg };
  }
};

/**
 * Update a label and refresh available labels
 */
export const updateLabel = async (keyword, updates = {}) => {
  const name = updates?.name;
  if (name) {
    const validation = validateLabelName(name);
    if (!validation.ok) {
      toastsRef?.show?.(validation.error, 'error');
      return { success: false, error: validation.error };
    }
  }
  try {
    const res = await updateSettingsLabel(keyword, updates);
    if (!res?.success) {
      const msg = res?.error || 'Failed to update label';
      toastsRef?.show?.(msg, 'error');
      return { success: false, error: msg };
    }
    await loadLabels();
    toastsRef?.show?.('Label updated', 'success');
    return { success: true };
  } catch (err) {
    warn('updateLabel failed', err);
    const msg = err?.message || 'Failed to update label';
    toastsRef?.show?.(msg, 'error');
    return { success: false, error: msg };
  }
};

/**
 * Delete a label and refresh available labels
 */
export const deleteLabel = async (keyword) => {
  try {
    const res = await deleteSettingsLabel(keyword);
    if (!res?.success) {
      const msg = res?.error || 'Failed to delete label';
      toastsRef?.show?.(msg, 'error');
      return { success: false, error: msg };
    }
    await loadLabels();
    toastsRef?.show?.('Label deleted', 'success');
    return { success: true };
  } catch (err) {
    warn('deleteLabel failed', err);
    const msg = err?.message || 'Failed to delete label';
    toastsRef?.show?.(msg, 'error');
    return { success: false, error: msg };
  }
};

/**
 * Update storage statistics
 */
export const updateStorageStats = async (requestedAccount) => {
  const account = requestedAccount || Local.get('email') || 'default';
  try {
    // Get storage from Account endpoint (same as old MailboxView)
    const res = await fetchAccountData();
    // Verify account hasn't switched while the request was in-flight
    const activeNow = Local.get('email') || 'default';
    if (activeNow !== account) return;
    const used = res?.storage_used || res?.storage_used_by_aliases || 0;
    const total =
      res?.storage_quota ||
      res?.max_quota_per_alias ||
      res?.max_quota ||
      res?.max_quota_per_aliases ||
      0;
    if (total) {
      storageUsed.set(used);
      storageTotal.set(total);
    }
  } catch (err) {
    warn('Account storage stats failed (non-blocking)', err);
  }

  try {
    // Get local storage stats
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      localUsage.set(estimate.usage || 0);
      localQuota.set(estimate.quota || 0);
    }
  } catch (err) {
    warn('Local storage estimate failed', err);
  }

  try {
    // Get index stats from DB
    const messageCount = await db.messages.count().catch(() => 0);
    indexCount.set(messageCount || 0);

    // Rough estimate of index size (not precise)
    const allMessages = await db.messages
      .limit(100)
      .toArray()
      .catch(() => []);
    if (allMessages?.length) {
      const avgSize =
        allMessages.reduce((sum, m) => sum + JSON.stringify(m).length, 0) / allMessages.length;
      indexSize.set(Math.round(((messageCount || 0) * avgSize) / 1024)); // KB
    }
  } catch (err) {
    warn('Index stats failed', err);
  }
};

/**
 * Toggle body indexing
 */
export const toggleBodyIndexing = () => {
  const current = get(bodyIndexingEnabled);
  const next = !current;
  bodyIndexingEnabled.set(next);
  settingsActions.setBodyIndexing(next);
  searchStore.actions.setIncludeBody(next).catch(() => {
    // Search worker re-init is best-effort.
  });
  toastsRef?.show?.(`Body indexing ${next ? 'enabled' : 'disabled'}`, 'info');
};

/**
 * Rebuild search index (placeholder)
 */
export const rebuildFullSearchIndex = async () => {
  toastsRef?.show?.('Rebuilding search index...', 'info');
  try {
    await searchStore.actions.rebuildFromCache();
    await updateStorageStats();
    toastsRef?.show?.('Index rebuild complete', 'success');
  } catch (err) {
    warn('rebuildFullSearchIndex failed', err);
    toastsRef?.show?.('Failed to rebuild index', 'error');
  }
};

/**
 * Rebuild search from cache (placeholder)
 */
export const rebuildSearchFromCache = async () => {
  return rebuildFullSearchIndex();
};

/**
 * Load accounts list
 */
export const loadAccounts = async () => {
  try {
    // Initialize the accounts system (migrates from old single-account if needed)
    Accounts.init();

    // Load accounts from local storage
    const list = Accounts.getAll();

    // Format accounts for display
    const formattedAccounts = list.map((acct) => ({
      email: acct.email,
      addedAt: acct.addedAt,
      lastActive: acct.lastActive,
    }));

    accounts.set(formattedAccounts);

    // Set current account
    const activeEmail = Accounts.getActive() || Local.get('email');
    if (activeEmail) {
      currentAccount.set(activeEmail);
      loadProfileName(activeEmail);
      loadProfileImage(activeEmail);
    }
  } catch (err) {
    warn('loadAccounts failed', err);
  }
};

/**
 * Toggle account menu
 */
export const toggleAccountMenu = () => {
  accountMenuOpen.update((open) => !open);
};

/**
 * Toggle bulk move dropdown
 */
export const toggleBulkMove = () => {
  bulkMoveOpen.update((open) => !open);
};

/**
 * Start add-account flow by sending the user back to login
 * Keeps existing session data so multiple accounts can co-exist.
 */
export const addAccount = () => {
  accountMenuOpen.set(false);
  // Root renders the login view with add_account parameter to prevent auto-redirect
  if (navigateRef) navigateRef('/?add_account=true');
  else window.location.href = '/?add_account=true';
};

export const resetSessionState = () => {
  resetMailboxStateForAccount();
  mailboxStore.actions.resetForAccount?.();
  searchStore.actions.resetSearchConnection();
  resetSyncWorkerReady();
};

const clearSensitiveClientStorage = (account?: string) => {
  // Clear per-account PGP material before removing the email key
  if (account) {
    Local.remove(`pgp_passphrases_${account}`);
    Local.remove(`pgp_keys_${account}`);
  }

  Local.remove('alias_auth');
  Local.remove('api_key');
  Local.remove('authToken');
  Local.remove('email');
  try {
    sessionStorage.clear();
  } catch (err) {
    warn('Failed to clear sessionStorage during sign out', err);
  }
};

/**
 * Sign out of the current account.
 * If other accounts exist, switch to another account.
 * Otherwise, return to login and clear all data.
 */
export const signOut = async () => {
  const currentEmail = Local.get('email');
  accountMenuOpen.set(false);

  // Stop inbox polling
  if (inboxUpdater) inboxUpdater.destroy();
  inboxUpdater = null;

  clearSensitiveClientStorage(currentEmail);

  if (currentEmail) {
    try {
      await Accounts.remove(currentEmail, true);
    } catch (err) {
      warn('Failed to remove account cache during sign out', err);
    }
  }

  // Check if there are other accounts remaining
  const remainingAccounts = Accounts.getAll();

  if (remainingAccounts.length > 0) {
    // Switch to the first remaining account using cache-first atomic swap
    const nextAccount = remainingAccounts[0];

    if (toastsRef) {
      toastsRef.show(`Signed out of ${currentEmail}. Switched to ${nextAccount.email}`, 'success');
    }

    if (navigateRef) navigateRef('/mailbox');
    else window.location.href = '/mailbox';

    await performAccountSwitch(nextAccount.email);
  } else {
    // Show toast before clearing storage/navigation
    if (toastsRef && currentEmail) {
      toastsRef.show(`Signed out of ${currentEmail}`, 'success');
    }

    // No other accounts, clear everything and go to login
    Local.clear();
    accounts.set([]);
    currentAccount.set('');

    // Clear all service worker caches on full logout (static assets only, no API data)
    try {
      const { clearAllSWCaches } = await import('../utils/sw-cache.js');
      await clearAllSWCaches();
    } catch (err) {
      warn('Failed to clear SW caches', err);
    }

    mailboxStore.state.selectedConversationIds.set([]);
    mailboxStore.state.selectedMessage.set(null);
    mailboxStore.state.messages.set([]);
    mailboxStore.state.folders.set([]);

    // Clear settings on full logout
    clearSettings();

    // Dispatch event to clear login form fields
    window.dispatchEvent(new CustomEvent('login-clear-fields'));

    if (navigateRef) navigateRef('/');
    else window.location.href = '/';
  }
};

/**
 * Switch account (leading-edge debounce)
 *
 * Executes immediately on first call (no delay), then suppresses rapid
 * follow-up calls within 300ms. Only the last call in a burst wins.
 */
let switchCooldownTimer = null;
let switchPendingEmail = null;
let switchPendingResolve = null;

export const switchAccount = (accountObj) => {
  const email = accountObj?.email || accountObj;
  if (!email) return Promise.resolve();

  // If a cooldown is active, replace the pending target (trailing call wins)
  if (switchCooldownTimer) {
    switchPendingEmail = email;
    return new Promise((resolve) => {
      // Resolve the previous pending caller so it doesn't hang
      if (switchPendingResolve) switchPendingResolve();
      switchPendingResolve = resolve;
    });
  }

  // Leading edge: execute immediately
  switchCooldownTimer = setTimeout(async () => {
    const pending = switchPendingEmail;
    const pendingResolve = switchPendingResolve;
    switchCooldownTimer = null;
    switchPendingEmail = null;
    switchPendingResolve = null;
    // If a different account was requested during cooldown, execute it now
    if (pending && pending !== email) {
      try {
        await performAccountSwitch(pending);
      } finally {
        if (pendingResolve) pendingResolve();
      }
    } else if (pendingResolve) {
      pendingResolve();
    }
  }, 300);

  return performAccountSwitch(email);
};

/**
 * Pre-read Account B's cached data from IndexedDB before resetting stores.
 * Returns { folders, messages, settings, labels } ready for atomic swap.
 */
const preloadAccountCache = async (account) => {
  const [cachedFolders, cachedSettings, cachedLabels] = await Promise.all([
    db.folders
      .where('account')
      .equals(account)
      .toArray()
      .catch(() => []),
    db.settings.get(account).catch(() => null),
    db.settingsLabels.get(account).catch(() => null),
  ]);

  // Build the folder list and find INBOX
  const folderList = cachedFolders?.length
    ? mailboxStore.actions.buildFolderList?.(cachedFolders) || cachedFolders
    : [];
  const inbox = folderList.find((f) => f.path?.toUpperCase?.() === 'INBOX');
  const defaultFolder = inbox?.path || folderList[0]?.path || 'INBOX';

  // Read first page of messages for the default folder
  let cachedMessages = [];
  try {
    const range = db.messages
      .where('[account+folder+date]')
      .between(
        [account, defaultFolder, Dexie.minKey],
        [account, defaultFolder, Dexie.maxKey],
        true,
        true,
      );
    cachedMessages = await range.reverse().limit(50).toArray();
  } catch {
    // Fall back to unordered read
    try {
      cachedMessages = await db.messages
        .where('[account+folder]')
        .equals([account, defaultFolder])
        .limit(50)
        .toArray();
    } catch {
      // No cached messages available
    }
  }

  // Read cached labels
  let labelList = [];
  try {
    labelList = await db.labels.where('account').equals(account).toArray();
  } catch {
    // No cached labels
  }

  return {
    folders: folderList,
    defaultFolder,
    messages: cachedMessages,
    settings: cachedSettings?.settings || null,
    settingsLabels: cachedLabels?.labels || [],
    labels: labelList,
  };
};

const performAccountSwitch = async (email) => {
  // Use Accounts.setActive to properly switch account credentials
  const switched = Accounts.setActive(email);

  if (!switched) {
    toastsRef?.show?.(`Failed to switch to ${email}`, 'error');
    return;
  }

  currentAccount.set(email);
  accountMenuOpen.set(false);

  // PHASE 1: Pre-read Account B's cached data from IndexedDB BEFORE blanking the UI.
  // This allows an atomic swap from Account A → Account B with no blank state.
  const cached = await preloadAccountCache(email);

  // Stop inbox polling before switching (load() will start a new one)
  if (inboxUpdater) inboxUpdater.destroy();
  inboxUpdater = null;

  // PHASE 2: Reset workers and internal tracking (no visible effect)
  resetSyncWorkerReady();
  clearMailServiceState();
  mailboxStore.actions.resetForAccount?.();
  mailboxStore.actions.clearFolderMessageCache?.();

  // PHASE 3: Atomic swap — replace stores with cached data instead of blanking them
  initialSyncStarted.set(false);
  availableMoveTargets.set([]);
  syncProgress.set({ active: false, stage: '', folder: '', current: 0, total: 0, message: '' });
  indexProgress.set({ active: false, current: 0, total: 0, message: '' });
  mailboxStore.state.selectedConversationIds.set([]);
  mailboxStore.state.selectedMessage.set(null);
  mailboxStore.state.messageBody.set('');
  mailboxStore.state.attachments.set([]);
  mailboxStore.state.page.set(1);
  mailboxStore.state.query.set('');
  mailboxStore.state.searchResults.set([]);
  mailboxStore.state.searchActive.set(false);
  mailboxStore.state.messageLoading.set(false);
  mailboxStore.state.error.set('');
  mailboxStore.state.hasNextPage.set(false);
  mailboxStore.state.unreadOnly.set(false);
  mailboxStore.state.hasAttachmentsOnly.set(false);
  mailboxStore.state.starredOnly.set(false);

  // Swap in cached data (or empty if no cache — first time for this account)
  if (cached.folders.length) {
    mailboxStore.state.folders.set(cached.folders);
    mailboxStore.state.selectedFolder.set(cached.defaultFolder);
    mailboxStore.state.loading.set(false);
  } else {
    mailboxStore.state.folders.set([]);
    mailboxStore.state.selectedFolder.set('');
    mailboxStore.state.loading.set(true);
  }
  if (cached.messages.length) {
    mailboxStore.state.messages.set(cached.messages);
  } else {
    mailboxStore.state.messages.set([]);
  }
  if (cached.labels.length) {
    availableLabels.set(cached.labels);
  } else {
    availableLabels.set([]);
  }

  // Apply cached settings immediately (theme, layout, etc.)
  if (cached.settings) {
    applySettings(cached.settings);
  }
  if (cached.settingsLabels.length) {
    settingsLabels.set(cached.settingsLabels);
  }

  toastsRef?.show?.(`Switched to ${email}`, 'info');

  // PHASE 4: Deferred non-blocking work
  // Reset search store — don't await, init lazily on first search
  searchStore.actions.resetSearchConnection();
  searchStore.actions.ensureInitialized(email).catch(() => {});

  // PHASE 5: Full load with network refresh (non-blocking for cached accounts)
  // Note: we don't clearSettings() here because cached settings were already applied
  // above and load() -> syncSettings() will refresh from network in the background.
  await load();
};

/**
 * Fetch cached message content for downloads/views
 */
async function getMessageContent(msg) {
  if (!msg?.id) {
    return null;
  }
  const account = Local.get('email') || 'default';
  try {
    const body = await db.messageBodies.get([account, msg.id]);
    if (body?.body || body?.textContent || body?.raw) {
      return body;
    }
  } catch (err) {
    warn('getMessageContent failed', err);
  }
  return null;
}

function downloadBlob(content, filename, mime = 'text/plain') {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
  } catch (err) {
    console.error('downloadBlob failed', err);
    return false;
  }
}

function openInNewTab(content, mime = 'text/html') {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch (err) {
    console.error('openInNewTab failed', err);
    return false;
  }
}

const getSafeFilename = (subject = '', suffix = 'eml') => {
  const base = subject?.trim() || 'message';
  return `${base.replace(/[^a-z0-9\\-_.]+/gi, '_') || 'message'}.${suffix}`;
};

const resetMailboxStateForAccount = () => {
  mailboxStore.actions.clearFolderMessageCache?.();
  initialSyncStarted.set(false);
  availableLabels.set([]);
  availableMoveTargets.set([]);
  syncProgress.set({
    active: false,
    stage: '',
    folder: '',
    current: 0,
    total: 0,
    message: '',
  });
  indexProgress.set({
    active: false,
    current: 0,
    total: 0,
    message: '',
  });
  mailboxStore.state.selectedConversationIds.set([]);
  mailboxStore.state.selectedMessage.set(null);
  mailboxStore.state.messageBody.set('');
  mailboxStore.state.messages.set([]);
  mailboxStore.state.folders.set([]);
  mailboxStore.state.attachments.set([]);
  mailboxStore.state.selectedFolder.set('');
  mailboxStore.state.page.set(1);
  mailboxStore.state.query.set('');
  mailboxStore.state.searchResults.set([]);
  mailboxStore.state.searchActive.set(false);
  mailboxStore.state.loading.set(true);
  mailboxStore.state.messageLoading.set(false);
  mailboxStore.state.error.set('');
  mailboxStore.state.hasNextPage.set(false);
  mailboxStore.state.unreadOnly.set(false);
  mailboxStore.state.hasAttachmentsOnly.set(false);
  mailboxStore.state.starredOnly.set(false);
};

const extractHeaders = (raw = '') => {
  if (!raw) return '';
  const normalized = raw.replace(/\r\n/g, '\n');
  const dividerIndex = normalized.indexOf('\n\n');
  return dividerIndex === -1 ? normalized.trim() : normalized.slice(0, dividerIndex).trim();
};

const looksLikeHtml = (raw = '') => /<html[\s>]/i.test(raw) || /<body[\s>]/i.test(raw);

const normalizeHeaders = (rawHeaders, fallbackRaw = '') => {
  if (typeof rawHeaders === 'string') return rawHeaders.trim();
  if (Array.isArray(rawHeaders)) return rawHeaders.join('\n').trim();
  if (rawHeaders && typeof rawHeaders === 'object') {
    return Object.entries(rawHeaders)
      .map(([key, value]) =>
        Array.isArray(value) ? `${key}: ${value.join(', ')}` : `${key}: ${String(value)}`,
      )
      .join('\n')
      .trim();
  }
  const extracted = extractHeaders(fallbackRaw);
  if (extracted && /^[\w-]+\s*:/m.test(extracted)) return extracted;
  return '';
};

const fetchRawOriginal = async (msg) => {
  const apiId = getMessageApiId(msg);
  if (!apiId) return null;
  const folder = msg?.folder_path || msg?.folder || msg?.path || '';
  try {
    const res = await Remote.request(
      'Message',
      {},
      {
        method: 'GET',
        pathOverride: `/v1/messages/${encodeURIComponent(apiId)}?folder=${encodeURIComponent(folder || '')}&raw=true`,
      },
    );
    return res?.Result || res || null;
  } catch (err) {
    warn('[viewOriginal] raw fetch failed', err);
    return null;
  }
};

const fetchEmlOriginal = async (msg) => {
  const apiId = getMessageApiId(msg);
  if (!apiId) return null;
  const folder = msg?.folder_path || msg?.folder || msg?.path || '';
  try {
    const res = await Remote.request(
      'Message',
      {},
      {
        method: 'GET',
        pathOverride: `/v1/messages/${encodeURIComponent(apiId)}?folder=${encodeURIComponent(folder || '')}&eml=true`,
      },
    );
    return res?.Result || res || null;
  } catch (err) {
    warn('[downloadOriginal] eml fetch failed', err);
    return null;
  }
};

const buildOriginalViewerPage = ({
  raw = '',
  headers = '',
  subject = '',
  decrypted = '',
  isLightMode = true,
}) => {
  const filename = getSafeFilename(subject, 'eml');
  const darkModeStyles = !isLightMode
    ? `
    body { background: #0f172a; color: #e2e8f0; }
    header { background: #111827; border-bottom: 1px solid rgba(255,255,255,0.05); }
    button { background: #1f2937; color: #e5e7eb; border: 1px solid rgba(255,255,255,0.08); }
    button:hover { background: #273449; }
    .label { color: #94a3b8; }
    pre { background: #0b1220; border: 1px solid rgba(255,255,255,0.05); }
    .toast { background: #1f2937; border: 1px solid rgba(255,255,255,0.1); color: #e2e8f0; }
  `
    : '';

  // Create script content as a separate blob to avoid CSP inline script issues
  const scriptContent = `
    const DATA = ${JSON.stringify({ raw, headers, decrypted, filename })};

    const headersEl = document.getElementById('headers');
    const rawEl = document.getElementById('raw');
    const decBlock = document.getElementById('decryptedBlock');
    const decEl = document.getElementById('decrypted');
    headersEl.textContent = DATA.headers || 'No headers found';
    rawEl.textContent = DATA.raw || 'No original content available';
    if (DATA.decrypted) {
      decEl.textContent = DATA.decrypted;
      decBlock.style.display = 'block';
    }

    const showToast = (message) => {
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.remove();
      }, 2000);
    };

    const copyText = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        return ok;
      }
    };

    document.getElementById('copyHeaders').onclick = async () => {
      const success = await copyText(DATA.headers || '');
      showToast(success ? 'Headers copied to clipboard' : 'Failed to copy headers');
    };
    document.getElementById('copyRaw').onclick = async () => {
      const success = await copyText(DATA.raw || '');
      showToast(success ? 'Raw message copied to clipboard' : 'Failed to copy message');
    };
    document.getElementById('download').onclick = () => {
      const blob = new Blob([DATA.raw], { type: 'message/rfc822' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = DATA.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    };
  `;

  // Escape </ sequences so embedded data can't break out of the script tag
  const safeScriptContent = scriptContent.replace(/<\//g, '<\\/');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Original message</title>
  <style>
    /* Base styles (light mode) */
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #ffffff; color: #1f2937; }
    header { padding: 14px 16px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; display:flex; gap:10px; flex-wrap: wrap; align-items: center; }
    h1 { font-size: 16px; margin: 0; font-weight: 600; flex: 1; }
    button { background: #ffffff; color: #1f2937; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
    button:hover { background: #f3f4f6; }
    .section { padding: 14px 16px; }
    .label { font-size: 12px; color: #6b7280; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    pre { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; overflow: auto; max-height: 45vh; white-space: pre-wrap; word-break: break-word; }
    .grid { display: grid; gap: 12px; }
    .toast { background: #ffffff; border: 1px solid #e5e7eb; color: #1f2937; }


    /* Dark mode override */
    ${darkModeStyles}

    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      border-radius: 8px;
      padding: 12px 16px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 1000;
      animation: slideIn 0.2s ease-out;
      font-size: 14px;
    }
    @keyframes slideIn {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${subject ? subject.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Original message'}</h1>
    <button id="download">Download .eml</button>
    <button id="copyRaw">Copy raw message</button>
  </header>
  <div class="section grid">
    <div>
      <div class="label">Headers</div>
      <button id="copyHeaders" style="margin-bottom:8px;">Copy headers</button>
      <pre id="headers"></pre>
    </div>
    <div>
      <div class="label">Full source</div>
      <pre id="raw"></pre>
    </div>
    <div id="decryptedBlock" style="display:none;">
      <div class="label">Decrypted body (text)</div>
      <pre id="decrypted"></pre>
    </div>
  </div>
  <script>${safeScriptContent}</script>
</body>
</html>`;
};

// Prefer decrypted body if present; otherwise fall back to raw/original.
const pickOriginalContent = (content) => {
  if (!content) return '';
  return content.raw || content.body || content.textContent || '';
};

export const downloadOriginal = async (msg) => {
  const target = msg || get(mailboxStore.state.selectedMessage);
  const content = await getMessageContent(target);
  if (!content) {
    toastsRef?.show?.('Original message not available to download', 'error');
    return;
  }
  const meta = content?.meta || {};
  let emlPayload =
    meta.eml ||
    meta.rawEml ||
    meta.raw ||
    meta.Raw ||
    meta.rawBody ||
    meta.original ||
    meta.originalMessage ||
    meta.rawMessage ||
    pickOriginalContent(content);

  // Prefer server-provided RFC822 if not present or looks rendered HTML.
  if (!emlPayload || looksLikeHtml(emlPayload)) {
    const emlRes = await fetchEmlOriginal(target);
    if (typeof emlRes === 'string') {
      emlPayload = emlRes;
    } else if (emlRes?.eml || emlRes?.raw) {
      emlPayload = emlRes.eml || emlRes.raw;
      // Cache for reuse
      try {
        const account = Local.get('email') || 'default';
        const cached = await db.messageBodies
          .where('[account+id]')
          .equals([account, target.id])
          .first();
        if (cached) {
          await db.messageBodies.put({
            ...cached,
            meta: { ...(cached.meta || {}), eml: emlPayload },
          });
        }
      } catch (err) {
        warn('[downloadOriginal] failed to persist eml to cache', err);
      }
    }
  }

  // If the eml is still PGP-armored, fall back to a decrypted-text EML shell.
  if (typeof emlPayload === 'string' && /-----BEGIN PGP MESSAGE-----/.test(emlPayload)) {
    const decryptedText =
      content?.textContent ||
      (typeof content?.body === 'string' && !looksLikeHtml(content.body) ? content.body : '');
    if (decryptedText) {
      const headersText = normalizeHeaders(
        meta.headers || meta.Headers || meta.rawHeaders || meta.RawHeaders,
        emlPayload,
      );
      const headerBlock = headersText
        ? headersText.replace(/\r\n/g, '\n').split('\n').join('\r\n')
        : `Subject: ${target?.subject || ''}\r\n`;
      emlPayload = `${headerBlock}\r\n\r\n${decryptedText}`;
    }
  }

  const success = downloadBlob(
    emlPayload || '',
    getSafeFilename(target?.subject, 'eml'),
    'message/rfc822',
  );
  if (!success) {
    toastsRef?.show?.('Unable to download original message', 'error');
  }
};

export const viewOriginal = async (msg) => {
  const target = msg || get(mailboxStore.state.selectedMessage);
  const content = await getMessageContent(target);
  if (!content) {
    toastsRef?.show?.('Original message not available', 'error');
    return;
  }
  const meta = content?.meta || {};
  let payload =
    meta.raw ||
    meta.Raw ||
    meta.rawBody ||
    meta.original ||
    meta.originalMessage ||
    meta.rawMessage ||
    pickOriginalContent(content);
  let headersText = normalizeHeaders(
    meta.headers || meta.Headers || meta.rawHeaders || meta.RawHeaders,
    payload,
  );

  // If the cached meta/body doesn't have raw RFC822 (or looks like rendered HTML), fetch it explicitly.
  if ((!payload || looksLikeHtml(payload) || !headersText) && target) {
    const rawRes = await fetchRawOriginal(target);
    if (rawRes) {
      // Handle both string responses and object responses
      const rawContent = typeof rawRes === 'string' ? rawRes : rawRes.raw;
      const rawHeaders =
        typeof rawRes === 'object'
          ? rawRes.headers || rawRes.Headers || rawRes.rawHeaders || rawRes.RawHeaders
          : null;

      if (rawContent) {
        payload = rawContent;
        headersText = normalizeHeaders(rawHeaders, payload);

        // Persist raw + headers for next time.
        try {
          const account = Local.get('email') || 'default';
          const cached = await db.messageBodies
            .where('[account+id]')
            .equals([account, target.id])
            .first();
          if (cached) {
            await db.messageBodies.put({
              ...cached,
              meta: {
                ...(cached.meta || {}),
                raw: rawContent,
                headers: rawHeaders,
              },
            });
          }
        } catch (err) {
          warn('[viewOriginal] failed to persist raw to cache', err);
        }
      }
    }
  }

  const decryptedText =
    content?.textContent ||
    (typeof content?.body === 'string' && !looksLikeHtml(content.body) ? content.body : '');
  // Detect current theme from parent window
  const isLightMode =
    typeof document !== 'undefined' && document.body.classList.contains('light-mode');

  const viewerPage = buildOriginalViewerPage({
    raw: payload,
    headers: headersText,
    decrypted: decryptedText,
    subject: target?.subject || '',
    isLightMode,
  });
  const ok = openInNewTab(viewerPage, 'text/html');
  if (!ok) {
    toastsRef?.show?.('Unable to open original message', 'error');
  }
};

// Export everything as a single object for convenience
export const mailboxActions = {
  load,
  toggleRead,
  archiveMessage,
  deleteMessage,
  replyTo,
  forwardMessage,
  onSearch,
  loadMessages,
  toggleStar,
  getSelectedConversations,
  getSelectedMessagesFromConversations,
  bulkMoveTo,
  contextMoveTo,
  contextLabel,
  computeReplyTargets,
  replyAll,
  updateStorageStats,
  toggleBodyIndexing,
  rebuildFullSearchIndex,
  rebuildSearchFromCache,
  loadAccounts,
  addAccount,
  switchAccount,
  signOut,
  toggleAccountMenu,
  toggleBulkMove,
  setNavigate,
  setToasts,
  setComposeModal,
  setLayoutMode,
  layoutMode,
  starredOnly,
  downloadOriginal,
  viewOriginal,
};
