/**
 * Dedicated Sync Worker
 *
 * Handles API synchronization and message fetching off the main thread.
 * Database operations are routed through db.worker.js via MessageChannel.
 */

import PostalMime from 'postal-mime';
import * as openpgp from 'openpgp';
import { normalizeMessageForCache, mergeFlagsAndMetadata } from '../utils/sync-helpers.ts';
import { normalizeSubject } from '../utils/threading.ts';
import {
  bufferToDataUrl,
  applyInlineAttachments,
  extractTextContent,
} from '../utils/mime-utils.js';

// ============================================================================
// Database Client via MessageChannel
// ============================================================================

let dbPort = null;
let dbRequestId = 0;
const dbPendingRequests = new Map();

function dbSend(action, table = null, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!dbPort) {
      reject(new Error('Database worker not connected'));
      return;
    }

    const id = ++dbRequestId;
    dbPendingRequests.set(id, { resolve, reject });
    dbPort.postMessage({ id, action, table, payload });
  });
}

function handleDbResponse(event) {
  const { id, ok, result, error } = event.data || {};
  const pending = dbPendingRequests.get(id);
  if (!pending) return;

  dbPendingRequests.delete(id);
  if (ok) {
    pending.resolve(result);
  } else {
    pending.reject(new Error(error || 'Database operation failed'));
  }
}

// Database proxy object
const db = {
  syncManifests: {
    get: (key) => dbSend('get', 'syncManifests', { key }),
    put: (record) => dbSend('put', 'syncManifests', { record }),
  },
  messages: {
    bulkGet: (keys) => dbSend('bulkGet', 'messages', { keys }),
    bulkPut: (records) => dbSend('bulkPut', 'messages', { records }),
    where: (index) => ({
      equals: (value) => ({
        toArray: () => dbSend('queryEquals', 'messages', { index, value }),
        delete: () => dbSend('queryEqualsDelete', 'messages', { index, value }),
      }),
    }),
  },
  messageBodies: {
    get: (key) => dbSend('get', 'messageBodies', { key }),
    bulkGet: (keys) => dbSend('bulkGet', 'messageBodies', { keys }),
    put: (record) => dbSend('put', 'messageBodies', { record }),
    where: (index) => ({
      equals: (value) => ({
        toArray: () => dbSend('queryEquals', 'messageBodies', { index, value }),
      }),
    }),
  },
  folders: {
    bulkPut: (records) => dbSend('bulkPut', 'folders', { records }),
    where: (index) => ({
      equals: (value) => ({
        delete: () => dbSend('queryEqualsDelete', 'folders', { index, value }),
      }),
    }),
  },
  drafts: {
    put: (record) => dbSend('put', 'drafts', { record }),
    where: (index) => ({
      equals: (value) => ({
        toArray: () => dbSend('queryEquals', 'drafts', { index, value }),
      }),
    }),
  },
};

// ============================================================================
// Worker State
// ============================================================================

let apiBase = '';
let authHeader = '';
let unlockedPgpKeys = [];
let pgpPassphrases = {};
let searchPort = null;

const DEFAULT_LIMIT = 100;
const DEFAULT_BODY_LIMIT = 50;
const FETCH_TIMEOUT_MS = 30000; // 30s timeout for individual fetch calls

const manifests = new Map(); // key: `${account}::${folder}`
const inFlightBodyRequests = new Map(); // key: `${account}::${id}`

const toKey = (account, folder) => `${account}::${folder}`;
const accountKey = (account) => account || 'default';

// ============================================================================
// Manifest Management
// ============================================================================

async function getManifest(account, folder) {
  const key = toKey(account, folder);
  if (manifests.has(key)) return manifests.get(key);

  let existing = null;
  if (dbPort) {
    try {
      existing = await db.syncManifests.get([account, folder]);
    } catch (err) {
      console.warn('[sync.worker] getManifest failed:', err);
    }
  }

  const manifest = existing || {
    account,
    folder,
    lastUID: 0,
    lastModSeq: null,
    pagesFetched: 0,
    messagesFetched: 0,
    hasBodiesPass: false,
    lastSyncAt: 0,
    updatedAt: 0,
  };
  manifests.set(key, manifest);
  return manifest;
}

async function updateManifest(account, folder, updates = {}) {
  const manifest = await getManifest(account, folder);
  const next = {
    ...manifest,
    ...updates,
    account,
    folder,
    updatedAt: Date.now(),
  };
  manifests.set(toKey(account, folder), next);

  if (dbPort) {
    try {
      await db.syncManifests.put(next);
    } catch (err) {
      console.warn('[sync.worker] updateManifest failed:', err);
    }
  }
  return next;
}

// ============================================================================
// Utilities
// ============================================================================

function toUid(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : value || 0;
}

