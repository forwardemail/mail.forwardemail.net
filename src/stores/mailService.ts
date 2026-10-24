import { Remote } from '../utils/remote.js';
import Dexie from 'dexie';
import { db } from '../utils/db.js';
import { Local } from '../utils/storage.js';
import { sanitizeHtml } from '../utils/sanitize.js';
import { formatFriendlyDate } from '../utils/date.ts';
import { createPerfTracer } from '../utils/perf-logger.ts';
import { createPgpModal } from '../utils/pgp-key-prompt.ts';
import { abortIfNeeded, getMessageApiId } from '../utils/sync-helpers.ts';
import {
  sendSyncRequest,
  refreshSyncWorkerPgpKeys,
  requestPgpDecryption,
  unlockPgpKey,
  requestParsing,
} from '../utils/sync-worker-client.js';
import {
  bufferToDataUrl,
  applyInlineAttachments,
  extractTextContent,
} from '../utils/mime-utils.js';
import { getCachedAttachmentBlob, cacheAttachmentBlob } from '../utils/attachment-cache.js';
import { isTauri } from '../utils/platform.js';
import { isMemoryConstrained } from '../utils/memory-profile';
import { slimBodyMeta, slimCachedAttachments } from '../workers/sync-pure';
import type { Message, Attachment, PerfTracer, PgpKey } from '../types';
import { messages } from './messageStore';
import { writable } from 'svelte/store';
import { warn } from '../utils/logger.ts';
import {
  extractPgpArmor,
  isPgpEncrypted,
  sanitizeDownloadFilename,
  buildSaveDialogFilters,
  bytesFromDataUrl,
  contentToBytes,
  getPgpDismissKey,
  composeAbortSignals,
  sanitizeAttachments,
} from './mail-service-helpers';

export interface MessageDetailCallbacks {
  onLoading?: (loading: boolean) => void;
  onBody?: (html: string) => void;
  onAttachments?: (attachments: Attachment[]) => void;
  onError?: (error: Error) => void;
  onMeta?: (meta: unknown) => void;
  onImageStatus?: (status: ImageStatus) => void;
  onPgpStatus?: (status: PgpStatus) => void;
  perf?: PerfTracer;
  signal?: AbortSignal;
  allowPgpPrompt?: boolean;
}

export interface ImageStatus {
  hasBlockedImages: boolean;
  trackingPixelCount: number;
  blockedRemoteImageCount: number;
}

export interface PgpStatus {
  locked: boolean;
  /** Message was PGP-encrypted and successfully decrypted. */
  encrypted?: boolean;
  /** Signature packets present but NOT verified (no public-key store yet). */
  signed?: boolean;
  /** Protected-headers subject from the decrypted inner MIME. */
  subject?: string;
}

interface PgpContext {
  account: string;
  allowPgpPrompt: boolean;
  tracer: PerfTracer;
  message: Message;
  signal?: AbortSignal;
  onPgpStatus?: (status: PgpStatus) => void;
  onBody?: (html: string) => void;
  onImageStatus?: (status: ImageStatus) => void;
  onAttachments?: (attachments: Attachment[]) => void;
  onMeta?: (meta: unknown) => void;
}

interface DecryptResult {
  success: boolean;
  body?: string;
  textContent?: string;
  attachments?: Attachment[];
  rawBody?: string;
  reason?: string;
  message?: string;
  keyCount?: number;
  /** Protected-headers subject parsed from the decrypted inner MIME. */
  subject?: string;
  /** Signature packets present in the decrypted message (unverified). */
  signed?: boolean;
}

interface PassphraseModalRef {
  open?: (keyName: string) => Promise<{ passphrase?: string; remember?: boolean }>;
}

interface CachedBody {
  body?: string;
  raw?: string;
  meta?: unknown;
  attachments?: Attachment[];
  blockedRemoteImageCount?: number;
  trackingPixelCount?: number;
}

// Quiet debug helpers (toggle to console.* if needed)
const debugLog = (..._args: unknown[]): void => {};
const debugWarn = (..._args: unknown[]): void => {};

