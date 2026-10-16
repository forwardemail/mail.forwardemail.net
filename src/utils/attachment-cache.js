import { db } from './db';
import { Local } from './storage';
import { warn } from './logger.ts';

/**
 * Attachment Blob Cache
 *
 * Caches downloaded attachment blobs in the IndexedDB `meta` table
 * for offline access. Manages quota to prevent unbounded growth.
 */

const ATTACHMENT_KEY_PREFIX = 'att_blob_';
const MANIFEST_KEY = 'att_cache_manifest';
const MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50 MB total
const MAX_SINGLE_BYTES = 5 * 1024 * 1024; // 5 MB per attachment

function getAccount() {
  return Local.get('email') || 'default';
}

/**
 * Normalize the attachment argument. Callers may pass just the filename (the
 * old form) or `{ filename, partId, contentId, index }`. A message can carry
 * two attachments with the same filename, so anything that tells them apart
 * becomes part of the cache key.
 */
function attachmentRef(attachment) {
  if (attachment && typeof attachment === 'object') {
    const filename = attachment.filename || attachment.name || '';
    const part =
      attachment.partId ??
      attachment.part ??
      attachment.contentId ??
      attachment.cid ??
      attachment.index ??
      null;
    return { filename, part: part === null || part === '' ? null : String(part) };
  }
  return { filename: attachment || '', part: null };
}

function blobKey(account, messageId, ref) {
  const base = `${ATTACHMENT_KEY_PREFIX}${account}_${messageId}_${ref.filename}`;
  return ref.part === null ? base : `${base}#${ref.part}`;
}

/**
 * Decoded byte length of a data URL (or a bare base64 string), so the limits
 * and the manifest count what the attachment actually weighs rather than an
 * optional size hint from the server.
 */