function coerceLabelList(value) {
  const normalizeLabel = (label) => {
    const normalized = String(label ?? '').trim();
    if (!normalized || /^\[\s*\]$/.test(normalized)) return '';
    return normalized;
  };
  if (Array.isArray(value)) {
    return value.map((label) => normalizeLabel(label)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((label) => normalizeLabel(label))
      .filter(Boolean);
  }
  return [];
}

function hasFromValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasMeaningfulDraft(draft) {
  return !!(
    (draft.to && draft.to.length > 0) ||
    (draft.cc && draft.cc.length > 0) ||
    (draft.bcc && draft.bcc.length > 0) ||
    (draft.subject && draft.subject.trim()) ||
    (draft.body && draft.body.trim())
  );
}

function buildDraftPayload(draft) {
  return {
    from: draft.from || draft.account || '',
    to: draft.to || [],
    cc: draft.cc || [],
    bcc: draft.bcc || [],
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
    folder: draft.folder || 'Drafts',
  };
}

async function syncDraftRecord(draft) {
  const payload = buildDraftPayload(draft);
  const url = draft.serverId
    ? `${apiBase.replace(/\/$/, '')}/v1/messages/${encodeURIComponent(draft.serverId)}`
    : `${apiBase.replace(/\/$/, '')}/v1/messages`;
  const res = await fetchWithTimeout(url, {
    method: draft.serverId ? 'PUT' : 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText || 'Request failed');
  }
  const json = await res.json();
  const serverId =
    json?.id ||
    json?.Id ||
    json?.message_id ||
    json?.messageId ||
    json?.Result?.id ||
    draft.serverId ||
    null;
  const updated = {
    ...draft,
    serverId,
    syncStatus: 'synced',
    lastError: null,
    lastSyncedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.drafts.put(updated);
  return updated;
}

// ============================================================================
// Fetch with Timeout
// ============================================================================

function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timeoutId),
  );
}

// ============================================================================
// Message Operations
// ============================================================================

async function writeMessages(account, folder, normalized, pendingDeleteIds: string[] = []) {
  if (!dbPort) {
    console.warn('[sync.worker] No db connection for writeMessages');
    return { inserted: 0, updated: 0 };
  }

  const keys = normalized.map((m) => [account, m.id]);
  const existingRecords = await db.messages.bulkGet(keys);
  const pendingSet = pendingDeleteIds.length ? new Set(pendingDeleteIds) : null;

  const toUpsert = [];
  const changedForIndex = [];
  let inserted = 0;
  let updated = 0;

  normalized.forEach((msg, idx) => {
    const existing = existingRecords[idx];
    if (!existing) {
      // Skip re-inserting messages that were optimistically deleted/moved
      if (pendingSet?.has(msg.id)) return;
      toUpsert.push(msg);
      changedForIndex.push(msg);
      inserted += 1;
      return;
    }

    const { record, changed } = mergeFlagsAndMetadata(existing, msg);
    if (changed) {
      toUpsert.push(record);
      changedForIndex.push(record);
      updated += 1;
    }
  });

  if (toUpsert.length) {
    await db.messages.bulkPut(toUpsert);
  }

  if (changedForIndex.length) {
    postToSearch('index', {
      account,
      includeBody: false,
      messages: changedForIndex,
    });
  }

  return { inserted, updated };
}

// ============================================================================
// API Operations
// ============================================================================

async function fetchMessageList(params = {}) {
  const url = new URL(`${apiBase.replace(/\/$/, '')}/v1/messages`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText || 'Request failed');
  }
  if (res.status === 204) {
    return { __noContent: true };
  }
  return res.json();
}

function parseResultList(res) {
  return res?.Result?.List || res?.Result || res || [];
}

async function runMetadataTask(task, postProgress) {
  const account = accountKey(task.account);
  const folder = task.folder;
  const limit = task.pageSize || DEFAULT_LIMIT;
  const maxMessages = task.maxMessages || Infinity;

  let manifest = await getManifest(account, folder);
  let lastUID = manifest?.lastUID || 0;
  let lastModSeq = manifest?.lastModSeq || null;
  let page = 1;
  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;

  while (true) {
    if (totalFetched >= maxMessages) break;

    const params = {
      folder,
      page,
      limit,
      after_uid: lastUID || undefined,
      since_modseq: lastModSeq || undefined,
      include_body: 0,
      raw: false,
      attachments: false,
    };

    const res = await fetchMessageList(params);
    const rawList = parseResultList(res);
    if (!Array.isArray(rawList) || !rawList.length) break;

    const normalized = rawList
      .map((item) => normalizeMessageForCache(item, folder, account))
      .filter((item) => item?.id);

    if (!normalized.length) break;

    const writeResult = await writeMessages(
      account,
      folder,
      normalized,
      task.pendingDeleteIds || [],
    );

    totalFetched += normalized.length;
    totalInserted += writeResult.inserted;
    totalUpdated += writeResult.updated;

    normalized.forEach((item) => {
      lastUID = Math.max(toUid(item.id), toUid(lastUID));
      if (item.modseq) {
        const modSeqNum = Number(item.modseq);
        if (Number.isFinite(modSeqNum)) {
          lastModSeq = Math.max(lastModSeq || 0, modSeqNum);
        } else {
          lastModSeq = item.modseq;
        }
      }
    });

    manifest = await updateManifest(account, folder, {
      lastUID,
      lastModSeq,
      pagesFetched: (manifest?.pagesFetched || 0) + 1,
      messagesFetched: (manifest?.messagesFetched || 0) + writeResult.inserted,
      lastSyncAt: Date.now(),
    });

    postProgress?.({
      type: 'progress',
      folder,
      stage: 'metadata',
      page,
      fetched: normalized.length,
      inserted: writeResult.inserted,
      updated: writeResult.updated,
      lastUID,
      lastModSeq,
      target: maxMessages,
    });

    if (writeResult.inserted === 0 && writeResult.updated === 0) {
      break;
    }

    if (totalFetched >= maxMessages) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
    page += 1;
  }

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    lastUID,
    lastModSeq,
  };
}

