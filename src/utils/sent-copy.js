import { get } from 'svelte/store';
import { Remote } from './remote.js';
import { Local } from './storage.js';
import { db } from './db';
import { folders as foldersStore } from '../stores/folderStore.ts';
import { resolveSentFolder } from './sent-folder.js';
import { warn } from './logger.ts';

export const buildSentCopyPayload = (
  emailPayload,
  account = null,
  folderList = null,
  sentFolderOverride = null,
) => {
  const sentFolder = sentFolderOverride || resolveSentFolder(account, folderList);
  return {
    from: emailPayload.from,
    to: emailPayload.to || [],
    cc: emailPayload.cc || [],
    bcc: emailPayload.bcc || [],
    replyTo: emailPayload.replyTo,
    inReplyTo: emailPayload.inReplyTo,
    references: emailPayload.references || '',
    subject: emailPayload.subject || '',
    html: emailPayload.html,
    text: emailPayload.text,
    attachments: emailPayload.attachments || [],
    has_attachment: emailPayload.has_attachment || false,
    folder: sentFolder,
    flags: ['\\Seen'],
  };
};

export const saveSentCopy = async (
  emailPayload,
  account = null,
  folderList = null,
  sentFolderOverride = null,
) => {
  // Two-tier folder resolution: store first, then IDB fallback.
  // Skipped entirely when the caller passes an explicit sent folder — the
  // native compose window has no IDB folder store, so the main window
  // resolves the folder and hands it over at open time.
  let folders = folderList;
  if (!sentFolderOverride && !folders) {
    // Primary: read from in-memory folder store (already loaded after login)
    const storeFolders = get(foldersStore);
    if (storeFolders?.length) {
      folders = storeFolders;
      warn('[saveSentCopy] Using folder store (%d folders)', storeFolders.length);
    } else {
      // Secondary: fall back to IDB if store is empty (e.g. outbox send before store hydrates)
      try {
        const acct = account || Local.get('email') || 'default';
        folders = await db.folders.where('account').equals(acct).toArray();
        warn('[saveSentCopy] Store empty, fell back to IDB (%d folders)', folders?.length ?? 0);
      } catch {
        warn('[saveSentCopy] Both store and IDB empty, using fallback');
        // Fall through — resolveSentFolder will use 'Sent' fallback
      }
    }
  }

  const payload = buildSentCopyPayload(emailPayload, account, folders, sentFolderOverride);
  warn('[saveSentCopy] Resolved folder: %s', payload.folder);

  const response = await Remote.request('MessageCreate', payload, {
    method: 'POST',
    pathOverride: '/v1/messages',
  });

  return response;
};

// Merge the MessageCreate response (server id + dates) with the compose payload
// (recipients/subject/body) into a single object the mailbox store can normalize
// into a Sent envelope for an optimistic insert. Returns null when the response
// carries no server id — without one we can't dedup against the real copy the
// sync will bring, so we skip the optimistic insert and fall back to sync only.
//
// Only the list-envelope fields are kept: attachment *content* is deliberately
// dropped (we keep `has_attachment` for the paperclip), since on desktop this
// object is serialized across the compose-window IPC and re-opening the message
// reloads attachments from the server by id anyway.
export const buildOptimisticSentSource = (emailPayload = {}, response = {}) => {
  const id = response?.id || response?.Id || response?.data?.id;
  if (!id) return null;
  return {
    id,
    uid: response?.uid ?? response?.Uid ?? response?.data?.uid ?? null,
    created_at: response?.created_at || response?.data?.created_at || null,
    internal_date: response?.internal_date || response?.data?.internal_date || null,
    from: emailPayload.from,
    to: emailPayload.to || [],
    cc: emailPayload.cc || [],
    bcc: emailPayload.bcc || [],
    subject: emailPayload.subject || '',
    text: emailPayload.text,
    // Reply headers feed the Sent-derived reply index (refreshReplyTargets),
    // which is what draws the thread count next to the original message.
    // Without them the just-sent reply was invisible to that index until the
    // real Sent sync landed.
    inReplyTo: emailPayload.inReplyTo,
    references: emailPayload.references || '',
    has_attachment: emailPayload.has_attachment || (emailPayload.attachments?.length ?? 0) > 0,
    flags: ['\\Seen'],
  };
};