export function dataUrlByteLength(dataUrl) {
  if (typeof dataUrl !== 'string') return 0;
  const comma = dataUrl.indexOf(',');
  const isDataUrl = dataUrl.startsWith('data:') && comma !== -1;
  const header = isDataUrl ? dataUrl.slice(0, comma) : '';
  const payload = isDataUrl ? dataUrl.slice(comma + 1) : dataUrl;
  if (isDataUrl && !/;base64$/i.test(header)) {
    // Percent-encoded text payload.
    try {
      return new TextEncoder().encode(decodeURIComponent(payload)).length;
    } catch {
      return payload.length;
    }
  }
  const clean = payload.replace(/\s/g, '');
  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

// Every manifest read-modify-write goes through this chain. Two downloads
// finishing together used to read the same manifest, and the second write
// dropped the first one's entry (its blob then lived on outside the quota).
let manifestChain = Promise.resolve();

function withManifestLock(fn) {
  const run = manifestChain.then(fn, fn);
  manifestChain = run.catch(() => {});
  return run;
}

/**
 * Read the cache manifest (tracks size + entries for eviction).
 */
async function readManifest() {
  try {
    const record = await db.meta.get(MANIFEST_KEY);
    const manifest = record?.value;
    if (manifest && Array.isArray(manifest.entries)) {
      return {
        totalBytes: Number(manifest.totalBytes) || 0,
        entries: manifest.entries,
      };
    }
  } catch {
    // fall through to an empty manifest
  }
  return { totalBytes: 0, entries: [] };
}

/**
 * Write the cache manifest.
 */
async function writeManifest(manifest) {
  await db.meta.put({ key: MANIFEST_KEY, value: manifest, updatedAt: Date.now() });
}

/**
 * Evict oldest entries until total size is under the limit.
 */
async function evictIfNeeded(manifest, neededBytes) {
  while (manifest.totalBytes + neededBytes > MAX_CACHE_BYTES && manifest.entries.length > 0) {
    const oldest = manifest.entries.shift();
    if (!oldest) break;
    manifest.totalBytes = Math.max(0, manifest.totalBytes - (Number(oldest.size) || 0));
    try {
      await db.meta.delete(oldest.key);
    } catch {
      // Best effort
    }
  }
}

/**
 * Cache an attachment blob.
 *
 * @param {string} messageId - Message API ID
 * @param {string|{filename?: string, name?: string, partId?: string, contentId?: string, index?: number}} attachment
 *   Attachment filename, or an object that also identifies the MIME part
 * @param {string} dataUrl - The data URL (data:mime;base64,...) to cache. Its
 *   decoded size is what counts against the limits; a size passed as a fourth
 *   argument by older callers is ignored.
 */
export async function cacheAttachmentBlob(messageId, attachment, dataUrl) {
  const ref = attachmentRef(attachment);
  if (!messageId || !ref.filename || !dataUrl) return;
  const size = dataUrlByteLength(dataUrl);
  if (!size || size > MAX_SINGLE_BYTES) return; // Skip empty and large attachments

  const account = getAccount();
  const key = blobKey(account, messageId, ref);

  try {
    await withManifestLock(async () => {
      const manifest = await readManifest();

      // Check if already cached
      if (manifest.entries.some((e) => e.key === key)) return;

      // Evict old entries if needed
      await evictIfNeeded(manifest, size);

      // Store the blob
      await db.meta.put({ key, value: dataUrl, updatedAt: Date.now() });

      // Update manifest
      manifest.entries.push({
        key,
        size,
        account,
        messageId,
        filename: ref.filename,
        part: ref.part,
        cachedAt: Date.now(),
      });
      manifest.totalBytes += size;
      await writeManifest(manifest);
    });
  } catch (err) {
    warn('[attachment-cache] Failed to cache attachment', err);
  }
}

/**
 * Retrieve a cached attachment blob.
 *
 * @param {string} messageId - Message API ID
 * @param {string|object} attachment - Filename, or the same object passed to cacheAttachmentBlob
 * @returns {Promise<string|null>} The cached data URL, or null
 */
export async function getCachedAttachmentBlob(messageId, attachment) {
  const ref = attachmentRef(attachment);
  if (!messageId || !ref.filename) return null;

  const account = getAccount();
  const key = blobKey(account, messageId, ref);

  try {
    const record = await db.meta.get(key);
    return record?.value || null;
  } catch {
    return null;
  }
}

/**
 * Clear every cached attachment blob, for all accounts.
 */
export async function clearAttachmentCache() {
  try {
    await withManifestLock(async () => {
      const manifest = await readManifest();
      for (const entry of manifest.entries) {
        await db.meta.delete(entry.key).catch(() => {});
      }
      await writeManifest({ totalBytes: 0, entries: [] });
    });
  } catch {
    // Best effort
  }
}

/**
 * Remove one account's cached attachment blobs and their manifest entries.
 * Call when an account is removed: the manifest is shared by all accounts, so
 * clearing the account's other cache tables leaves these behind otherwise.
 * Blobs missing from the manifest (written before an earlier crash) are
 * swept by key prefix too.
 *
 * @param {string} account - Account email
 * @returns {Promise<number>} Number of manifest entries removed
 */
export async function clearAttachmentCacheForAccount(account) {
  if (!account) return 0;
  const prefix = `${ATTACHMENT_KEY_PREFIX}${account}_`;
  try {
    return await withManifestLock(async () => {
      const manifest = await readManifest();
      const keep = [];
      let removed = 0;
      for (const entry of manifest.entries) {
        const belongs =
          entry.account === account ||
          (typeof entry.key === 'string' && entry.key.startsWith(prefix));
        if (belongs) {
          await db.meta.delete(entry.key).catch(() => {});
          removed += 1;
        } else {
          keep.push(entry);
        }
      }
      await db.meta
        .where('key')
        .startsWith(prefix)
        .delete()
        .catch(() => {});
      const totalBytes = keep.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);
      await writeManifest({ totalBytes, entries: keep });
      return removed;
    });
  } catch (err) {
    warn('[attachment-cache] Failed to clear account attachments', err);
    return 0;
  }
}
