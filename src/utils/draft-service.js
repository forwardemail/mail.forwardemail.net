import { db } from './db';
import { Local } from './storage';
import { Remote } from './remote';
import { sendSyncTask } from './sync-worker-client';
import { getEffectiveSettingValue } from '../stores/settingsStore';
import { isDemoMode } from './demo-mode';
import { isOnline } from './network-status';
import { getMailBackend } from '../backends';
import { ImapBackend } from '../backends/imap';
import { imapSettingsFor } from '../backends/imap-account';
import { buildMimeMessage } from './mime-message';

const AUTOSAVE_INTERVAL = 30000; // 30 seconds
const AUTOSAVE_DEBOUNCE = 3000; // 3 seconds after last keystroke (matches Gmail)
const DRAFT_PREFIX = 'draft_';

function getAccount() {
  return Local.get('email') || 'default';
}

// Saves and the sync worker's draft task must not create the same draft on
// the server twice. Saves of one draft run one after another, and each reads
// the server id an earlier save (or the worker) stored, so only the first
// creates it and later ones update it. The worker's task waits for saves in
// flight and saves wait for it. The Web Lock does the same across windows
// (the desktop compose window saves drafts too).
const draftChains = new Map();
const draftActivity = new Map();

function activityFor(account) {
  let entry = draftActivity.get(account);
  if (!entry) {
    entry = { saves: new Set(), sync: null };
    draftActivity.set(account, entry);
  }
  return entry;
}

function withWebLock(name, mode, fn) {
  const locks = typeof navigator !== 'undefined' ? navigator?.locks : null;
  if (locks && typeof locks.request === 'function') {
    return locks.request(name, { mode }, () => fn());
  }
  return fn();
}

// A save waits for a worker task already started when it was asked for; the
// task waits for saves already asked for when it started. Deciding both at
// call time means neither can end up waiting on the other.
async function runAsSync(account, fn) {
  const activity = activityFor(account);
  const previous = activity.sync;
  const saves = [...activity.saves];
  const run = (async () => {
    if (previous) await previous.catch(() => {});
    await Promise.allSettled(saves);
    return withWebLock(`draft-sync:${account}`, 'exclusive', fn);
  })();
  activity.sync = run;
  try {
    return await run;
  } finally {
    if (activity.sync === run) activity.sync = null;
  }
}

function withDraftLock(account, id, fn) {
  const activity = activityFor(account);
  const workerRun = activity.sync;
  const key = `${account}\u0000${id}`;
  const previous = draftChains.get(key) || Promise.resolve();
  const run = (async () => {
    await previous;
    if (workerRun) await workerRun.catch(() => {});
    return withWebLock(`draft-sync:${account}`, 'shared', fn);
  })();
  const tail = run.then(
    () => {},
    () => {},
  );
  activity.saves.add(tail);
  draftChains.set(key, tail);
  tail.then(() => {
    activity.saves.delete(tail);
    if (draftChains.get(key) === tail) draftChains.delete(key);
  });
  return run;
}

// A compose window may not use the mail engine, so it cannot save a draft to
// a custom IMAP server itself. It writes the draft to the database, which
// both windows share, and asks the main window to save it (compose-main.ts
// sets this up; utils/compose-window.ts answers).
let draftRelay = null;

/**
 * Compose window only.
 * @param {{accounts: string[], save: (account: string, id: string) => Promise<void>,
 *   remove: (account: string, messageId: string) => void} | null} relay
 */
export function setDraftRelay(relay) {
  draftRelay = relay
    ? {
        ...relay,
        accounts: new Set((relay.accounts || []).map((a) => String(a).trim().toLowerCase())),
      }
    : null;
}

/** True in a compose window, for an account whose drafts the main window saves. */
export function draftsGoThroughMainWindow(account) {
  return Boolean(
    draftRelay?.accounts.has(
      String(account || '')
        .trim()
        .toLowerCase(),
    ),
  );
}

/** Ask the main window to remove a draft message from the server. Not waited for. */
export function removeDraftMessageThroughMainWindow(account, messageId) {
  if (messageId) draftRelay?.remove(account, String(messageId));
}

async function saveThroughMainWindow(account, draft) {
  let failure = null;
  try {
    await draftRelay.save(account, draft.id);
  } catch (err) {
    failure = err;
  }
  // The main window wrote what happened onto the draft, the server id
  // included. With no answer the row is left alone: writing it here could
  // undo an id the main window is about to store.
  const stored = failure?.unanswered ? null : await db.drafts.get([account, draft.id]);
  if (stored) return stored;
  return {
    ...draft,
    syncStatus: 'pending',
    lastError: failure?.message || 'Draft sync failed',
  };
}