// Trigger file download. Inside Tauri (desktop and mobile) this goes through
// the native save dialog plus the fs plugin; the web build uses the standard
// anchor download. Mobile must not fall through to the anchor path: the
// Android WebView wry creates has no DownloadListener and WKWebView ignores
// the download attribute, so a.click() silently does nothing there.
function triggerDownload(href: string, filename: string): void {
  if (isTauri) {
    triggerDownloadTauri(href, filename).catch((err) => {
      console.warn('[mailService] Tauri save failed:', err);
      reportSaveDialogFailure(filename, err);
    });
    return;
  }
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// IPC payloads above this size have been observed to destabilize macOS
// WebKit (especially x64) when passed to writeFile in a single call.
// Chunked append keeps each round-trip small even when the destination is a
// user-chosen file path.
const TAURI_WRITE_CHUNK_SIZE = 256 * 1024;

// Attachments above this size skip the JS-side base64/data-URL cache and
// write straight to disk. Building a data URL of a 100 MB binary creates
// a ~133 MB string PLUS the original buffer, easily tripling the heap
// footprint — the documented OOM cause behind the macOS attachment-open
// abort() crashes (kernel triage: mach_vm_allocate_kernel failed).
const LARGE_ATTACHMENT_BYTES = 50 * 1024 * 1024;

// Write a Uint8Array straight to a user-chosen save location on Tauri,
// or trigger a Blob-based download on the web. Bypasses bufferToDataUrl
// so we never materialize a base64 representation of the attachment.
function triggerDownloadBytes(bytes: Uint8Array, filename: string, _contentType: string): void {
  if (isTauri) {
    triggerDownloadBytesTauri(bytes, filename).catch((err) => {
      console.warn('[mailService] Tauri save failed:', err);
      reportSaveDialogFailure(filename, err);
    });
    return;
  }
  try {
    const blob = new Blob([bytes as ArrayBufferView], {
      type: _contentType || 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    console.error('triggerDownloadBytes failed', err);
  }
}

async function triggerDownloadBytesTauri(bytes: Uint8Array, filename: string): Promise<void> {
  const { remove, writeFile } = await import('@tauri-apps/plugin-fs');
  const { saveFileDialog } = await import('../utils/download');

  const safeFilename = sanitizeDownloadFilename(filename);
  const outputPath = await saveFileDialog({
    defaultPath: safeFilename,
    filters: buildSaveDialogFilters(safeFilename),
  });
  if (!outputPath) return;

  let startedWriting = false;
  try {
    if (bytes.byteLength <= TAURI_WRITE_CHUNK_SIZE) {
      startedWriting = true;
      await writeFile(outputPath, bytes);
      return;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += TAURI_WRITE_CHUNK_SIZE) {
      const chunk = bytes.subarray(
        offset,
        Math.min(offset + TAURI_WRITE_CHUNK_SIZE, bytes.byteLength),
      );
      startedWriting = true;
      await writeFile(outputPath, chunk, { append: offset > 0 });
    }
  } catch (err) {
    if (startedWriting) {
      try {
        await remove(outputPath);
      } catch (cleanupErr) {
        console.warn('[mailService] Failed to remove partial attachment:', cleanupErr);
      }
    }

    dispatchMailServiceToast(
      `Could not save "${safeFilename}" to the selected location. Please choose another folder, retry the download, or allow access if your operating system blocked the write.`,
      'error',
    );
    throw markReported(err);
  }
}

async function readDownloadBytes(href: string): Promise<Uint8Array> {
  const dataBytes = bytesFromDataUrl(href);
  if (dataBytes) return dataBytes;

  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(`Attachment download failed with HTTP ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

type WriteFileFn = (
  path: string,
  data: Uint8Array,
  options?: { append?: boolean },
) => Promise<void>;

// Stream a fetch response directly to disk in fixed-size chunks. Avoids
// materializing the entire attachment in JS memory before writing — the
// previous "buffer the whole file then chunk the IPC" approach was crashing
// macOS x64 WebKit on large attachments.
async function streamFetchToFile(
  href: string,
  outputPath: string,
  writeFile: WriteFileFn,
): Promise<boolean> {
  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(`Attachment download failed with HTTP ${response.status}`);
  }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    return false;
  }

  const reader = body.getReader();
  let pending: Uint8Array | null = null;
  let totalWritten = 0;

  const flush = async (chunk: Uint8Array, isFirst: boolean) => {
    await writeFile(outputPath, chunk, { append: !isFirst });
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      let buffer: Uint8Array = pending
        ? (() => {
            const merged = new Uint8Array(pending.byteLength + value.byteLength);
            merged.set(pending, 0);
            merged.set(value, pending.byteLength);
            return merged;
          })()
        : value;
      pending = null;

      while (buffer.byteLength >= TAURI_WRITE_CHUNK_SIZE) {
        const slice = buffer.subarray(0, TAURI_WRITE_CHUNK_SIZE);
        await flush(slice, totalWritten === 0);
        totalWritten += slice.byteLength;
        buffer = buffer.subarray(TAURI_WRITE_CHUNK_SIZE);
      }

      pending = buffer.byteLength > 0 ? buffer : null;
    }

    if (pending && pending.byteLength > 0) {
      await flush(pending, totalWritten === 0);
      totalWritten += pending.byteLength;
    } else if (totalWritten === 0) {
      // Empty response — write a zero-byte file so callers see consistent state.
      await flush(new Uint8Array(0), true);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return true;
}

function dispatchMailServiceToast(message: string, type = 'error'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('fe:mail-service-toast', { detail: { message, type } }));
}

// The write paths already toast their own message before rethrowing. This
// covers everything before the write starts (dialog plugin missing, the
// invoke rejected by a capability, the dialog itself throwing) so a failed
// download is never silent.
function markReported(err: unknown): unknown {
  if (err && typeof err === 'object') {
    (err as { reported?: boolean }).reported = true;
    return err;
  }
  return Object.assign(new Error(String(err)), { reported: true });
}

function reportSaveDialogFailure(filename: string, err: unknown): void {
  if (err && typeof err === 'object' && (err as { reported?: boolean }).reported) return;
  dispatchMailServiceToast(
    `Could not open a save location for "${filename}". Please try again.`,
    'error',
  );
}

async function triggerDownloadTauri(href: string, filename: string): Promise<void> {
  const { remove, writeFile } = await import('@tauri-apps/plugin-fs');
  const { saveFileDialog } = await import('../utils/download');

  const safeFilename = sanitizeDownloadFilename(filename);
  const outputPath = await saveFileDialog({
    defaultPath: safeFilename,
    filters: buildSaveDialogFilters(safeFilename),
  });

  if (!outputPath) {
    return;
  }

  let startedWriting = false;

  try {
    const writeChunked: WriteFileFn = async (path, chunk, opts) => {
      startedWriting = true;
      await writeFile(path, chunk, opts);
    };

    // Prefer streaming straight from fetch → disk. Avoids holding the whole
    // attachment in memory, which has been crashing macOS x64 WebKit.
    const isHttpHref = typeof href === 'string' && /^https?:/i.test(href);
    if (isHttpHref) {
      const streamed = await streamFetchToFile(href, outputPath, writeChunked);
      if (streamed) return;
    }

    // Fallback: data URLs (and environments without ReadableStream) — decode
    // once, then write in fixed-size chunks via the IPC bridge.
    const bytes = await readDownloadBytes(href);

    if (bytes.byteLength <= TAURI_WRITE_CHUNK_SIZE) {
      await writeChunked(outputPath, bytes);
      return;
    }

    for (let offset = 0; offset < bytes.byteLength; offset += TAURI_WRITE_CHUNK_SIZE) {
      const chunk = bytes.subarray(
        offset,
        Math.min(offset + TAURI_WRITE_CHUNK_SIZE, bytes.byteLength),
      );
      await writeChunked(outputPath, chunk, { append: offset > 0 });
    }
  } catch (err) {
    if (startedWriting) {
      try {
        await remove(outputPath);
      } catch (cleanupErr) {
        console.warn('[mailService] Failed to remove partial attachment:', cleanupErr);
      }
    }

    dispatchMailServiceToast(
      `Could not save "${safeFilename}" to the selected location. Please choose another folder, retry the download, or allow access if your operating system blocked the write.`,
      'error',
    );
    throw markReported(err);
  }
}

let passphraseModalRef: PassphraseModalRef | null = null;
const pendingPassphraseModalWaiters = new Set<(modal: PassphraseModalRef | null) => void>();
const passphraseCache = new Map<string, string>();
const missingKeyModalShownByAccount = new Set<string>();

// Track in-flight message detail requests to prevent duplicate concurrent fetches
const inFlightRequests = new Map<string, Promise<unknown>>();

// There is deliberately no "same message, skip the body" debounce here. Every
// reader (the main reader, desktop tabs, the threaded view) clears its body
// before loading, so a skipped delivery left a blank body under the header.
// EmailIframe keeps one frame mounted and swaps its document in place, so
// delivering a body again only costs a re-parse.

// Account-level AbortController — aborted on account switch to cancel stale fetches
let accountAbortController: AbortController | null = null;

function getAccountSignal(): AbortSignal {
  if (!accountAbortController) {
    accountAbortController = new AbortController();
  }
  return accountAbortController.signal;
}

// Timeout constants for preventing UI freezes
const PASSPHRASE_MODAL_TIMEOUT = 120000; // 2 minutes for user to enter passphrase

/**
 * Wrap a promise with a timeout to prevent indefinite hangs
 */
function withTimeout<T>(promise: Promise<T>, ms: number, operation = 'Operation'): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

// Check if user has dismissed PGP modal in this session
function hasDismissedPgpModal(account: string): boolean {
  try {
    const dismissed = sessionStorage.getItem(getPgpDismissKey(account));
    return dismissed === 'true';
  } catch {
    return false;
  }
}

function setDismissedPgpModal(value: boolean, account: string): void {
  try {
    const key = getPgpDismissKey(account);
    if (value) {
      sessionStorage.setItem(key, 'true');
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore sessionStorage errors
  }
}

function waitForPassphraseModal(timeoutMs = 1500): Promise<PassphraseModalRef | null> {
  if (passphraseModalRef?.open) {
    return Promise.resolve(passphraseModalRef);
  }

  return new Promise((resolve) => {
    const resolveModal = (modal: PassphraseModalRef | null): void => {
      clearTimeout(timeoutId);
      pendingPassphraseModalWaiters.delete(resolveModal);
      resolve(modal?.open ? modal : null);
    };

    const timeoutId = setTimeout(() => {
      pendingPassphraseModalWaiters.delete(resolveModal);
      resolve(null);
    }, timeoutMs);

    pendingPassphraseModalWaiters.add(resolveModal);
  });
}

async function getPassphraseModalIfAvailable(
  allowPrompt: boolean,
): Promise<PassphraseModalRef | null> {
  if (!allowPrompt) return null;
  if (passphraseModalRef?.open) return passphraseModalRef;

  const modal = await waitForPassphraseModal();
  if (!modal?.open) {
    warn('[PGP] Passphrase modal ref not available — cannot prompt for passphrase');
    return null;
  }

  passphraseModalRef = modal;
  return modal;
}

export const setPassphraseModal = (modal: PassphraseModalRef): void => {
  passphraseModalRef = modal;
  for (const resolveModal of [...pendingPassphraseModalWaiters]) {
    resolveModal(passphraseModalRef);
  }
};

/**
 * Monotonic counter incremented when PGP keys change.
 * Mailbox watches this to re-load the selected message after returning from Settings.
 */
let _pgpKeysVersion = 0;
export const pgpKeysVersion = writable(_pgpKeysVersion);
export const getPgpKeysVersion = (): number => _pgpKeysVersion;

function bumpPgpKeysVersion(): void {
  _pgpKeysVersion++;
  pgpKeysVersion.set(_pgpKeysVersion);
}

/**
 * Clear PGP key caches when keys are updated in settings
 * This ensures fresh checks for passphrase requirements
 */
export const clearPgpKeyCache = (): void => {
  passphraseCache.clear();
  keyNeedsPassphraseCache.clear();
  missingKeyModalShownByAccount.clear();
  bumpPgpKeysVersion();
};

/**
 * Invalidate cached message bodies that contain PGP-encrypted content.
 * Called after PGP keys are added/removed so the next load re-attempts decryption.
 */
// How many cached bodies invalidatePgpCachedBodies reads at a time. Bodies can
// be large (a locked PGP body keeps its whole ciphertext), and every tab and
// worker shares one database worker, so a read of a whole account's bodies
// held up everything else, opening a message included, for many seconds.
const PGP_INVALIDATE_BATCH = 50;

export const invalidatePgpCachedBodies = async (account: string): Promise<void> => {
  try {
    const keys = ((await db.messageBodies
      .where('[account+id]')
      .between([account, Dexie.minKey], [account, Dexie.maxKey])
      .primaryKeys()) || []) as unknown[];
    for (let i = 0; i < keys.length; i += PGP_INVALIDATE_BATCH) {
      const batch = keys.slice(i, i + PGP_INVALIDATE_BATCH);
      const bodies = ((await db.messageBodies.bulkGet(batch)) || []) as Array<
        | { account?: string; id?: string; raw?: unknown; body?: unknown; pgpLocked?: boolean }
        | undefined
      >;
      const staleKeys = bodies
        .filter(
          (b) =>
            b &&
            (b.pgpLocked ||
              (typeof b.raw === 'string' && isPgpEncrypted(b.raw)) ||
              (typeof b.body === 'string' && isPgpEncrypted(b.body))),
        )
        .map((b) => [b!.account, b!.id]);
      if (staleKeys.length) await db.messageBodies.bulkDelete(staleKeys);
    }
  } catch {
    // Non-critical — worst case user refreshes
  }
};

/**
 * Clear in-flight request tracking and cache hit debounce state.
 * Call on account switch to prevent stale requests from interfering.
 */
export const clearMailServiceState = (): void => {
  if (accountAbortController) {
    accountAbortController.abort();
    accountAbortController = null;
  }
  inFlightRequests.clear();
};

/**
 * Persist what a successful decrypt revealed onto the message record: the
 * pgpEncrypted/pgpSigned badge flags and, for senders that encrypt the
 * subject via protected headers (the outer Subject is a placeholder like
 * "..."), the REAL subject from the decrypted inner MIME. Updates both the
 * cached db.messages record and the in-memory list so the row and any open
 * reader reflect it immediately.
 */
async function persistDecryptedEnvelope(
  message: Message,
  account: string,
  decrypted: { subject?: string; signed?: boolean },
): Promise<void> {
  const messageId = getMessageApiId(message);
  if (!messageId) return;

  const innerSubject =
    typeof decrypted.subject === 'string' &&
    decrypted.subject.trim() &&
    decrypted.subject !== message.subject
      ? decrypted.subject
      : undefined;
  const signed = Boolean(decrypted.signed);

  // Nothing new to record. Avoids a write on every open of an already-flagged message.
  if (innerSubject === undefined && message.pgpEncrypted && message.pgpSigned === signed) {
    return;
  }

  const changes: Partial<Message> = { pgpEncrypted: true, pgpSigned: signed };
  if (innerSubject !== undefined) changes.subject = innerSubject;

  try {
    await db.messages
      .where('[account+id]')
      .equals([account, messageId])
      .modify(changes as Record<string, unknown>);
  } catch (err) {
    debugWarn('[PGP] Failed to persist decrypted envelope info', err);
  }

  try {
    messages.update((list) =>
      (list || []).map((m) => (getMessageApiId(m) === messageId ? { ...m, ...changes } : m)),
    );
  } catch {
    // Store update is best-effort; the persisted record wins on next load.
  }
}

// How long the reader waits on its own cache read before going to the worker
const READER_CACHE_READ_CAP_MS = 1500;

/**
 * Handles cached PGP encrypted messages by attempting decryption and parsing
 */
async function handleCachedPgpRaw(
  raw: string | undefined,
  meta: unknown,
  stage: string,
  context: PgpContext,
): Promise<boolean> {
  const {
    account,
    allowPgpPrompt,
    tracer,
    message,
    signal,
    onPgpStatus,
    onBody,
    onImageStatus,
    onAttachments,
    onMeta,
  } = context;

  if (!raw || typeof raw !== 'string') return false;
  if (!isPgpEncrypted(raw)) return false;

  const shouldMeasure = Local.get('debug_perf') === '1';
  const now = (): number =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  // Re-check cache before attempting decryption - background task may have
  // already decrypted. Not from the cache path itself, which read this row a
  // moment ago: a second read only cloned a multi-megabyte ciphertext across
  // from the db worker again.
  const messageId = getMessageApiId(message);
  if (messageId && stage !== 'cache') {
    try {
      const freshCache = (await db.messageBodies
        .where('[account+id]')
        .equals([account, messageId])
        .first()) as CachedBody | undefined;
      if (freshCache?.body && !isPgpEncrypted(freshCache.body)) {
        // Already decrypted by background task
        // The raw was PGP and the cache holds a decrypted body, so this IS an
        // encrypted message; signed/subject were persisted at decrypt time.
        onPgpStatus?.({ locked: false, encrypted: true });

        debugLog('[PGP] Message already decrypted by background task');
        const hydrated = applyInlineAttachments(freshCache.body, freshCache.attachments || []);
        onBody?.(`<div class="fe-message-canvas">${hydrated}</div>`);
        onImageStatus?.({
          hasBlockedImages:
            (freshCache.blockedRemoteImageCount || 0) > 0 ||
            (freshCache.trackingPixelCount || 0) > 0,
          trackingPixelCount: freshCache.trackingPixelCount || 0,
          blockedRemoteImageCount: freshCache.blockedRemoteImageCount || 0,
        });
        onAttachments?.(sanitizeAttachments(freshCache.attachments || []));
        onMeta?.(freshCache.meta || meta);
        tracer.end({ status: `${stage}_pgp_already_decrypted` });
        return true;
      }
    } catch {
      // Ignore cache lookup errors, proceed with decryption
    }
  }

  tracer.stage(`${stage}_pgp_raw`);
  const pgpArmor = extractPgpArmor(raw);
  const result = await tryDecrypt(pgpArmor, { allowPrompt: allowPgpPrompt });
  if (result.success) {
    debugLog('[PGP] Successfully decrypted cached message');
    onPgpStatus?.({
      locked: false,
      encrypted: true,
      signed: result.signed,
      subject: result.subject,
    });
    persistDecryptedEnvelope(message, account, result).catch(() => {});
    abortIfNeeded(signal);
    const parsed = result;
    const parsedAttachments = sanitizeAttachments(parsed.attachments || []);
    abortIfNeeded(signal);
    const sanitizeStart = shouldMeasure ? now() : 0;
    const sanitized = sanitizeHtml(parsed.body || '');
    if (shouldMeasure) {
      tracer.stage('sanitize_end', {
        duration: now() - sanitizeStart,
        source: 'pgp_cache',
        bytes: parsed.body?.length || 0,
      });
    }
    onBody?.(`<div class="fe-message-canvas">${sanitized.html}</div>`);
    onImageStatus?.({
      hasBlockedImages: sanitized.hasBlockedImages,
      trackingPixelCount: sanitized.trackingPixelCount,
      blockedRemoteImageCount: sanitized.blockedRemoteImageCount,
    });
    onAttachments?.(parsedAttachments);
    onMeta?.(meta);
    await cacheMessageContent(
      message,
      parsed.body || '',
      parsedAttachments,
      parsed.rawBody || '',
      parsed.textContent || '',
      meta,
      account,
      sanitized,
    );

    tracer.stage('cache_write', { cached: true });
    tracer.end({ status: `${stage}_pgp_decrypted` });
    return true;
  }
  debugLog('[PGP] Cached message still locked');
  const hasKeys = (await getStoredKeys()).length > 0;
  onPgpStatus?.({ locked: true, hasKeys });
  if (allowPgpPrompt) {
    const errorMsg =
      result.message || 'PGP encrypted message. Unable to decrypt with current keys.';
    onBody?.(`<pre style="white-space:pre-wrap">${errorMsg}</pre>`);
  }
  tracer.end({
    status: allowPgpPrompt ? `${stage}_pgp_locked` : `${stage}_pgp_locked_suppressed`,
  });
  return true;
}

/**
 * Calculate priority score for prefetch ordering.
 * Higher score = prefetch first.
 */
export const mailService = {
  setPassphraseModal(modal: PassphraseModalRef): void {
    passphraseModalRef = modal;
  },

  formatDate(value: unknown): string {
    return formatFriendlyDate(value);
  },

  async loadMessageDetail(
    message: Message | null,
    callbacks: MessageDetailCallbacks = {},
  ): Promise<void> {
    const {
      onLoading,
      onBody: rawOnBody,
      onAttachments,
      onError,
      onMeta,
      onImageStatus,
      onPgpStatus,
      perf,
      signal,
      allowPgpPrompt = true,
    } = callbacks;

    if (!message) {
      return;
    }

    const account = Local.get('email') || 'default';
    const folder = message.folder_path || message.folder;
    const messageId = getMessageApiId(message);
    if (!messageId) {
      onError?.(new Error('Invalid message ID'));
      return;
    }

    // A delivered body also ends the loading state, on every path (cache hit,
    // re-sanitize, network fetch, PGP decrypt). Without this the skeleton
    // stayed up until the cache write after delivery finished, which could
    // take seconds while the db worker was busy, with the decrypted body ready
    // underneath it.
    const onBody = rawOnBody
      ? (html: string): void => {
          rawOnBody(html);
          onLoading?.(false);
        }
      : undefined;
    const tracer =
      perf ||
      createPerfTracer('message.load', {
        id: messageId,
        folder,
        account,
        hasAttachments: message.has_attachment,
      });
    const shouldMeasure = Local.get('debug_perf') === '1';
    const now = (): number =>
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    let hasRenderedBody = false;

    // Compose per-message signal with account-level signal so account switch aborts all in-flight loads
    const accountSignal = getAccountSignal();
    const compositeSignal = signal ? composeAbortSignals(signal, accountSignal) : accountSignal;

    try {
      if (compositeSignal.aborted) {
        tracer.end({ status: 'aborted' });
        return;
      }
      tracer.stage('cache_lookup_start');

      const pgpContext: PgpContext = {
        account,
        allowPgpPrompt,
        tracer,
        message,
        signal: compositeSignal,
        onPgpStatus,
        onBody,
        onImageStatus,
        onAttachments,
        onMeta,
      };

      // Capped like the sync worker's own lookup: when the db worker is busy
      // (a backfill, another tab) an uncapped read left the reader on a
      // spinner with no end. Past the cap it is treated as a miss and the
      // worker or the network serves the body.
      const cached = (await Promise.race([
        db.messageBodies.where('[account+id]').equals([account, messageId]).first(),
        new Promise((resolve) => setTimeout(() => resolve(undefined), READER_CACHE_READ_CAP_MS)),
      ]).catch(() => undefined)) as CachedBody | undefined;
      // Check if cached message needs re-sanitization (missing tracking pixel data from worker cache)
      const needsResanitize = cached?.body && cached.trackingPixelCount === undefined;
      // Detect stale cache: raw PGP/MIME content was incorrectly stored as body
      const isStalePgpBody =
        cached?.body && typeof cached.body === 'string' && isPgpEncrypted(cached.body);

      if (cached?.body && !isStalePgpBody) {
        // Re-sanitize worker-cached bodies that are missing tracking pixel data
        if (needsResanitize) {
          tracer.stage('cache_resanitize');
          const sanitized = sanitizeHtml(cached.body);
          // Update cache with sanitized fields so next load is a full cache hit
          cacheMessageContent(
            message,
            cached.body,
            cached.attachments || [],
            cached.raw || cached.body,
            '',
            cached.meta || null,
            account,
            sanitized,
          ).catch(() => {});
          const hydrated = applyInlineAttachments(sanitized.html, cached.attachments || []);
          onBody?.(`<div class="fe-message-canvas">${hydrated}</div>`);
          hasRenderedBody = true;
          onPgpStatus?.({ locked: false });
          onImageStatus?.({
            hasBlockedImages: sanitized.hasBlockedImages,
            trackingPixelCount: sanitized.trackingPixelCount,
            blockedRemoteImageCount: sanitized.blockedRemoteImageCount,
          });
          onAttachments?.(sanitizeAttachments(cached.attachments || []));
          onMeta?.(cached.meta);
          onLoading?.(false);
          tracer.end({ status: 'cache_resanitized' });
          return;
        }

        onPgpStatus?.({ locked: false });
        onMeta?.(cached.meta);
        tracer.stage('cache_hit', { fresh: true, cacheAge: 0 });

        const hydrated = applyInlineAttachments(cached.body, cached.attachments || []);
        onBody?.(`<div class="fe-message-canvas">${hydrated}</div>`);
        hasRenderedBody = true;
        onImageStatus?.({
          hasBlockedImages:
            (cached.blockedRemoteImageCount || 0) > 0 || (cached.trackingPixelCount || 0) > 0,
          trackingPixelCount: cached.trackingPixelCount || 0,
          blockedRemoteImageCount: cached.blockedRemoteImageCount || 0,
        });
        onAttachments?.(sanitizeAttachments(cached.attachments || []));
        onLoading?.(false);
        const needsMetaRefresh =
          !cached.meta || !(cached.meta as { nodemailer?: unknown }).nodemailer;
        if (!needsMetaRefresh) {
          tracer.stage('cache_fresh');
          tracer.end({ status: 'cache_hit' });
          return;
        }
        // Fetch metadata in background without re-rendering body
        tracer.stage('cache_meta_missing');
        mailService.loadMessageDetailNetwork?.({
          message,
          folder: folder || '',
          onMeta,
          metaOnly: true,
          signal: compositeSignal,
        });
        tracer.end({ status: 'cache_hit_meta_refresh' });
        return;
      }
      if (!cached?.body || isStalePgpBody) {
        // Use cached.body as raw PGP source if it was incorrectly stored as body
        const pgpRaw = isStalePgpBody ? (cached?.body as string) : cached?.raw;
        const handled = await handleCachedPgpRaw(pgpRaw, cached?.meta, 'cache', pgpContext);
        if (handled) return;
      }

      const requestKey = `${account}:${messageId}`;
      const existingRequest = inFlightRequests.get(requestKey);
      if (existingRequest) {
        tracer.stage('waiting_for_inflight');
        try {
          await existingRequest;
          const freshCached = (await db.messageBodies
            .where('[account+id]')
            .equals([account, messageId])
            .first()) as CachedBody | undefined;
          if (freshCached?.body && !isPgpEncrypted(freshCached.body)) {
            const hydrated = applyInlineAttachments(
              freshCached.body,
              freshCached.attachments || [],
            );

            onBody?.(`<div class="fe-message-canvas">${hydrated}</div>`);
            onImageStatus?.({
              hasBlockedImages:
                (freshCached.blockedRemoteImageCount || 0) > 0 ||
                (freshCached.trackingPixelCount || 0) > 0,
              trackingPixelCount: freshCached.trackingPixelCount || 0,
              blockedRemoteImageCount: freshCached.blockedRemoteImageCount || 0,
            });
            onAttachments?.(sanitizeAttachments(freshCached.attachments || []));
            onMeta?.(freshCached.meta);
            onLoading?.(false);
            tracer.end({ status: 'cache_after_inflight' });
            return;
          }
        } catch {
          // In-flight request failed, proceed with our own fetch
        }
      }

      if (!hasRenderedBody) {
        onLoading?.(true);
      }
      tracer.stage('worker_start');

      const messagePayload = {
        id: messageId,
        folder,
        subject: message.subject,
        from: message.from,
        to: message.to,
        cc: message.cc,
        snippet: message.snippet,
        date: message.date || message.dateMs,
        labels: message.labels || [],
      };

      const fetchPromise = (async () => {
        let workerResult: {
          body?: string;
          attachments?: Attachment[];
          meta?: Record<string, unknown>;
          pgpLocked?: boolean;
          raw?: string;
        } | null = null;
        try {
          workerResult = await sendSyncRequest('messageDetail', {
            account,
            folder,
            message: messagePayload,
          });
        } catch {
          workerResult = null;
        }
        tracer.stage('worker_end', {
          ok: Boolean(workerResult?.body),
          pgpLocked: Boolean(workerResult?.pgpLocked),
        });

        if (workerResult?.body && !workerResult?.pgpLocked) {
          return { source: 'worker', workerResult };
        }

        // If worker returned raw PGP data, skip network fetch — main thread can attempt decryption
        if (workerResult?.pgpLocked && workerResult?.raw) {
          return {
            source: 'main',
            detailRes: workerResult.meta || { raw: workerResult.raw },
            workerResult,
          };
        }

        abortIfNeeded(compositeSignal);
        tracer.stage('network_start', {
          reason: workerResult?.pgpLocked ? 'pgp_locked' : 'worker_miss',
        });
        const detailRes = await Remote.request(
          'Message',
          {},
          {
            method: 'GET',
            pathOverride: `/v1/messages/${encodeURIComponent(messageId)}?folder=${encodeURIComponent(folder || '')}&raw=true`,
            signal: compositeSignal,
          },
        );
        tracer.stage('network_end');
        return { source: 'main', detailRes, workerResult };
      })();
      inFlightRequests.set(requestKey, fetchPromise);

      let detailRes: unknown;
      let workerResult: {
        body?: string;
        attachments?: Attachment[];
        meta?: Record<string, unknown>;
        pgpLocked?: boolean;
        raw?: string;
        pgp?: { encrypted?: boolean; subject?: string };
      } | null = null;
      let source = 'main';
      try {
        const result = await fetchPromise;
        source = result.source;
        workerResult = result.workerResult || null;
        detailRes = result.detailRes;
        if (source === 'cache') {
          return;
        }
      } finally {
        inFlightRequests.delete(requestKey);
      }
      if (source === 'worker' && workerResult?.body) {
        onPgpStatus?.(
          workerResult.pgp?.encrypted
            ? { locked: false, encrypted: true, subject: workerResult.pgp.subject }
            : { locked: false },
        );
        const workerMeta = workerResult.meta || null;
        onMeta?.(workerMeta);
        const workerAttachments = sanitizeAttachments(workerResult.attachments || []);
        const hydrated = applyInlineAttachments(workerResult.body, workerAttachments);
        abortIfNeeded(compositeSignal);
        const sanitizeStart = shouldMeasure ? now() : 0;
        const sanitized = sanitizeHtml(hydrated);
        if (shouldMeasure) {
          tracer.stage('sanitize_end', {
            duration: now() - sanitizeStart,
            source: 'worker',
            bytes: hydrated?.length || 0,
          });
        }
        onBody?.(`<div class="fe-message-canvas">${sanitized.html}</div>`);
        onImageStatus?.({
          hasBlockedImages: sanitized.hasBlockedImages,
          trackingPixelCount: sanitized.trackingPixelCount,
          blockedRemoteImageCount: sanitized.blockedRemoteImageCount,
        });
        onAttachments?.(workerAttachments);
        // Update IDB cache with sanitized fields so next load is a full cache hit
        cacheMessageContent(
          message,
          workerResult.body,
          workerAttachments,
          workerResult.body,
          '',
          workerMeta,
          account,
        ).catch(() => {});
        if (!workerMeta?.nodemailer) {
          mailService.loadMessageDetailNetwork?.({
            message,
            folder: folder || '',
            onMeta,
            metaOnly: true,
            signal: compositeSignal,
          });
        }
        tracer.end({ status: 'worker_rendered' });
        return;
      }
      if (workerResult?.pgpLocked) {
        tracer.stage('worker_pgp_locked');
      }
      const result = ((detailRes as { Result?: unknown })?.Result || detailRes) as Record<
        string,
        unknown
      >;
      onMeta?.(result);

      let extractedPgpMessage = '';
      const rawIsString = result?.raw && typeof result.raw === 'string';
      const rawIsPgp = rawIsString && isPgpEncrypted(result.raw as string);
      if (rawIsPgp) {
        const extracted = extractPgpArmor(result.raw as string);
        if (extracted.includes('-----BEGIN PGP MESSAGE-----')) {
          extractedPgpMessage = extracted;
          debugLog(
            '[mailService] Extracted PGP message from raw field, length:',
            extractedPgpMessage.length,
          );
        }
      }

      const serverText =
        result?.Plain ||
        result?.text ||
        result?.body ||
        result?.preview ||
        (result?.nodemailer as Record<string, unknown>)?.text ||
        (result?.nodemailer as Record<string, unknown>)?.preview;
      const rawBody =
        result?.html ||
        result?.Html ||
        result?.textAsHtml ||
        (result?.nodemailer as Record<string, unknown>)?.html ||
        (result?.nodemailer as Record<string, unknown>)?.textAsHtml ||
        serverText ||
        extractedPgpMessage ||
        message.snippet ||
        '';

      const isPgp =
        rawIsPgp ||
        !!extractedPgpMessage ||
        (typeof rawBody === 'string' && isPgpEncrypted(rawBody as string)) ||
        (typeof serverText === 'string' && isPgpEncrypted(serverText as string));

      const detailAttachments = ((result?.nodemailer as Record<string, unknown>)?.attachments ||
        result?.attachments ||
        []) as unknown[];
      tracer.stage('parse_start', { isPgp, attachmentCount: detailAttachments?.length || 0 });

      const mappedAttachments = (detailAttachments || []).map((att: unknown) => {
        const a = att as Record<string, unknown>;
        const contentId = a.cid || a.contentId;
        const disposition = (a.disposition || a.contentDisposition || '').toString().toLowerCase();
        const isInline = disposition === 'inline' || !!contentId;
        const hasUrl = !!a.url;

        let href: string | undefined;
        if (hasUrl) {
          href = a.url as string;
        } else if (isInline && a.content) {
          href = bufferToDataUrl(a);
        }

        return {
          name: (a.name || a.filename) as string,
          filename: a.filename as string,
          size: (a.size ||
            (a.content as ArrayBuffer)?.byteLength ||
            (a.content as Uint8Array)?.length ||
            0) as number,
          contentId: contentId as string,
          disposition,
          href,
          contentType: (a.contentType || a.mimeType || a.type) as string,
          needsDownload: !href && !hasUrl,
        };
      });
      const attachments = sanitizeAttachments(mappedAttachments);

      if (isPgp) {
        debugLog('[PGP] Detected PGP encrypted message');
        // Prefer extracted inline armor; for PGP/MIME pass full raw so the worker
        // can do boundary parsing; last resort: rawBody/serverText
        const pgpInput =
          extractedPgpMessage ||
          (rawIsPgp ? (result.raw as string) : '') ||
          extractPgpArmor((rawBody || serverText || '') as string);
        const decryptResult = await tryDecrypt(pgpInput, {
          allowPrompt: allowPgpPrompt,
        });
        if (decryptResult.success) {
          debugLog('[PGP] Successfully decrypted');
          onPgpStatus?.({
            locked: false,
            encrypted: true,
            signed: decryptResult.signed,
            subject: decryptResult.subject,
          });
          persistDecryptedEnvelope(message, account, decryptResult).catch(() => {});
          abortIfNeeded(compositeSignal);
          const parsed = decryptResult;
          const parsedAttachments = sanitizeAttachments(parsed.attachments || []);
          abortIfNeeded(compositeSignal);
          const sanitizeStart = shouldMeasure ? now() : 0;
          const sanitized = sanitizeHtml(parsed.body || '');
          if (shouldMeasure) {
            tracer.stage('sanitize_end', {
              duration: now() - sanitizeStart,
              source: 'pgp',
              bytes: parsed.body?.length || 0,
            });
          }
          onBody?.(`<div class="fe-message-canvas">${sanitized.html}</div>`);
          onImageStatus?.({
            hasBlockedImages: sanitized.hasBlockedImages,
            trackingPixelCount: sanitized.trackingPixelCount,
            blockedRemoteImageCount: sanitized.blockedRemoteImageCount,
          });
          onAttachments?.(parsedAttachments);
          // Not awaited: the body is on screen, and the reader should not wait
          // on a cache write to finish loading.
          void cacheMessageContent(
            message,
            parsed.body || '',
            parsedAttachments,
            parsed.rawBody || '',
            parsed.textContent || '',
            result,
            account,
            sanitized,
          ).catch((err) => console.warn('[mailService] Body cache write failed', err));
          tracer.stage('cache_write', { cached: true });
        } else {
          debugLog('[PGP] Unable to decrypt with current keys');
          onPgpStatus?.({ locked: true });
          // Don't cache encrypted raw — next access will re-fetch from API
          const errorMsg =
            decryptResult.message || 'PGP encrypted message. Unable to decrypt with current keys.';
          onBody?.(`<pre style="white-space:pre-wrap">${errorMsg}</pre>`);
        }
      } else {
        onPgpStatus?.({ locked: false });
        debugLog('[MIME] Parsing via worker');
        abortIfNeeded(compositeSignal);
        const parseStart = shouldMeasure ? now() : 0;
        const rawMime =
          result?.raw && typeof result.raw === 'string' && !isPgp
            ? (result.raw as string)
            : (rawBody as string);
        const parseResult = await requestParsing({
          raw: rawMime,
          existingAttachments: attachments,
        });
        const parsed = parseResult.success ? parseResult : null;
        if (shouldMeasure) {
          tracer.stage('parse_end', {
            duration: now() - parseStart,
            source: 'mime',
            bytes: (rawBody as string)?.length || 0,
          });
        }
        if (parsed) {
          const parsedAttachments = sanitizeAttachments(parsed.attachments || []);
          abortIfNeeded(compositeSignal);
          const sanitizeStart = shouldMeasure ? now() : 0;
          const sanitized = sanitizeHtml(parsed.body || '');
          if (shouldMeasure) {
            tracer.stage('sanitize_end', {
              duration: now() - sanitizeStart,
              source: 'mime',
              bytes: parsed.body?.length || 0,
            });
          }
          onBody?.(`<div class="fe-message-canvas">${sanitized.html}</div>`);
          onImageStatus?.({
            hasBlockedImages: sanitized.hasBlockedImages,
            trackingPixelCount: sanitized.trackingPixelCount,
            blockedRemoteImageCount: sanitized.blockedRemoteImageCount,
          });
          onAttachments?.(parsedAttachments);
          void cacheMessageContent(
            message,
            parsed.body || '',
            parsedAttachments,
            parsed.rawBody || '',
            parsed.textContent || '',
            result,
            account,
            sanitized,
            { leanAttachments: true },
          ).catch((err) => console.warn('[mailService] Body cache write failed', err));
          tracer.stage('cache_write', { cached: true });
        } else {
          const inlinedBody = applyInlineAttachments(rawBody as string, attachments);
          abortIfNeeded(compositeSignal);
          const sanitizeStart = shouldMeasure ? now() : 0;
          const sanitized = sanitizeHtml(inlinedBody);
          if (shouldMeasure) {
            tracer.stage('sanitize_end', {
              duration: now() - sanitizeStart,
              source: 'mime_fallback',
              bytes: inlinedBody?.length || 0,
            });
          }
          onBody?.(`<div class="fe-message-canvas">${sanitized.html}</div>`);
          onImageStatus?.({
            hasBlockedImages: sanitized.hasBlockedImages,
            trackingPixelCount: sanitized.trackingPixelCount,
            blockedRemoteImageCount: sanitized.blockedRemoteImageCount,
          });
          onAttachments?.(attachments);
          void cacheMessageContent(
            message,
            inlinedBody,
            attachments,
            rawBody as string,
            (serverText as string) || extractTextContent(inlinedBody || (rawBody as string)),
            result,
            account,
            sanitized,
            { leanAttachments: true },
          ).catch((err) => console.warn('[mailService] Body cache write failed', err));
          tracer.stage('cache_write', { cached: true });
        }
      }

      tracer.end({ status: 'network_rendered' });
      debugLog('[mailService] Message detail loading complete');
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') {
        tracer.end({ status: 'aborted' });
        return;
      }
      onError?.(err as Error);
      try {
        const cached = (await db.messageBodies
          .where('[account+id]')
          .equals([account, messageId])
          .first()) as CachedBody | undefined;
        if (cached?.body && !isPgpEncrypted(cached.body)) {
          const hydrated = applyInlineAttachments(cached.body, cached.attachments || []);

          onBody?.(`<div class="fe-message-canvas">${hydrated}</div>`);
          onImageStatus?.({
            hasBlockedImages:
              (cached.blockedRemoteImageCount || 0) > 0 || (cached.trackingPixelCount || 0) > 0,
            trackingPixelCount: cached.trackingPixelCount || 0,
            blockedRemoteImageCount: cached.blockedRemoteImageCount || 0,
          });
          onAttachments?.(sanitizeAttachments(cached.attachments || []));
          tracer.stage('cache_fallback');
          tracer.end({ status: 'cache_fallback' });
        }
      } catch {
        // ignore
      }
      tracer.end({ status: 'error' });
    } finally {
      onLoading?.(false);
    }
  },

  async loadMessageDetailNetwork({
    message,
    folder,
    onBody,
    onAttachments,
    onError,
    onMeta,
    onImageStatus,
    metaOnly = false,
    signal,
  }: {
    message: Message;
    folder: string;
    onBody?: (html: string) => void;
    onAttachments?: (attachments: Attachment[]) => void;
    onError?: (error: Error) => void;
    onMeta?: (meta: unknown) => void;
    onImageStatus?: (status: ImageStatus) => void;
    metaOnly?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const account = Local.get('email') || 'default';
    const messageId = getMessageApiId(message);
    if (!messageId) return;
    try {
      abortIfNeeded(signal);
      const detailRes = await Remote.request(
        'Message',
        {},
        {
          method: 'GET',
          pathOverride: `/v1/messages/${encodeURIComponent(messageId)}?folder=${encodeURIComponent(folder || '')}&raw=false`,
          signal,
        },
      );
      const result = ((detailRes as { Result?: unknown })?.Result || detailRes) as Record<
        string,
        unknown
      >;
      onMeta?.(result);

      if (metaOnly) {
        try {
          await db.messageBodies
            .where('[account+id]')
            .equals([account, messageId])
            .modify({ meta: isMemoryConstrained ? slimBodyMeta(result) : result });
        } catch {
          // ignore meta-only cache update errors
        }
        return;
      }

      const serverText =
        result?.Plain ||
        result?.text ||
        result?.body ||
        result?.preview ||
        (result?.nodemailer as Record<string, unknown>)?.text ||
        (result?.nodemailer as Record<string, unknown>)?.preview;
      const rawBody =
        result?.html ||
        result?.Html ||
        result?.textAsHtml ||
        (result?.nodemailer as Record<string, unknown>)?.html ||
        (result?.nodemailer as Record<string, unknown>)?.textAsHtml ||
        serverText ||
        message.snippet ||
        '';

      const detailAttachments = ((result?.nodemailer as Record<string, unknown>)?.attachments ||
        result?.attachments ||
        []) as unknown[];
      const mappedAttachments = (detailAttachments || []).map((att: unknown) => {
        const a = att as Record<string, unknown>;
        const contentId = a.cid || a.contentId;
        const disposition = (a.disposition || a.contentDisposition || '').toString().toLowerCase();
        const isInline = disposition === 'inline' || !!contentId;
        const hasUrl = !!a.url;

        let href: string | undefined;
        if (hasUrl) {
          href = a.url as string;
        } else if (isInline && a.content) {
          href = bufferToDataUrl(a);
        }

        return {
          name: (a.name || a.filename) as string,
          filename: a.filename as string,
          size: (a.size ||
            (a.content as ArrayBuffer)?.byteLength ||
            (a.content as Uint8Array)?.length ||
            0) as number,
          contentId: contentId as string,
          disposition,
          href,
          contentType: (a.contentType || a.mimeType || a.type) as string,
          needsDownload: !href && !hasUrl,
        };
      });
      const attachments = sanitizeAttachments(mappedAttachments);

      const sanitized = sanitizeHtml(rawBody as string);
      onBody?.(sanitized.html);
      onImageStatus?.({
        hasBlockedImages: sanitized.hasBlockedImages,
        trackingPixelCount: sanitized.trackingPixelCount,
        blockedRemoteImageCount: sanitized.blockedRemoteImageCount,
      });
      onAttachments?.(attachments);
      await cacheMessageContent(
        message,
        rawBody as string,
        attachments,
        rawBody as string,
        '',
        result,
        account,
        undefined,
        { leanAttachments: true },
      );
    } catch (error: unknown) {
      if ((error as { name?: string })?.name === 'AbortError') {
        return;
      }
      warn('loadMessageDetailNetwork failed', error);
      onError?.(error as Error);
    }
  },

  async downloadAttachment(attachment: Attachment, message: Message): Promise<void> {
    if (!attachment) return;

    const filename = attachment.filename || attachment.name || 'attachment';
    const contentType = attachment.contentType || 'application/octet-stream';

    if (attachment.href) {
      triggerDownload(attachment.href, filename);
      return;
    }

    if (!message?.id) {
      return;
    }

    const folder = message.folder_path || message.folder;
    const messageId = getMessageApiId(message);
    const account = Local.get('email') || 'default';

    // A message can carry two attachments with the same filename, so the blob
    // cache key also names the part: its part id or content id when it has
    // one, otherwise which of the same-named attachments it is.
    const knownPart = attachment.partId ?? attachment.contentId;
    const blobKeyFor = (rank: number) => ({ filename, partId: knownPart ?? rank });

    let cachedHit: AttachmentMatch | null = null;
    try {
      const cached = (await db.messageBodies
        .where('[account+id]')
        .equals([account, messageId])
        .first()) as CachedBody | undefined;
      if (cached?.attachments?.length) {
        cachedHit = findAttachmentMatch(cached.attachments, attachment, filename);
      }
    } catch {
      // Cache lookup failed, fall through to the blob cache and the API
    }

    // Check attachment blob cache first (for offline access). Without a part
    // id and no cached list to place the attachment in, the key is unknown.
    if (knownPart != null || cachedHit) {
      try {
        const cachedBlob = await getCachedAttachmentBlob(
          messageId,
          blobKeyFor(cachedHit?.rank ?? 0),
        );
        if (cachedBlob) {
          triggerDownload(cachedBlob, filename);
          return;
        }
      } catch {
        // Blob cache miss, continue
      }
    }

    // Use the content in the IndexedDB messageBodies cache
    try {
      if (cachedHit) {
        const cachedMatch = cachedHit.match;
        if (cachedMatch.url) {
          triggerDownload(cachedMatch.url as string, filename);
          return;
        } else if (cachedMatch.content) {
          const cachedContentType = (cachedMatch.contentType ||
            cachedMatch.mimeType ||
            contentType) as string;
          const bytes = contentToBytes(cachedMatch.content);
          const isLarge = (attachment.size || 0) > LARGE_ATTACHMENT_BYTES;
          // For large attachments we skip the data-URL stage entirely
          // (it would build a multi-hundred-MB base64 string and OOM
          // the renderer). Smaller files keep the cache write so they
          // stay available offline.
          if (bytes && (isLarge || !bytes.byteLength)) {
            triggerDownloadBytes(bytes, filename, cachedContentType);
            return;
          }
          const dataUrl = bufferToDataUrl({
            content: cachedMatch.content,
            contentType: cachedContentType,
          });
          if (!isLarge) {
            cacheAttachmentBlob(messageId, blobKeyFor(cachedHit.rank), dataUrl).catch(() => {});
          }
          triggerDownload(dataUrl, filename);
          return;
        }
      }
    } catch {
      // Reading the cached content failed, fall through to API call
    }

    // Fall back to API call if not found in cache
    try {
      const detailRes = await Remote.request(
        'Message',
        {},
        {
          method: 'GET',
          pathOverride: `/v1/messages/${encodeURIComponent(messageId)}?folder=${encodeURIComponent(folder || '')}&raw=false`,
        },
      );
      const result = ((detailRes as { Result?: unknown })?.Result || detailRes) as Record<
        string,
        unknown
      >;
      const serverAttachments = ((result?.nodemailer as Record<string, unknown>)?.attachments ||
        result?.attachments ||
        []) as unknown[];

      const serverHit = findAttachmentMatch(serverAttachments, attachment, filename);
      if (!serverHit) {
        return;
      }
      const match = serverHit.match;

      if (match.url) {
        triggerDownload(match.url as string, filename);
      } else if (match.content) {
        const matchContentType = (match.contentType || match.mimeType || contentType) as string;
        const bytes = contentToBytes(match.content);
        const isLarge = (attachment.size || 0) > LARGE_ATTACHMENT_BYTES;
        if (bytes && (isLarge || !bytes.byteLength)) {
          triggerDownloadBytes(bytes, filename, matchContentType);
          return;
        }
        const dataUrl = bufferToDataUrl({
          content: match.content,
          contentType: matchContentType,
        });
        if (!isLarge) {
          cacheAttachmentBlob(messageId, blobKeyFor(serverHit.rank), dataUrl).catch(() => {});
        }
        triggerDownload(dataUrl, filename);
      }
    } catch {
      // Failed to download attachment
    }
  },
};

interface AttachmentMatch {
  match: Record<string, unknown>;
  // Position among the attachments that share its filename.
  rank: number;
}

const attachmentContentLength = (a: Record<string, unknown>): number =>
  (a.content as ArrayBuffer)?.byteLength || (a.content as Uint8Array)?.length || 0;

/**
 * Find the entry in a message's attachment list for the attachment the user
 * picked. Filenames can repeat within one message, so among same-named
 * entries the content id and then the size decide which one it is.
 */
function findAttachmentMatch(
  list: unknown[],
  attachment: Attachment & { name?: string },
  filename: string,
): AttachmentMatch | null {
  const sameName = (list || []).filter((att) => {
    const a = (att || {}) as Record<string, unknown>;
    return (a.filename || a.name) === filename || (a.name || a.filename) === attachment.name;
  }) as Record<string, unknown>[];
  if (!sameName.length) return null;

  let rank = -1;
  const contentId = attachment.contentId || attachment.cid;
  if (contentId) {
    rank = sameName.findIndex((a) => (a.contentId || a.cid) === contentId);
  }
  if (rank === -1 && attachment.size && sameName.length > 1) {
    rank = sameName.findIndex((a) => (a.size || attachmentContentLength(a)) === attachment.size);
  }
  if (rank === -1) rank = 0;
  return { match: sameName[rank], rank };
}

type SanitizeResult = ReturnType<typeof sanitizeHtml>;

async function cacheMessageContent(
  message: Message,
  renderedBody: string,
  attachments: Attachment[] = [],
  rawBodyForCache: string,
  textContent = '',
  meta: unknown = null,
  account?: string,
  // The sanitizeHtml result for renderedBody, when the caller already has it.
  // DOMPurify on a large email is a long main-thread task, and every path that
  // shows a body had just run it on the same HTML.
  presanitized?: SanitizeResult,
  // A body downloaded in the clear: on a phone its large attachments are
  // listed without their content, and opened from the server
  { leanAttachments = false }: { leanAttachments?: boolean } = {},
): Promise<void> {
  const messageId = getMessageApiId(message);
  if (!messageId || !renderedBody) return;
  const resolvedAccount = account || Local.get('email') || 'default';
  let safeAttachments = (attachments || []).map((att) => ({
    name: att.name,
    filename: att.filename,
    size: att.size,
    contentId: att.contentId,
    href: att.href,
    contentType: att.contentType,
  }));
  // A phone keeps a lean copy, as the sync worker does (see slimBodyMeta).
  // Large attachments are left out only of a body just downloaded in the clear
  // (leanAttachments): those of a decrypted PGP message exist on the server
  // only encrypted, and a copy cached before is kept as it is.
  if (isMemoryConstrained) {
    meta = slimBodyMeta(meta);
    if (leanAttachments) safeAttachments = slimCachedAttachments(safeAttachments);
  }

  const sanitized = presanitized || sanitizeHtml(renderedBody);

  // (on a phone not the rendered body a second time)
  const rawOriginal =
    isMemoryConstrained && (!rawBodyForCache || rawBodyForCache === renderedBody)
      ? undefined
      : rawBodyForCache || renderedBody;
  const normalizedText = textContent || extractTextContent(renderedBody);

  const record = {
    id: messageId,
    account: resolvedAccount,
    folder: message.folder,
    body: sanitized.html,
    raw: rawOriginal,
    textContent: normalizedText,
    attachments: safeAttachments,
    meta,
    // The attachment list is worked out (see the sync worker's persistBody)
    attachmentsResolved: true,
    updatedAt: Date.now(),
    sanitizedAt: Date.now(),
    trackingPixelCount: sanitized.trackingPixelCount || 0,
    blockedRemoteImageCount: sanitized.blockedRemoteImageCount || 0,
  };
  try {
    await db.messageBodies.put(record);
  } catch (err) {
    debugWarn('Cache message content failed', err);
  }
}

async function getStoredKeys(): Promise<PgpKey[]> {
  try {
    const currentAcct = Local.get('email') || 'default';
    const accountKey = `pgp_keys_${currentAcct}`;
    const raw = Local.get(accountKey);
    debugLog(
      '[PGP] Reading stored keys from localStorage...',
      raw ? 'Keys found' : 'No keys found',
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const keys = Array.isArray(parsed) ? parsed : [];
    debugLog(`[PGP] Loaded ${keys.length} key(s) from storage for account ${currentAcct}`);
    return keys;
  } catch {
    return [];
  }
}

function loadStoredPassphrases(): Record<string, string> {
  try {
    const currentAcct = Local.get('email') || 'default';
    const accountKey = `pgp_passphrases_${currentAcct}`;
    const raw = Local.get(accountKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    debugLog('[PGP] Loaded stored passphrases for', Object.keys(parsed).length, 'key(s)');
    return parsed;
  } catch {
    return {};
  }
}

function persistStoredPassphrases(passphrases: Record<string, string>): void {
  const currentAcct = Local.get('email') || 'default';
  const accountKey = `pgp_passphrases_${currentAcct}`;
  const filtered = Object.fromEntries(
    Object.entries(passphrases || {}).filter(
      ([name, value]) => Boolean(name) && typeof value === 'string' && value.trim().length > 0,
    ),
  );
  if (Object.keys(filtered).length > 0) {
    Local.set(accountKey, JSON.stringify(filtered));
  } else {
    Local.remove(accountKey);
  }
  refreshSyncWorkerPgpKeys();
}

function savePassphrase(keyName: string, passphrase: string): boolean {
  try {
    passphraseCache.set(keyName, passphrase);
    const stored = loadStoredPassphrases();
    stored[keyName] = passphrase;
    persistStoredPassphrases(stored);
    debugLog('[PGP] Saved passphrase for key:', keyName);
    return true;
  } catch {
    return false;
  }
}

function clearSavedPassphrase(keyName: string): void {
  passphraseCache.delete(keyName);
  try {
    const stored = loadStoredPassphrases();
    if (stored[keyName]) {
      delete stored[keyName];
      persistStoredPassphrases(stored);
    }
  } catch {
    // Ignore storage cleanup failures; retry flow will still re-prompt from memory state.
  }
}

function getStoredPassphrase(keyName: string): string | null {
  const stored = loadStoredPassphrases();
  return stored[keyName] || null;
}

async function showMissingKeyNotification(account?: string): Promise<void> {
  const accountKey = account || Local.get('email') || 'default';
  if (missingKeyModalShownByAccount.has(accountKey) || hasDismissedPgpModal(accountKey)) return;
  missingKeyModalShownByAccount.add(accountKey);

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const cleanup = createPgpModal({
    onConfirm: () => {
      if (timeoutId) clearTimeout(timeoutId);
      cleanup();
      setDismissedPgpModal(true, accountKey);
      setTimeout(() => {
        window.location.href = '/mailbox/settings#accounts';
      }, 0);
    },
    onClose: () => {
      if (timeoutId) clearTimeout(timeoutId);
      missingKeyModalShownByAccount.delete(accountKey);
      setDismissedPgpModal(true, accountKey);
    },
  });

  timeoutId = setTimeout(() => {
    missingKeyModalShownByAccount.delete(accountKey);
    cleanup?.();
  }, 60000);
}

// Cache to track which keys need passphrases (to avoid repeated checks)
const keyNeedsPassphraseCache = new Map<string, boolean>();

async function tryDecrypt(
  armored: string,
  options: { allowPrompt?: boolean; messageId?: string; account?: string } = {},
): Promise<DecryptResult> {
  const allowPrompt = options.allowPrompt !== false;
  if (!armored || typeof armored !== 'string') {
    debugLog('[PGP] No armored message to decrypt');
    return { success: false };
  }

  debugLog('[PGP] [WORKER] Detected PGP encrypted message, attempting to decrypt...');

  const keys = await getStoredKeys();
  if (!keys.length) {
    debugWarn('[PGP] No PGP keys configured in settings');
    if (allowPrompt) {
      await showMissingKeyNotification(options.account);
    }
    return { success: false };
  }

  // The worker usually holds unlocked keys already (from launch, or the
  // first message this session). Asking it first skips the per-key unlock
  // round trips, and the key derivation each of those ran, on every open.
  const first = await decryptInWorker(armored, options);
  if (first.success) return first;

  let lastUnlockError: string | undefined;

  for (const key of keys) {
    let passphrase = passphraseCache.get(key.name);
    if (!passphrase) {
      passphrase = getStoredPassphrase(key.name) || undefined;
      if (passphrase) {
        passphraseCache.set(key.name, passphrase);
      }
    }

    // Check if this key needs a passphrase (some PGP keys are unprotected)
    let needsPassphrase = keyNeedsPassphraseCache.get(key.name);
    if (needsPassphrase === undefined) {
      try {
        const checkResult = await unlockPgpKey({
          keyName: key.name,
          keyValue: key.value,
          checkOnly: true,
        });

        if (
          checkResult.success &&
          checkResult.alreadyUnlocked &&
          checkResult?.needsPassphrase === false
        ) {
          debugLog(`[PGP] Key "${key.name}" is unprotected, unlocked without passphrase`);
          keyNeedsPassphraseCache.delete(key.name);
          await unlockPgpKey({
            keyName: key.name,
            keyValue: key.value,
            checkOnly: false,
          });
          continue;
        }

        needsPassphrase = checkResult?.needsPassphrase !== false;
        if (needsPassphrase) {
          keyNeedsPassphraseCache.set(key.name, true);
        } else {
          keyNeedsPassphraseCache.delete(key.name);
        }

        if (!needsPassphrase && checkResult?.success === false) {
          clearSavedPassphrase(key.name);
          lastUnlockError =
            checkResult?.error ||
            `Stored PGP key "${key.name}" is not a usable private key. Replace it in Settings.`;
          debugWarn(`[PGP] Key "${key.name}" is not a usable private key:`, lastUnlockError);
          continue;
        }
      } catch {
        needsPassphrase = true;
        keyNeedsPassphraseCache.set(key.name, true);
      }
    }

    if (!needsPassphrase) {
      try {
        await unlockPgpKey({
          keyName: key.name,
          keyValue: key.value,
          checkOnly: false,
        });
      } catch {
        // Ignore and allow the final decrypt attempt to surface the worker error.
      }
      continue;
    }

    while (needsPassphrase) {
      let rememberPassphrase = false;
      let promptedThisAttempt = false;

      if (!passphrase) {
        const modal = await getPassphraseModalIfAvailable(allowPrompt);
        if (!modal?.open) {
          break;
        }

        debugLog(`[PGP] [WORKER] Prompting user for passphrase for key "${key.name}"`);
        try {
          const res = await withTimeout(
            modal.open(key.name || 'PGP key'),
            PASSPHRASE_MODAL_TIMEOUT,
            'Passphrase modal',
          );
          passphrase = res?.passphrase?.trim();
          rememberPassphrase = res?.remember !== false;
          promptedThisAttempt = true;

          if (!passphrase) {
            break;
          }
        } catch (err: unknown) {
          const isTimeout = (err as Error)?.message?.includes('timed out');
          debugLog(
            `[PGP] [WORKER] ${isTimeout ? 'Passphrase modal timed out' : 'User cancelled'} for key "${key.name}"`,
          );
          break;
        }
      }

      let retryableFailure = false;
      let unlockError = '';

      try {
        const result = await unlockPgpKey({
          keyName: key.name,
          passphrase,
          keyValue: key.value,
          remember: false,
        });

        if (result.success) {
          debugLog(`[PGP] [WORKER] Successfully unlocked key "${key.name}" in worker`);
          if (passphrase && rememberPassphrase) {
            savePassphrase(key.name, passphrase);
          }
          break;
        }

        unlockError =
          result?.error ||
          `PGP key "${key.name}" could not be unlocked with the provided passphrase.`;
        retryableFailure = result?.retryable !== false && result?.needsPassphrase !== false;
        if (!retryableFailure) {
          keyNeedsPassphraseCache.delete(key.name);
        }
        debugWarn(`[PGP] [WORKER] Unlock rejected for key "${key.name}":`, unlockError);
      } catch (err) {
        unlockError = err instanceof Error ? err.message : 'Failed to unlock key';
        retryableFailure = false;
        debugWarn(`[PGP] [WORKER] Failed to unlock key "${key.name}" in worker:`, err);
      }

      clearSavedPassphrase(key.name);
      passphrase = undefined;
      lastUnlockError = unlockError || lastUnlockError;

      if (!retryableFailure) {
        break;
      }

      if (promptedThisAttempt) {
        break;
      }

      if (!allowPrompt) {
        break;
      }
    }
  }

  return decryptInWorker(armored, options, lastUnlockError);
}

async function decryptInWorker(
  armored: string,
  options: { messageId?: string; account?: string },
  lastUnlockError?: string,
): Promise<DecryptResult> {
  try {
    debugLog('[PGP] [WORKER] Requesting decryption from worker...');
    const result = await requestPgpDecryption({
      raw: armored,
      messageId: options.messageId,
      account: options.account || Local.get('email') || 'default',
    });

    if (result.success) {
      debugLog('[PGP] [WORKER] Successfully decrypted message in worker');

      return {
        success: true,
        body: result.body,
        textContent: result.textContent,
        attachments: result.attachments,
        subject: typeof result.subject === 'string' ? result.subject : undefined,
        signed: Boolean(result.signed),
      };
    } else {
      const failureMessage =
        lastUnlockError && /no unlocked keys available/i.test(result?.message || '')
          ? lastUnlockError
          : result.message;
      debugWarn('[PGP] [WORKER] Decryption failed:', result.reason, failureMessage);
      return {
        success: false,
        reason: result.reason,
        message: failureMessage,
        keyCount: result.keyCount,
      };
    }
  } catch {
    return { success: false, message: lastUnlockError };
  }
}
