import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { sendSyncTask } from './sync-worker-client';
import { getEffectiveSettingValue } from '../stores/settingsStore';
import { isDemoMode } from './demo-mode';

const AUTOSAVE_INTERVAL = 30000; // 30 seconds
const AUTOSAVE_DEBOUNCE = 3000; // 3 seconds after last keystroke (matches Gmail)
const DRAFT_PREFIX = 'draft_';

function getAccount() {
  return Local.get('email') || 'default';
}

/**
 * Get the drafts folder path from user settings or auto-detect
 */
function getDraftsFolder() {
  // Check for account-specific setting
  const currentAcct = Local.get('email') || 'default';
  const customFolder = getEffectiveSettingValue('drafts_folder', { account: currentAcct });

  if (customFolder) {
    return customFolder;
  }

  // Default to 'Drafts' if no custom folder is set
  return 'Drafts';
}

/**
 * Save or update a draft in the database
 * @param {Object} draftData - Draft data to save
 * @returns {Promise<Object>} The saved draft record
 */
export async function saveDraft(draftData, options = {}) {
  const account = getAccount();
  const id = draftData.id || `${DRAFT_PREFIX}${Date.now()}`;
  const { sync = true } = options;

  const draft = {
    id,
    account,
    folder: getDraftsFolder(),
    to: draftData.to || [],
    cc: draftData.cc || [],
    bcc: draftData.bcc || [],
    replyTo: draftData.replyTo || '',
    subject: draftData.subject || '',
    body: draftData.body || '',
    isPlainText: draftData.isPlainText || false,
    attachments: draftData.attachments || [],
    inReplyTo: draftData.inReplyTo || null,
    priority: draftData.priority || 'normal',
    requestReadReceipt: draftData.requestReadReceipt || false,
    serverId: draftData.serverId || null,
    syncStatus: 'pending',
    lastError: null,
    lastSyncedAt: draftData.lastSyncedAt || null,
    updatedAt: Date.now(),
    createdAt: draftData.createdAt || Date.now(),
  };

  await db.drafts.put(draft);

  // In demo mode, save locally but skip server sync
  if (isDemoMode()) {
    return { ...draft, syncStatus: 'local' };
  }

  if (sync && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const synced = await syncDraftToServer(draft);
      return synced;
    } catch (err) {
      const failed = {
        ...draft,
        syncStatus: 'pending',
        lastError: err?.message || 'Draft sync failed',
      };
      await db.drafts.put(failed);
      return failed;
    }
  }

  return { ...draft, syncStatus: 'local' };
}

/**
 * Get a draft by ID
 * @param {string} id - Draft ID
 * @returns {Promise<Object|undefined>} The draft or undefined
 */
export async function getDraft(id) {
  const account = getAccount();
  return db.drafts.get([account, id]);
}

/**
 * List all drafts for the current account
 * @returns {Promise<Array>} Array of drafts sorted by updatedAt descending
 */