/**
 * Main window: save a draft a compose window wrote to the database. The
 * compose window holds that draft's place in the save order while it waits.
 */
export async function saveDraftForComposeWindow(account, id) {
  if (!imapSettingsFor(account)) throw new Error('This account is not on a custom mail server');
  const draft = await db.drafts.get([account, id]);
  if (!draft) throw new Error('The draft is no longer on this device');
  try {
    return await syncDraftToServer(draft);
  } catch (err) {
    await db.drafts.put({
      ...draft,
      syncStatus: 'pending',
      lastError: err?.message || 'Draft sync failed',
    });
    throw err;
  }
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
  return withDraftLock(account, id, () => saveDraftNow(account, id, draftData, options));
}

async function saveDraftNow(account, id, draftData, options) {
  const { sync = true } = options;

  // The server id an earlier save or the sync worker got for this draft.
  // The caller's copy can predate it, and saving without it creates a
  // second draft on the server.
  let storedServerId = null;
  if (!draftData.serverId) {
    try {
      storedServerId = (await db.drafts.get([account, id]))?.serverId || null;
    } catch {
      storedServerId = null;
    }
  }

  const draft = {
    id,
    account,
    folder: getDraftsFolder(),
    from: draftData.from || '',
    to: draftData.to || [],
    cc: draftData.cc || [],
    bcc: draftData.bcc || [],
    replyTo: draftData.replyTo || '',
    subject: draftData.subject || '',
    body: draftData.body || '',
    isPlainText: draftData.isPlainText || false,
    attachments: draftData.attachments || [],
    inReplyTo: draftData.inReplyTo || null,
    references: draftData.references || null,
    // kept on this device only; the send flags that message \Answered
    replyToMessageId: draftData.replyToMessageId || null,
    replyToMessageFolder: draftData.replyToMessageFolder || null,
    priority: draftData.priority || 'normal',
    requestReadReceipt: draftData.requestReadReceipt || false,
    serverId: draftData.serverId || storedServerId,
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

  if (sync && typeof navigator !== 'undefined' && isOnline()) {
    if (draftsGoThroughMainWindow(account)) return saveThroughMainWindow(account, draft);
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
 * @param {Object} [options]
 * @param {string} [options.account] - whose draft (default: the active account)
 * @returns {Promise<void>}
 */
export async function deleteDraft(id, { account: forAccount } = {}) {
  const account = forAccount || getAccount();
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
 * Check if a draft body has any real content. Rich text bodies are HTML from
 * the editor, so an empty document still arrives as markup like "<p></p>".
 * Strip tags and non-breaking spaces before checking, but treat embedded
 * media as content since an image-only body is a real draft.
 * @param {string} body - Draft body
 * @param {boolean} isPlainText - Whether the body is plain text
 * @returns {boolean} True if the body has content
 */
function bodyHasContent(body, isPlainText) {
  if (!body || !body.trim()) return false;
  if (isPlainText) return true;
  if (/<(img|video|audio)\b/i.test(body)) return true;
  return !!body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|#160);/gi, ' ')
    .trim();
}

/**
 * Check if draft has meaningful content worth saving
 * @param {Object} data - Draft data
 * @returns {boolean} True if draft has content
 */
export function draftHasContent(data) {
  return !!(
    (data.to && data.to.length > 0) ||
    (data.cc && data.cc.length > 0) ||
    (data.bcc && data.bcc.length > 0) ||
    (data.subject && data.subject.trim()) ||
    (data.attachments && data.attachments.length > 0) ||
    bodyHasContent(data.body, data.isPlainText)
  );
}

const DRAFT_FLAGS = ['\\Draft', '\\Seen'];

function buildDraftPayload(draft) {
  const from = draft.from || Local.get('email') || '';
  const payload = {
    from,
    to: draft.to || [],
    cc: draft.cc || [],
    bcc: draft.bcc || [],
    replyTo: draft.replyTo || undefined,
    inReplyTo: draft.inReplyTo || undefined,
    references: draft.references || undefined,
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

/**
 * Save a draft to the Drafts folder of an account on a custom IMAP server.
 * Returns the saved copy's id, or null when the server could not be asked
 * for it (the next save then cannot remove this copy, so it is kept).
 */
async function saveDraftOverImap(account, draft, payload) {
  const backend = getMailBackend(account);
  if (!(backend instanceof ImapBackend)) {
    throw new Error('This account is not connected to its mail server');
  }
  // A new Message-ID for each save: it is how the saved copy is found again,
  // and it must not find the copy this save replaces.
  const built = buildMimeMessage(
    { ...payload, from: payload.from || account, messageId: undefined },
    { draft: true },
  );
  // The copy with the Bcc line. A draft keeps everything typed so far.
  return backend.saveDraft(built.sentCopy, {
    previousId: draft.serverId || null,
    folder: payload.folder,
  });
}

async function syncDraftToServer(draft) {
  const payload = buildDraftPayload(draft);
  let response;
  const account = draft.account || getAccount();
  if (imapSettingsFor(account)) {
    const savedId = await saveDraftOverImap(account, draft, payload);
    response = { id: savedId };
    // The copy saved before is gone from the server either way.
    if (!savedId) draft = { ...draft, serverId: null };
  } else if (draft.serverId) {
    response = await Remote.request('MessageUpdate', payload, {
      method: 'PUT',
      pathOverride: `/v1/messages/${encodeURIComponent(draft.serverId)}`,
    });
  } else {
    // saved read and flagged as a draft, as mail clients save drafts, so the
    // Drafts folder does not show it as unread in IMAP clients (an update
    // leaves the flags alone)
    response = await Remote.request(
      'MessageCreate',
      { ...payload, flags: DRAFT_FLAGS },
      { method: 'POST', pathOverride: '/v1/messages' },
    );
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

/**
 * Send this account's unsaved drafts from this window. The sync worker does
 * it for a Forward Email account, but the worker cannot reach a custom IMAP
 * server (only the main window may use the mail engine).
 */
async function syncPendingDraftsHere(account) {
  const drafts = await db.drafts.where('account').equals(account).toArray();
  for (const draft of drafts) {
    if (!draft || draft.syncStatus === 'synced' || !draftHasContent(draft)) continue;
    try {
      await syncDraftToServer(draft);
    } catch (err) {
      await db.drafts.put({
        ...draft,
        syncStatus: 'pending',
        lastError: err?.message || 'Draft sync failed',
        updatedAt: Date.now(),
      });
    }
  }
}

export async function syncPendingDrafts() {
  const account = getAccount();
  try {
    if (imapSettingsFor(account)) {
      await runAsSync(account, () => syncPendingDraftsHere(account));
      return;
    }
    await runAsSync(account, () => sendSyncTask({ type: 'drafts', account }));
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
  let stopped = false;
  // Serialize saves so concurrent debounce + interval ticks don't both POST
  // before the first response sets serverId, creating duplicate server drafts.
  let inFlight = null;
  let pendingSave = false;
  const { onSave, onError, onStart } = handlers;

  const runSave = async () => {
    try {
      const data = getDraftData();
      const hash = computeHash(data);

      // Only save if content changed and there's actual content
      if (hash !== lastSaveHash && draftHasContent(data)) {
        onStart?.();
        lastSaveHash = hash;
        dirty = false;
        const saved = await saveDraft(data, { sync: true });
        onSave?.(saved);
        return saved;
      }
    } catch (err) {
      // Belt-and-suspenders: if the handler itself throws, don't let that
      // escape this catch block and reject runSave() — see the note on
      // checkAndSave() below for why an unhandled rejection here matters.
      try {
        onError?.(err);
      } catch (handlerErr) {
        console.error('[draft-service] onError handler threw:', handlerErr);
      }
    }
    return null;
  };

  // checkAndSave() is invoked fire-and-forget from a setInterval tick and
  // from the markDirty() debounce timer below — neither call site awaits or
  // catches it. runSave() already swallows its own errors, but this must
  // never reject either: on iOS, an unhandled promise rejection terminates
  // the WKWebView process outright (see notification-manager.js's cold-start
  // crash fix), which would silently kill autosave rather than just log it.
  const checkAndSave = async () => {
    if (inFlight) {
      pendingSave = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const result = await runSave();
        // If another save was requested while in-flight, run once more so
        // the latest content is persisted. By now serverId is set, so the
        // follow-up becomes a PUT instead of a duplicate POST.
        if (pendingSave) {
          pendingSave = false;
          return await runSave();
        }
        return result;
      } catch (err) {
        console.error('[draft-service] Unexpected error in autosave:', err);
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (dirty) checkAndSave().catch(() => {});
      }, AUTOSAVE_INTERVAL);
    },
    stop() {
      stopped = true;
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
      if (stopped) return;
      dirty = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        checkAndSave().catch(() => {});
      }, AUTOSAVE_DEBOUNCE);
    },
    // Lock the current content as the no-save baseline. Called after
    // programmatic prefill (reply/forward quoted body) so an untouched compose
    // doesn't autosave a draft just because recipients/subject/quote are set.
    markBaseline() {
      try {
        lastSaveHash = computeHash(getDraftData());
      } catch {
        // ignore baseline errors
      }
      dirty = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },
    resetHash() {
      lastSaveHash = '';
    },
  };
}
