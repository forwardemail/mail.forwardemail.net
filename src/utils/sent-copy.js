import { get } from 'svelte/store';
import { Remote } from './remote.js';
import { Local } from './storage.js';
import { db } from './db';
import { folders as foldersStore } from '../stores/folderStore.ts';
import { resolveSentFolder } from './sent-folder.js';
import { warn } from './logger.ts';

export const buildSentCopyPayload = (emailPayload, account = null, folderList = null) => {
  const sentFolder = resolveSentFolder(account, folderList);
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

export const saveSentCopy = async (emailPayload, account = null, folderList = null) => {
  // Two-tier folder resolution: store first, then IDB fallback
  let folders = folderList;
  if (!folders) {
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

  const payload = buildSentCopyPayload(emailPayload, account, folders);
  warn('[saveSentCopy] Resolved folder: %s', payload.folder);

  const response = await Remote.request('MessageCreate', payload, {
    method: 'POST',
    pathOverride: '/v1/messages',
  });

  return response;
};