function worklistFromHeaders(headers, bodies, maxMessages) {
  const worklist = [];
  headers.slice(0, maxMessages || headers.length).forEach((msg, idx) => {
    const cached = bodies[idx];
    const hasAttachment = msg?.has_attachment;
    const hasStalePgp =
      cached?.body && typeof cached.body === 'string' && isPgpContent(cached.body);
    if (!cached?.body || hasStalePgp) {
      worklist.push(msg);
      return;
    }
    if (hasAttachment && !(cached.attachments || []).length) {
      worklist.push(msg);
    }
  });
  return worklist;
}

async function runBodiesTask(task, postProgress) {
  const account = accountKey(task.account);
  const folder = task.folder;
  const limit = task.limit || DEFAULT_BODY_LIMIT;
  const maxMessages = task.maxMessages || limit;

  if (!dbPort) {
    console.warn('[sync.worker] No db connection for runBodiesTask');
    return;
  }

  const headers = await db.messages.where('[account+folder]').equals([account, folder]).toArray();
  headers.sort((a, b) => (b.date || b.dateMs || 0) - (a.date || a.dateMs || 0));
  const sample = headers.slice(0, Math.min(maxMessages || headers.length, limit * 2));
  const bodies = await db.messageBodies.bulkGet(sample.map((m) => [account, m.id]));
  const worklist = worklistFromHeaders(sample, bodies, maxMessages).slice(0, limit);

  if (!worklist.length) {
    await updateManifest(account, folder, { hasBodiesPass: true, lastSyncAt: Date.now() });
    return;
  }

  let completed = 0;
  for (const msg of worklist) {
    await fetchAndCacheBody(account, folder, msg, { returnPayload: false });
    completed += 1;
    postProgress?.({
      type: 'progress',
      stage: 'bodies',
      folder,
      completed,
      total: worklist.length,
      target: maxMessages,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await updateManifest(account, folder, {
    hasBodiesPass: completed >= worklist.length,
    lastSyncAt: Date.now(),
  });
}

async function fetchAndCacheBody(account, folder, msg, options = {}) {
  return fetchAndCacheBodyWithOptions(account, folder, msg, options);
}

async function extractNestedAttachments(att) {
  try {
    if (!att.content || (!att.content.byteLength && typeof att.content !== 'string')) return [];
    const nestedParser = new PostalMime();
    const raw =
      typeof att.content === 'string' ? att.content : new TextDecoder().decode(att.content);
    const nested = await nestedParser.parse(raw);
    const results = [];
    for (const child of nested.attachments || []) {
      if ((child.mimeType || '').toLowerCase() === 'message/rfc822' && child.content) {
        // Recurse into nested message/rfc822
        const deeper = await extractNestedAttachments(child);
        results.push(...deeper);
        const childSubject = '(attached email)';
        const childName = child.filename || `${childSubject}.eml`;
        results.push({
          name: childName,
          filename: childName,
          size: child.size || child.content?.length || 0,
          contentId: child.contentId || undefined,
          disposition: 'attachment',
          href: bufferToDataUrl({
            content: child.content,
            contentType: 'message/rfc822',
          }),
          contentType: 'message/rfc822',
        });
      } else {
        results.push({
          name: child.filename || 'attachment',
          filename: child.filename || 'attachment',
          size: child.size || child.content?.length || 0,
          contentId: child.contentId || undefined,
          disposition: (child.disposition || '').toLowerCase(),
          href: bufferToDataUrl({
            content: child.content,
            contentType: child.mimeType || child.contentType || 'application/octet-stream',
          }),
          contentType: child.mimeType || child.contentType || 'application/octet-stream',
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function parseRawMessage(raw, existingAttachments = []) {
  if (!raw) return null;
  try {
    const parser = new PostalMime();
    const email = await parser.parse(raw);

    // Convert postal-mime attachments to data URLs
    // First pass: collect all parent-level attachments (these take dedup priority).
    // For message/rfc822 parts, add the .eml itself now but defer nested extraction.
    const parentAttachments = [];
    const rfc822Parts = [];
    for (const att of email.attachments || []) {
      if ((att.mimeType || '').toLowerCase() === 'message/rfc822' && att.content) {
        rfc822Parts.push(att);
        const emlName = att.filename || 'attached-email.eml';
        parentAttachments.push({
          name: emlName,
          filename: emlName,
          size: att.size || att.content?.length || 0,
          contentId: att.contentId || undefined,
          disposition: 'attachment',
          href: bufferToDataUrl({
            content: att.content,
            contentType: 'message/rfc822',
          }),
          contentType: 'message/rfc822',
        });
      } else {
        parentAttachments.push({
          name: att.filename || 'attachment',
          filename: att.filename || 'attachment',
          size: att.size || att.content?.length || 0,
          contentId: att.contentId || undefined,
          disposition: (att.disposition || '').toLowerCase(),
          href: bufferToDataUrl({
            content: att.content,
            contentType: att.mimeType || att.contentType || 'application/octet-stream',
          }),
          contentType: att.mimeType || att.contentType || 'application/octet-stream',
        });
      }
    }

    // Second pass: extract nested attachments from rfc822 parts.
    // Added after parent attachments so dedup prefers the parent versions.
    const nestedAttachments = [];
    for (const rfc of rfc822Parts) {
      const nested = await extractNestedAttachments(rfc);
      nestedAttachments.push(...nested);
    }
    const attachments = [...parentAttachments, ...nestedAttachments];

    // Merge with existing attachments and filter out PGP-related files
    // PostalMime attachments come first so they win deduplication (they have data URL hrefs)
    const merged = [...attachments, ...existingAttachments].filter((att) => {
      const filename = (att.filename || att.name || '').toLowerCase();
      const contentType = (att.contentType || '').toLowerCase();

      // Filter out PGP-related attachments
      if (/\.asc$/i.test(filename)) return false;
      if (/^application\/pgp/i.test(contentType)) return false;
      if (filename === 'encrypted.asc' || filename === 'msg.asc') return false;
      if (/version\.txt/i.test(filename)) return false;
      if (/(pgp|gpg)/i.test(filename)) return false;

      return true;
    });

    // Deduplicate by CID or filename+size
    const seen = new Set();
    const deduped = merged.filter((att) => {
      const cid = (att.contentId || '').replace(/^<|>$/g, '');
      const key = cid ? `cid:${cid}` : `file:${att.filename || att.name || ''}:${att.size || 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Use HTML if available, otherwise wrap text in <pre>
    // Never fall back to raw MIME source — it contains headers that should not be displayed
    const body =
      email.html || (email.text ? `<pre style="white-space:pre-wrap">${email.text}</pre>` : '');

    // Apply inline attachments (cid: → data:)
    const inlined = applyInlineAttachments(body, deduped);

    return {
      body: inlined, // Has data URLs embedded - safe to cache!
      rawBody: body,
      attachments: deduped,
      textContent: email.text || extractTextContent(body),
    };
  } catch (error) {
    console.warn('[sync.worker] postal-mime parse failed', error);
    return null;
  }
}

async function fetchAndCacheBodyWithOptions(account, folder, msg, options = {}) {
  const { returnPayload = false } = options;
  const apiId = msg?.id || msg?.uid;
  if (!apiId) return;

  const requestKey = `${account}::${apiId}`;
  const persistBody = async (body, textContent, attachments = []) => {
    if (dbPort) {
      await db.messageBodies.put({
        id: apiId,
        account,
        folder,
        body,
        textContent,
        attachments,
        updatedAt: Date.now(),
      });
    }

    postToSearch('index', {
      account,
      includeBody: true,
      messages: [
        {
          id: apiId,
          folder,
          from: msg.from,
          to: msg.to,
          cc: msg.cc,
          subject: msg.subject,
          snippet: msg.snippet,
          date: msg.date || msg.dateMs,
          labels: msg.labels || msg.labelIds || msg.label_ids || [],
          body,
          textContent,
        },
      ],
    });

    return {
      id: apiId,
      folder,
      body,
      textContent,
      attachments,
    };
  };
  if (dbPort) {
    try {
      const cached = await db.messageBodies.get([account, apiId]);
      // Detect stale cache: raw PGP/MIME was incorrectly stored as body
      const isStalePgpBody =
        cached?.body && typeof cached.body === 'string' && isPgpContent(cached.body);
      if (cached?.body && !isStalePgpBody) {
        if (returnPayload) {
          return {
            id: apiId,
            folder: cached.folder || folder,
            body: cached.body,
            textContent: cached.textContent || '',
            attachments: cached.attachments || [],
          };
        }
        return;
      }
    } catch {
      // ignore cache lookup errors
    }
  }

  if (inFlightBodyRequests.has(requestKey)) {
    const pending = await inFlightBodyRequests.get(requestKey);
    if (returnPayload) return pending;
    return;
  }

  const requestPromise = (async () => {
    const url = new URL(
      `${apiBase.replace(/\/$/, '')}/v1/messages/${encodeURIComponent(apiId)}?folder=${encodeURIComponent(folder || '')}&raw=true`,
    );

    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText || 'Request failed');
    }
    const json = await res.json();
    const result = json?.Result || json;
    const raw = result?.raw;
    let body = '';
    let textContent = '';
    let attachments = [];

    if (raw) {
      const isPgp = isPgpContent(raw);
      if (isPgp) {
        const decrypted = await decryptPgp(raw);
        if (!decrypted) {
          // Return raw data so main thread can attempt PGP decryption without re-fetching
          return { id: apiId, folder, pgpLocked: true, raw };
        }
        const parsed = await parseRawMessage(decrypted);
        if (parsed) {
          body = parsed.body;
          textContent = parsed.textContent;
          attachments = parsed.attachments;
        }
      } else {
        const parsed = await parseRawMessage(raw);
        if (parsed) {
          body = parsed.body;
          textContent = parsed.textContent;
          attachments = parsed.attachments;
        }
      }
    } else {
      const serverText =
        result?.Plain ||
        result?.text ||
        result?.body ||
        result?.preview ||
        result?.nodemailer?.text ||
        result?.nodemailer?.preview;
      const html =
        result?.html ||
        result?.Html ||
        result?.textAsHtml ||
        result?.nodemailer?.html ||
        result?.nodemailer?.textAsHtml ||
        serverText ||
        msg.snippet ||
        '';

      const detailAttachments = result?.nodemailer?.attachments || result?.attachments || [];
      attachments = (detailAttachments || []).map((att) => {
        const contentId = att.cid || att.contentId;
        const disposition = (att.disposition || att.contentDisposition || '')
          .toString()
          .toLowerCase();
        const isInline = disposition === 'inline' || !!contentId;
        const hasUrl = !!att.url;

        let href;
        if (hasUrl) {
          href = att.url;
        } else if (isInline && att.content) {
          href = bufferToDataUrl(att);
        }

        return {
          name: att.name || att.filename,
          filename: att.filename || att.name,
          size: att.size || att.content?.byteLength || att.content?.length || 0,
          contentId,
          disposition,
          href,
          contentType: att.contentType || att.mimeType || att.type,
          needsDownload: !href && !hasUrl,
        };
      });
      const inlined = applyInlineAttachments(html, attachments);
      body = inlined;
      textContent = serverText || extractTextContent(inlined);
    }

    return await persistBody(body, textContent, attachments);
  })();

  inFlightBodyRequests.set(requestKey, requestPromise);
  try {
    const result = await requestPromise;
    if (returnPayload) return result;
  } finally {
    inFlightBodyRequests.delete(requestKey);
  }
}

/**
 * Extract PGP armor block from raw content (handles PGP/MIME).
 */
function extractPgpArmor(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const beginIdx = raw.indexOf('-----BEGIN PGP MESSAGE-----');
  const endIdx = raw.indexOf('-----END PGP MESSAGE-----');
  if (beginIdx >= 0 && endIdx > beginIdx) {
    return raw.substring(beginIdx, endIdx + '-----END PGP MESSAGE-----'.length);
  }
  return raw;
}

/**
 * Detect if raw content is PGP-encrypted (inline or PGP/MIME).
 */
function isPgpContent(raw) {
  if (!raw || typeof raw !== 'string') return false;
  if (raw.includes('-----BEGIN PGP MESSAGE-----')) return true;
  if (raw.includes('multipart/encrypted') && raw.includes('application/pgp-encrypted')) return true;
  return false;
}

let lastDecryptError = '';

async function decryptPgp(armored) {
  lastDecryptError = '';
  if (!armored || !unlockedPgpKeys.length) return '';

  const hasInlineArmor = armored.includes('-----BEGIN PGP MESSAGE-----');
  const hasMimeHeaders = armored.includes('multipart/encrypted');

  try {
    // Extract just the PGP armor if embedded in MIME content
    let pgpBlock = extractPgpArmor(armored);

    // For PGP/MIME: if no inline armor found, extract the encrypted part from MIME structure
    if (!pgpBlock.includes('-----BEGIN PGP MESSAGE-----') && isPgpContent(armored)) {
      // Strategy 1: Manual boundary parsing (most reliable for PGP/MIME)
      const boundaryMatch = armored.match(/boundary="?([^";\s]+)"?/i);
      if (boundaryMatch) {
        const boundary = boundaryMatch[1];
        const parts = armored.split('--' + boundary);
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (part.includes('application/octet-stream') || part.includes('application/pgp-keys')) {
            const headerEnd =
              part.indexOf('\r\n\r\n') !== -1
                ? part.indexOf('\r\n\r\n') + 4
                : part.indexOf('\n\n') !== -1
                  ? part.indexOf('\n\n') + 2
                  : -1;
            if (headerEnd > 0) {
              const body = part.substring(headerEnd).trim();
              const extracted = extractPgpArmor(body);
              if (extracted.includes('-----BEGIN PGP MESSAGE-----')) {
                pgpBlock = extracted;
                break;
              }
            }
          }
        }
      }

      // Strategy 2: PostalMime fallback
      if (!pgpBlock.includes('-----BEGIN PGP MESSAGE-----')) {
        try {
          const parser = new PostalMime();
          const parsed = await parser.parse(armored);
          const pgpPart = parsed.attachments?.find(
            (a) => a.mimeType === 'application/octet-stream' && a.content,
          );
          if (pgpPart?.content) {
            const decoded =
              typeof pgpPart.content === 'string'
                ? pgpPart.content
                : new TextDecoder().decode(pgpPart.content);
            const extracted = extractPgpArmor(decoded);
            if (extracted.includes('-----BEGIN PGP MESSAGE-----')) {
              pgpBlock = extracted;
            }
          }
        } catch {
          // PostalMime fallback failed, continue
        }
      }
    }

    if (!pgpBlock.includes('-----BEGIN PGP MESSAGE-----')) {
      if (hasMimeHeaders) {
        console.warn(
          '[sync.worker] PGP/MIME extraction failed. Raw length:',
          armored?.length,
          'Has BEGIN:',
          hasInlineArmor,
          'First 500 chars:',
          armored?.substring(0, 500),
        );
        lastDecryptError =
          'PGP/MIME message has empty encrypted payload — the API response may be incomplete.';
      } else {
        lastDecryptError = 'No PGP armor block found in message content.';
      }
      return '';
    }

    const message = await openpgp.readMessage({ armoredMessage: pgpBlock });

    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: unlockedPgpKeys,
    });
    return data || '';
  } catch (err) {
    lastDecryptError = err?.message || String(err);
    console.warn('[sync.worker] PGP decryption failed:', lastDecryptError);
    return '';
  }
}

// ============================================================================
// PGP Decryption Task Handler
// ============================================================================

/**
 * Handle on-demand message decryption from main thread
 * This allows the main thread to request decryption without importing openpgp
 */
async function handleDecryptMessageTask(task) {
  const { raw } = task;

  if (!raw || typeof raw !== 'string') {
    return {
      success: false,
      reason: 'invalid_input',
      message: 'No raw message provided',
      keyCount: unlockedPgpKeys.length,
    };
  }

  if (!isPgpContent(raw)) {
    return {
      success: false,
      reason: 'not_pgp',
      message: 'Message is not PGP encrypted',
      keyCount: unlockedPgpKeys.length,
    };
  }

  if (!unlockedPgpKeys.length) {
    return {
      success: false,
      reason: 'no_keys',
      message: 'No unlocked PGP keys available. Add or unlock a key in Settings.',
      keyCount: 0,
    };
  }

  // Attempt decryption with all unlocked keys (openpgp.js tries each automatically)
  const decrypted = await decryptPgp(raw);
  if (!decrypted) {
    const detail = lastDecryptError ? ` (${lastDecryptError})` : '';
    return {
      success: false,
      reason: 'decrypt_failed',
      message: `None of your ${unlockedPgpKeys.length} unlocked key(s) could decrypt this message.${detail}`,
      keyCount: unlockedPgpKeys.length,
    };
  }

  // Parse the decrypted content
  let parsed = null;
  try {
    parsed = await parseRawMessage(decrypted);
  } catch {
    // If parsing fails, return raw decrypted content
    return {
      success: true,
      body: decrypted,
      textContent: extractTextContent(decrypted),
      attachments: [],
      rawDecrypted: true,
      keyCount: unlockedPgpKeys.length,
    };
  }

  return {
    success: true,
    body: parsed.body,
    textContent: parsed.textContent,
    attachments: parsed.attachments,
    keyCount: unlockedPgpKeys.length,
  };
}

/**
 * Handle MIME parsing request from main thread (Phase 3 optimization)
 * This allows main thread to delegate all MIME parsing to worker
 */
async function handleParseRawTask(task) {
  const { raw, existingAttachments = [] } = task;

  if (!raw) {
    return { success: false, error: 'No raw message provided' };
  }

  const parsed = await parseRawMessage(raw, existingAttachments);
  if (!parsed) {
    return { success: false, error: 'Parse failed' };
  }

  return {
    success: true,
    body: parsed.body,
    rawBody: parsed.rawBody,
    textContent: parsed.textContent,
    attachments: parsed.attachments,
  };
}

// ============================================================================
// Task Handlers
// ============================================================================

async function handleTask(taskId, task) {
  try {
    if (!apiBase || !authHeader) {
      throw new Error('Worker not initialized');
    }
    if (!task?.type) throw new Error('Missing task type');

    let summary = null;
    if (task.type === 'metadata') {
      summary = await runMetadataTask(task, (p) => {
        self.postMessage({ ...p, taskId });
      });
    } else if (task.type === 'bodies') {
      await runBodiesTask(task, (p) => {
        self.postMessage({ ...p, taskId });
      });
    } else if (task.type === 'drafts') {
      await runDraftSyncTask(task, (p) => {
        self.postMessage({ ...p, taskId });
      });
    } else if (task.type === 'decryptMessage') {
      summary = await handleDecryptMessageTask(task);
    } else if (task.type === 'parseRaw') {
      summary = await handleParseRawTask(task);
    } else {
      throw new Error(`Unsupported task type: ${task.type}`);
    }
    self.postMessage({
      type: 'taskComplete',
      taskId,
      folder: task.folder,
      taskType: task.type,
      account: task.account,
      ...(summary || {}),
    });
  } catch (err) {
    self.postMessage({
      type: 'taskError',
      taskId,
      folder: task?.folder,
      account: task?.account,
      error: err?.message || String(err),
    });
  }
}

async function fetchFolders(account) {
  const url = new URL(`${apiBase.replace(/\/$/, '')}/v1/folders`);
  const res = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText || 'Request failed');
  }
  const json = await res.json();
  const raw = json?.Result || json || [];
  const list = Array.isArray(raw) ? raw : raw.Items || raw.items || [];

  if (dbPort) {
    await db.folders.where('account').equals(account).delete();
    await db.folders.bulkPut(
      list.map((f) => ({
        ...f,
        account,
        updatedAt: Date.now(),
      })),
    );
  }

  return { folders: list };
}

async function fetchMessagePage(payload = {}) {
  const account = accountKey(payload.account);
  const folder = payload.folder;
  const limit = payload.limit || DEFAULT_LIMIT;

  const params = {
    folder,
    page: payload.page || 1,
    limit,
    raw: false,
    attachments: false,
    ...(payload.fields ? { fields: payload.fields } : {}),
    ...(payload.sort ? { sort: payload.sort } : {}),
    ...(payload.search ? { search: payload.search } : {}),
    ...(payload.is_unread ? { is_unread: true } : {}),
    ...(payload.has_attachments || payload.has_attachment ? { has_attachments: true } : {}),
  };

  const res = await fetchMessageList(params);
  if (res?.__noContent) {
    return { messages: null, hasNextPage: false, noContent: true };
  }
  const rawList = parseResultList(res);
  const list = Array.isArray(rawList) ? rawList : [];
  if (!list.length) {
    return { messages: [], hasNextPage: false };
  }

  const normalized = [];
  const labelPresence = [];
  for (const item of list) {
    const record = normalizeMessageForCache(item, folder, account);
    if (!record?.id) continue;
    const incomingLabels = coerceLabelList(record.labels);
    normalized.push({
      ...record,
      normalizedSubject: normalizeSubject(record.subject),
      threadId: item.threadId || item.ThreadId || item.thread_id || record.thread_id,
      in_reply_to:
        record.in_reply_to ||
        item.in_reply_to ||
        item.inReplyTo ||
        item['In-Reply-To'] ||
        item?.nodemailer?.headers?.['in-reply-to'] ||
        item?.nodemailer?.headers?.['In-Reply-To'] ||
        null,
      references:
        record.references ||
        item.references ||
        item.References ||
        item?.nodemailer?.headers?.references ||
        item?.nodemailer?.headers?.References ||
        null,
    });
    labelPresence.push(incomingLabels.length > 0);
  }

  let toStore = normalized;
  if (normalized.length && dbPort) {
    if (labelPresence.some((hasLabels) => !hasLabels)) {
      const keys = normalized.map((msg) => [account, msg.id]);
      const existingRecords = await db.messages.bulkGet(keys);
      const fallbackKeys = [];
      const fallbackIndex = new Map();
      normalized.forEach((msg, idx) => {
        const uid = msg?.uid;
        const candidates = [uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
        for (const candidate of candidates) {
          if (candidate === msg?.id) continue;
          fallbackIndex.set(`${idx}:${candidate}`, fallbackKeys.length);
          fallbackKeys.push([account, candidate]);
        }
      });
      const fallbackRecords = fallbackKeys.length ? await db.messages.bulkGet(fallbackKeys) : [];
      toStore = normalized.map((msg, idx) => {
        const incoming = coerceLabelList(msg.labels);
        if (incoming.length > 0) return msg;
        const existing = existingRecords[idx];
        const existingLabels = coerceLabelList(existing?.labels);
        if (existingLabels.length) {
          return { ...msg, labels: existingLabels };
        }
        const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
        for (const candidate of candidates) {
          const key = `${idx}:${candidate}`;
          if (!fallbackIndex.has(key)) continue;
          const fallback = fallbackRecords[fallbackIndex.get(key)];
          const fallbackLabels = coerceLabelList(fallback?.labels);
          if (fallbackLabels.length) {
            return { ...msg, labels: fallbackLabels };
          }
        }
        return msg;
      });
    }

    if (toStore.length) {
      const fromKeys = [];
      const fromIndices = [];
      const fallbackKeys = [];
      const fallbackIndex = new Map();
      toStore.forEach((msg, idx) => {
        if (hasFromValue(msg?.from)) return;
        fromKeys.push([account, msg.id]);
        fromIndices.push(idx);
        const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
        for (const candidate of candidates) {
          if (candidate === msg?.id) continue;
          fallbackIndex.set(`${idx}:${candidate}`, fallbackKeys.length);
          fallbackKeys.push([account, candidate]);
        }
      });
      if (fromKeys.length) {
        const existingFrom = await db.messages.bulkGet(fromKeys);
        const fallbackRecords = fallbackKeys.length ? await db.messages.bulkGet(fallbackKeys) : [];
        const next = toStore.slice();
        existingFrom.forEach((record, i) => {
          const idx = fromIndices[i];
          if (idx === undefined) return;
          if (hasFromValue(record?.from)) {
            next[idx] = { ...next[idx], from: record.from };
            return;
          }
          const msg = toStore[idx] || {};
          const candidates = [msg?.uid, msg?.message_id, msg?.header_message_id].filter(Boolean);
          for (const candidate of candidates) {
            const key = `${idx}:${candidate}`;
            if (!fallbackIndex.has(key)) continue;
            const fallback = fallbackRecords[fallbackIndex.get(key)];
            if (hasFromValue(fallback?.from)) {
              next[idx] = { ...next[idx], from: fallback.from };
              break;
            }
          }
        });
        toStore = next;
      }
    }

    await db.messages.bulkPut(toStore);
    postToSearch('index', {
      account,
      includeBody: false,
      messages: toStore,
    });
  }

  return { messages: toStore, hasNextPage: list.length >= limit };
}

async function fetchMessageDetail(payload = {}) {
  const account = accountKey(payload.account);
  const message = payload.message || {};
  const folder = payload.folder || message.folder;
  const record = await fetchAndCacheBodyWithOptions(account, folder, message, {
    returnPayload: true,
  });
  return record || { id: message?.id, folder, missing: true };
}

async function runDraftSyncTask(task, postProgress) {
  if (!dbPort) {
    throw new Error('Database worker not connected');
  }
  const account = accountKey(task?.account);
  const drafts = await db.drafts.where('account').equals(account).toArray();
  const pending = drafts.filter((draft) => draft && draft.syncStatus !== 'synced');
  const candidates = pending.filter((draft) => hasMeaningfulDraft(draft));
  if (!candidates.length) {
    postProgress?.({ type: 'progress', stage: 'drafts', account, total: 0, synced: 0, failed: 0 });
    return;
  }

  let synced = 0;
  let failed = 0;
  postProgress?.({
    type: 'progress',
    stage: 'drafts',
    account,
    total: candidates.length,
    synced,
    failed,
  });
  for (const draft of candidates) {
    try {
      await syncDraftRecord(draft);
      synced += 1;
    } catch (err) {
      failed += 1;
      const failedDraft = {
        ...draft,
        syncStatus: 'pending',
        lastError: err?.message || 'Draft sync failed',
        updatedAt: Date.now(),
      };
      await db.drafts.put(failedDraft);
    }
    postProgress?.({
      type: 'progress',
      stage: 'drafts',
      account,
      total: candidates.length,
      synced,
      failed,
    });
  }
}

async function handleRequest(requestId, action, payload) {
  try {
    if (!apiBase || !authHeader) {
      throw new Error('Worker not initialized');
    }
    let result = null;
    if (action === 'folders') {
      const account = accountKey(payload?.account);
      result = await fetchFolders(account);
    } else if (action === 'messagePage') {
      result = await fetchMessagePage(payload || {});
    } else if (action === 'messageDetail') {
      result = await fetchMessageDetail(payload || {});
    } else if (action === 'unlockPgpKey') {
      result = await unlockPgpKeyWithPassphrase(payload || {});
    } else {
      throw new Error(`Unsupported request action: ${action}`);
    }
    self.postMessage({ type: 'requestComplete', requestId, action, result });
  } catch (err) {
    self.postMessage({
      type: 'requestError',
      requestId,
      action,
      error: err?.message || String(err),
    });
  }
}

// ============================================================================
// PGP Key Management
// ============================================================================

async function updatePgpKeys(keys = [], passphrases = {}) {
  pgpPassphrases = passphrases || {};
  const unlocked = [];
  for (const key of keys) {
    if (!key?.value) continue;
    const privateKey = await openpgp.readPrivateKey({ armoredKey: key.value });
    if (!privateKey.isDecrypted()) {
      const passphrase = pgpPassphrases[key.name];
      if (passphrase) {
        try {
          const unlockedKey = await openpgp.decryptKey({
            privateKey,
            passphrase,
          });
          unlocked.push(unlockedKey);
        } catch (err) {
          console.warn('[sync.worker] Failed to auto-unlock PGP key', key.name, err?.message);
          delete pgpPassphrases[key.name];
        }
      }
    } else {
      unlocked.push(privateKey);
    }
  }
  unlockedPgpKeys = unlocked;
}

/**
 * Unlock a specific PGP key with a passphrase from the main thread
 * This is called when the user provides a passphrase via the modal
 * If no passphrase is provided, checks if the key is unprotected
 */
async function unlockPgpKeyWithPassphrase({
  keyName,
  passphrase,
  keyValue,
  remember = false,
  checkOnly = false,
}) {
  try {
    if (!keyValue) {
      return {
        success: false,
        error: 'Missing key value',
      };
    }

    const privateKey = await openpgp.readPrivateKey({ armoredKey: keyValue });

    if (privateKey.isDecrypted()) {
      // Key is already unlocked (unprotected key) - no passphrase needed
      if (!checkOnly) {
        const alreadyUnlocked = unlockedPgpKeys.find(
          (k) => k.getFingerprint() === privateKey.getFingerprint(),
        );
        if (!alreadyUnlocked) {
          unlockedPgpKeys.push(privateKey);
        }
      }
      return { success: true, alreadyUnlocked: true, needsPassphrase: false };
    }

    // Key is encrypted and needs a passphrase
    if (checkOnly) {
      // Just checking status, don't try to decrypt
      return { success: false, needsPassphrase: true };
    }

    if (!passphrase) {
      return {
        success: false,
        needsPassphrase: true,
        error: 'Key requires passphrase',
      };
    }

    const unlockedKey = await openpgp.decryptKey({
      privateKey,
      passphrase,
    });

    // Store the passphrase if requested
    if (remember && keyName) {
      pgpPassphrases[keyName] = passphrase;
    }

    // Add to unlocked keys or replace existing
    const existingIndex = unlockedPgpKeys.findIndex(
      (k) => k.getFingerprint() === unlockedKey.getFingerprint(),
    );

    if (existingIndex >= 0) {
      unlockedPgpKeys[existingIndex] = unlockedKey;
    } else {
      unlockedPgpKeys.push(unlockedKey);
    }

    return {
      success: true,
      keyCount: unlockedPgpKeys.length,
      needsPassphrase: false,
    };
  } catch (error) {
    return {
      success: false,
      needsPassphrase: true,
      error: error?.message || 'Failed to unlock key',
    };
  }
}

// ============================================================================
// Search Worker Communication
// ============================================================================

function postToSearch(action, payload) {
  if (!searchPort) {
    return;
  }
  searchPort.postMessage({ action, payload });
}

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = (event) => {
  const data = event?.data || {};

  // Handle database port connection
  if (data.type === 'connectDbPort' && event.ports?.[0]) {
    dbPort = event.ports[0];
    dbPort.onmessage = handleDbResponse;
    dbPort.start();
    return;
  }

  if (data.type === 'init') {
    apiBase = data.config?.apiBase || '';
    authHeader = data.config?.authHeader || '';
    return;
  }
  if (data.type === 'task') {
    handleTask(data.taskId, data.task);
    return;
  }
  if (data.type === 'request') {
    handleRequest(data.requestId, data.action, data.payload);
    return;
  }
  if (data.type === 'pgpKeys') {
    updatePgpKeys(data.keys || [], data.passphrases || {});
    return;
  }
  if (data.type === 'connectSearchPort' && event.ports?.[0]) {
    searchPort = event.ports[0];
    searchPort.start();
    return;
  }
};