export async function listDrafts() {
  const account = getAccount();
  try {
    const drafts = await db.drafts
      .where('[account+id]')
      .between([account, ''], [account, '\uffff'])
      .toArray();
    return drafts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (err) {
    console.error('[Draft Service] Failed to list drafts:', err);
    return [];
  }
}

/**
 * Delete a draft by ID
 * @param {string} id - Draft ID
 * @returns {Promise<void>}
 */
export async function deleteDraft(id) {
  const account = getAccount();
  try {
    await db.drafts.delete([account, id]);
  } catch (err) {
    console.error('[Draft Service] Failed to delete draft:', err);
    throw new Error(`Failed to delete draft: ${err?.message || 'Unknown error'}`);
  }
}

/**
 * Delete all drafts for the current account
 * @returns {Promise<number>} Number of drafts deleted
 */
export async function clearDrafts() {
  const account = getAccount();
  try {
    const drafts = await listDrafts();
    for (const draft of drafts) {
      await db.drafts.delete([account, draft.id]);
    }
    return drafts.length;
  } catch (err) {
    console.error('[Draft Service] Failed to clear drafts:', err);
    return 0;
  }
}

/**
 * Compute a hash of draft data for change detection
 * @param {Object} data - Draft data
 * @returns {string} Hash string
 */
function computeHash(data) {
  return JSON.stringify({
    to: data.to,
    cc: data.cc,
    bcc: data.bcc,
    subject: data.subject,
    body: data.body,
    isPlainText: data.isPlainText,
    attachments: (data.attachments || []).map((att) => `${att.name || ''}-${att.size || 0}`),
    priority: data.priority,
    requestReadReceipt: data.requestReadReceipt,
  });
}

/**
 * Check if draft has meaningful content worth saving
 * @param {Object} data - Draft data
 * @returns {boolean} True if draft has content
 */
function hasMeaningfulContent(data) {
  return !!(
    (data.to && data.to.length > 0) ||
    (data.cc && data.cc.length > 0) ||
    (data.bcc && data.bcc.length > 0) ||
    (data.subject && data.subject.trim()) ||
    (data.body && data.body.trim())
  );
}

function buildDraftPayload(draft) {
  const from = draft.from || Local.get('email') || '';
  const payload = {
    from,
    to: draft.to || [],
    cc: draft.cc || [],
    bcc: draft.bcc || [],
    replyTo: draft.replyTo || undefined,
    inReplyTo: draft.inReplyTo || undefined,
    subject: draft.subject || '',
    html: draft.isPlainText ? undefined : draft.body || '',
    text: draft.isPlainText ? draft.body || '' : undefined,
    attachments: (draft.attachments || []).map((att) => ({
      filename: att.name || att.filename,
      contentType: att.contentType,
      content: att.content,
      encoding: 'base64',
    })),
    has_attachment: Array.isArray(draft.attachments) && draft.attachments.length > 0,
    folder: draft.folder || getDraftsFolder(),
  };
  return payload;
}

async function syncDraftToServer(draft) {
  const payload = buildDraftPayload(draft);
  let response;
  if (draft.serverId) {
    response = await Remote.request('MessageUpdate', payload, {
      method: 'PUT',
      pathOverride: `/v1/messages/${encodeURIComponent(draft.serverId)}`,
    });
  } else {
    response = await Remote.request('MessageCreate', payload, {
      method: 'POST',
      pathOverride: '/v1/messages',
    });
  }
  const serverId =
    response?.id ||
    response?.Id ||
    response?.message_id ||
    response?.messageId ||
    response?.Result?.id ||
    draft.serverId ||
    null;
  const synced = {
    ...draft,
    serverId,
    syncStatus: 'synced',
    lastError: null,
    lastSyncedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.drafts.put(synced);
  return synced;
}

export async function syncPendingDrafts() {
  const account = getAccount();
  try {
    await sendSyncTask({ type: 'drafts', account });
  } catch {
    // ignore sync scheduling failures
  }
}

/**
 * Create an autosave timer that saves drafts periodically
 * @param {Function} getDraftData - Function that returns current draft data
 * @param {Object} handlers - Callbacks for autosave lifecycle
 * @returns {Object} Timer controller with start(), stop(), saveNow()
 */
export function createAutosaveTimer(getDraftData, handlers = {}) {
  let timer = null;
  let debounceTimer = null;
  let lastSaveHash = '';
  let dirty = false;
  const { onSave, onError, onStart } = handlers;

  const checkAndSave = async () => {
    try {
      const data = getDraftData();
      const hash = computeHash(data);

      // Only save if content changed and there's actual content
      if (hash !== lastSaveHash && hasMeaningfulContent(data)) {
        onStart?.();
        lastSaveHash = hash;
        dirty = false;
        const saved = await saveDraft(data, { sync: true });
        onSave?.(saved);
        return saved;
      }
    } catch (err) {
      onError?.(err);
    }
    return null;
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (dirty) checkAndSave();
      }, AUTOSAVE_INTERVAL);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },
    saveNow: checkAndSave,
    markDirty() {
      dirty = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAndSave, AUTOSAVE_DEBOUNCE);
    },
    resetHash() {
      lastSaveHash = '';
    },
  };
}
