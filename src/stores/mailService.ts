import { Remote } from '../utils/remote.js';
import Dexie from 'dexie';
import { db } from '../utils/db.js';
import { Local } from '../utils/storage.js';
import { sanitizeHtml } from '../utils/sanitize.js';
import { formatFriendlyDate } from '../utils/date.ts';
import { createPerfTracer } from '../utils/perf-logger.ts';
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
import type { Message, Attachment, PerfTracer, PgpKey } from '../types';
import { warn } from '../utils/logger.ts';

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

/**
 * Extract PGP armor block from raw content.
 * Handles PGP/MIME messages where the armor is inside MIME boundary parts.
 * Returns just the '-----BEGIN PGP MESSAGE-----' ... '-----END PGP MESSAGE-----' block,
 * or the original string if no extraction is needed.
 */
function extractPgpArmor(raw: string): string {
  if (!raw || typeof raw !== 'string') return raw;
  const beginIdx = raw.indexOf('-----BEGIN PGP MESSAGE-----');
  const endIdx = raw.indexOf('-----END PGP MESSAGE-----');
  if (beginIdx >= 0 && endIdx > beginIdx) {
    return raw.substring(beginIdx, endIdx + '-----END PGP MESSAGE-----'.length);
  }
  return raw;
}

/**
 * Detect if raw content is a PGP-encrypted message (inline PGP or PGP/MIME).
 */
function isPgpEncrypted(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  if (raw.includes('-----BEGIN PGP MESSAGE-----')) return true;
  // PGP/MIME: Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"
  if (raw.includes('multipart/encrypted') && raw.includes('application/pgp-encrypted')) {
    return true;
  }
  return false;
}

// Trigger file download via temporary anchor element
function triggerDownload(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function isCachedBodyComplete(cached: CachedBody | undefined): boolean {
  if (!cached?.body) return false;
  // Stale PGP bodies (raw MIME stored as body) are not complete
  if (typeof cached.body === 'string' && isPgpEncrypted(cached.body)) return false;
  return true;
}

let passphraseModalRef: PassphraseModalRef | null = null;
const passphraseCache = new Map<string, string>();
const missingKeyModalShownByAccount = new Set<string>();

// Track in-flight message detail requests to prevent duplicate concurrent fetches
const inFlightRequests = new Map<string, Promise<unknown>>();

// Track recent cache hits to prevent rapid repeated onBody calls for the same message
const recentCacheHits = new Map<string, number>();
const CACHE_HIT_DEBOUNCE_MS = 500;
const MAX_CACHE_HIT_ENTRIES = 200;

// Account-level AbortController — aborted on account switch to cancel stale fetches
let accountAbortController: AbortController | null = null;

function getAccountSignal(): AbortSignal {
  if (!accountAbortController) {
    accountAbortController = new AbortController();
  }
  return accountAbortController.signal;
}

function composeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if ('any' in AbortSignal) {
    return (AbortSignal as unknown as { any(signals: AbortSignal[]): AbortSignal }).any([a, b]);
  }
  const controller = new AbortController();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  const onAbort = () => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

function pruneRecentCacheHits(): void {
  if (recentCacheHits.size <= MAX_CACHE_HIT_ENTRIES) return;
  // Remove oldest entries to stay within bounds
  const entries = [...recentCacheHits.entries()].sort((a, b) => a[1] - b[1]);
  const toRemove = entries.slice(0, entries.length - MAX_CACHE_HIT_ENTRIES);
  for (const [key] of toRemove) {
    recentCacheHits.delete(key);
  }
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
const getPgpDismissKey = (account: string): string => `pgp_modal_dismissed_${account || 'default'}`;

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

export const setPassphraseModal = (modal: PassphraseModalRef): void => {
  passphraseModalRef = modal;
};

/**
 * Clear PGP key caches when keys are updated in settings
 * This ensures fresh checks for passphrase requirements
 */
export const clearPgpKeyCache = (): void => {
  passphraseCache.clear();
  keyNeedsPassphraseCache.clear();
  missingKeyModalShownByAccount.clear();
  recentCacheHits.clear(); // Allow immediate re-evaluation after key changes
};

/**
 * Invalidate cached message bodies that contain PGP-encrypted content.
 * Called after PGP keys are added/removed so the next load re-attempts decryption.
 */
export const invalidatePgpCachedBodies = async (account: string): Promise<void> => {
  try {
    const allBodies = await db.messageBodies
      .where('[account+id]')
      .between([account, Dexie.minKey], [account, Dexie.maxKey])
      .toArray();
    const staleKeys = allBodies
      .filter(
        (b) =>
          (b.raw && typeof b.raw === 'string' && isPgpEncrypted(b.raw)) ||
          (b.body && typeof b.body === 'string' && isPgpEncrypted(b.body)),
      )
      .map((b) => [b.account, b.id]);
    if (staleKeys.length) {
      await db.messageBodies.bulkDelete(staleKeys);
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
  recentCacheHits.clear();
};

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

  // Re-check cache before attempting decryption - background task may have already decrypted
  const messageId = getMessageApiId(message);
  if (messageId) {
    try {
      const freshCache = (await db.messageBodies
        .where('[account+id]')
        .equals([account, messageId])
        .first()) as CachedBody | undefined;
      if (freshCache?.body && !isPgpEncrypted(freshCache.body)) {
        // Already decrypted by background task - check for debouncing
        const cacheKey = `${account}:${messageId}`;
        const lastHitTime = recentCacheHits.get(cacheKey) || 0;
        const nowMs = Date.now();
        const isRecentHit = nowMs - lastHitTime < CACHE_HIT_DEBOUNCE_MS;

        onPgpStatus?.({ locked: false });

        if (isRecentHit) {
          debugLog('[PGP] Cache hit debounced for message', messageId);
          tracer.end({ status: `${stage}_pgp_debounced` });
          return true;
        }

        recentCacheHits.set(cacheKey, nowMs);
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
    onPgpStatus?.({ locked: false });
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
    );

    // Update debounce timestamp after successful decryption
    if (messageId) {
      recentCacheHits.set(`${account}:${messageId}`, Date.now());
    }

    tracer.stage('cache_write', { cached: true });
    tracer.end({ status: `${stage}_pgp_decrypted` });
    return true;
  }
  debugLog('[PGP] Cached message still locked');
  onPgpStatus?.({ locked: true });
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
function calculatePrefetchPriority(msg: Message, folder: string): number {
  let score = 0;
  if (msg.is_unread) score += 100;
  if (folder?.toUpperCase() === 'INBOX') score += 50;
  const ageMs = Date.now() - (msg.date || 0);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) score += 40;
  else if (ageDays < 7) score += 20;
  if (msg.has_attachment) score += 10;
  return score;
}

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
      onBody,
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

      const cached = (await db.messageBodies
        .where('[account+id]')
        .equals([account, messageId])
        .first()) as CachedBody | undefined;
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

        // Check for rapid repeated cache hits - debounce onBody calls
        const cacheKey = `${account}:${messageId}`;
        const lastHitTime = recentCacheHits.get(cacheKey) || 0;
        const now = Date.now();
        const isRecentHit = now - lastHitTime < CACHE_HIT_DEBOUNCE_MS;

        onPgpStatus?.({ locked: false });
        tracer.stage('cache_hit', { fresh: true, cacheAge: 0, debounced: isRecentHit });

        if (isRecentHit) {
          // Skip calling onBody again - we just called it recently
          debugLog(`[mailService] Cache hit debounced for message ${messageId}`);
          onLoading?.(false);
          tracer.end({ status: 'cache_debounced' });
          return;
        }

        // Update recent hit timestamp
        recentCacheHits.set(cacheKey, now);
        pruneRecentCacheHits();

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
        onMeta?.(cached.meta);
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
          return { source: 'main', detailRes: { raw: workerResult.raw }, workerResult };
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
        pgpLocked?: boolean;
        raw?: string;
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
        onPgpStatus?.({ locked: false });
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
          null,
          account,
        ).catch(() => {});
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
        const isInline = !!contentId;
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
          size: a.size as number,
          contentId: contentId as string,
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
          onPgpStatus?.({ locked: false });
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
          await cacheMessageContent(
            message,
            parsed.body || '',
            parsedAttachments,
            parsed.rawBody || '',
            parsed.textContent || '',
            result,
            account,
          );
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
        const parseResult = await requestParsing({
          raw: rawBody as string,
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
          await cacheMessageContent(
            message,
            parsed.body || '',
            parsedAttachments,
            parsed.rawBody || '',
            parsed.textContent || '',
            result,
            account,
          );
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
          await cacheMessageContent(
            message,
            inlinedBody,
            attachments,
            rawBody as string,
            (serverText as string) || extractTextContent(inlinedBody || (rawBody as string)),
            result,
            account,
          );
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
            .modify({ meta: result });
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
        const isInline = !!contentId;
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
          size: a.size as number,
          contentId: contentId as string,
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
      );
    } catch (error: unknown) {
      if ((error as { name?: string })?.name === 'AbortError') {
        return;
      }
      warn('loadMessageDetailNetwork failed', error);
      onError?.(error as Error);
    }
  },

  async prefetchBodies(
    messages: Message[] = [],
    options: { limit?: number; concurrency?: number; folder?: string; prioritize?: boolean } = {},
  ): Promise<void> {
    const enabledRaw = Local.get('cache_prefetch_enabled');
    if (enabledRaw === 'false') {
      return;
    }

    const account = Local.get('email') || 'default';
    const limit = Math.max(1, options.limit || 50);
    const concurrency = Math.max(1, options.concurrency || 3);
    const folder = options.folder || '';
    const prioritize = options.prioritize ?? true;
    let list = Array.isArray(messages) ? [...messages] : [];

    if (!list.length) return;

    if (await shouldThrottleForQuota()) {
      debugWarn('[mailService] Prefetch skipped due to quota pressure');
      return;
    }

    // Priority sorting for prefetch
    if (prioritize && list.length > 1) {
      list = list
        .map((msg) => ({ msg, score: calculatePrefetchPriority(msg, folder) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((p) => p.msg);
    } else {
      list = list.slice(0, limit);
    }

    // Collect messages with valid API IDs
    const msgsWithIds = list
      .map((msg) => {
        const apiId = getMessageApiId(msg);
        return apiId ? { msg, apiId } : null;
      })
      .filter((item): item is { msg: Message; apiId: string } => item !== null);

    if (!msgsWithIds.length) return;

    // Bulk fetch all cached bodies in a single query (instead of N+1 queries)
    const keys = msgsWithIds.map(({ apiId }) => [account, apiId]);
    let cachedBodies: (CachedBody | undefined)[] = [];
    try {
      cachedBodies = (await db.messageBodies.bulkGet(keys)) as (CachedBody | undefined)[];
    } catch {
      // If bulk fetch fails, treat all as uncached
      cachedBodies = new Array(msgsWithIds.length).fill(undefined);
    }

    // Find messages that need fetching (not cached or incomplete)
    const pending: Message[] = msgsWithIds
      .filter((_, i) => !isCachedBodyComplete(cachedBodies[i]))
      .map(({ msg, apiId }) => ({ ...msg, id: apiId, uid: msg.uid || msg.id }));

    if (!pending.length) return;

    await runWithConcurrency(pending, concurrency, async (msg) => {
      try {
        await mailService.loadMessageDetail(msg, { allowPgpPrompt: false });
      } catch (err) {
        debugWarn('[mailService] Prefetch body failed', err);
      }
    });
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

    // Check attachment blob cache first (for offline access)
    try {
      const cachedBlob = await getCachedAttachmentBlob(messageId, filename);
      if (cachedBlob) {
        triggerDownload(cachedBlob, filename);
        return;
      }
    } catch {
      // Blob cache miss, continue
    }

    // Check IndexedDB messageBodies cache
    try {
      const cached = (await db.messageBodies
        .where('[account+id]')
        .equals([account, messageId])
        .first()) as CachedBody | undefined;

      if (cached?.attachments?.length) {
        const cachedMatch = cached.attachments.find((a) => {
          const att = a as Record<string, unknown>;
          return (
            (att.filename || att.name) === filename ||
            (att.name || att.filename) === (attachment as Record<string, unknown>).name
          );
        }) as Record<string, unknown> | undefined;

        if (cachedMatch) {
          if (cachedMatch.url) {
            triggerDownload(cachedMatch.url as string, filename);
            return;
          } else if (cachedMatch.content) {
            const dataUrl = bufferToDataUrl({
              content: cachedMatch.content,
              contentType: (cachedMatch.contentType ||
                cachedMatch.mimeType ||
                contentType) as string,
            });
            // Cache blob for future offline access
            cacheAttachmentBlob(messageId, filename, dataUrl, attachment.size || 0).catch(() => {});
            triggerDownload(dataUrl, filename);
            return;
          }
        }
      }
    } catch {
      // Cache lookup failed, fall through to API call
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

      const match = serverAttachments.find((att: unknown) => {
        const a = att as Record<string, unknown>;
        return (a.filename || a.name) === filename || (a.name || a.filename) === attachment.name;
      }) as Record<string, unknown> | undefined;

      if (!match) {
        return;
      }

      if (match.url) {
        triggerDownload(match.url as string, filename);
      } else if (match.content) {
        const dataUrl = bufferToDataUrl({
          content: match.content,
          contentType: (match.contentType || match.mimeType || contentType) as string,
        });
        // Cache blob for future offline access
        cacheAttachmentBlob(messageId, filename, dataUrl, attachment.size || 0).catch(() => {});
        triggerDownload(dataUrl, filename);
      }
    } catch {
      // Failed to download attachment
    }
  },
};

async function cacheMessageContent(
  message: Message,
  renderedBody: string,
  attachments: Attachment[] = [],
  rawBodyForCache: string,
  textContent = '',
  meta: unknown = null,
  account?: string,
): Promise<void> {
  const messageId = getMessageApiId(message);
  if (!messageId || !renderedBody) return;
  const resolvedAccount = account || Local.get('email') || 'default';
  const safeAttachments = (attachments || []).map((att) => ({
    name: att.name,
    filename: att.filename,
    size: att.size,
    contentId: att.contentId,
    href: att.href,
    contentType: att.contentType,
  }));

  const sanitized = sanitizeHtml(renderedBody);

  const rawOriginal = rawBodyForCache || renderedBody;
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

async function shouldThrottleForQuota(): Promise<boolean> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return false;
    const usage = estimate.usage || 0;
    const quota = estimate.quota || 0;
    const pct = quota ? usage / quota : 0;
    return pct >= 0.9;
  } catch {
    return false;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  const queue = Array.isArray(items) ? [...items] : [];
  const workerCount = Math.max(1, Math.min(limit || 1, queue.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await handler(item);
    }
  });
  await Promise.all(workers);
}

function createPgpModal({
  onConfirm,
  onClose,
}: {
  onConfirm?: () => void;
  onClose?: () => void;
}): () => void {
  if (typeof document === 'undefined') return () => {};

  const isLightMode = document.body.classList.contains('light-mode');

  const overlay = document.createElement('div');
  overlay.className = 'fe-modal-backdrop';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.background = 'rgba(0, 0, 0, 0.6)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '9999';
  overlay.style.padding = '16px';

  const dialog = document.createElement('div');
  dialog.className = 'fe-modal';

  if (isLightMode) {
    dialog.style.background = '#ffffff';
    dialog.style.border = '1px solid #e5e7eb';
    dialog.style.color = '#0f172a';
  } else {
    dialog.style.background = '#0b1220';
    dialog.style.border = '1px solid #1f2937';
    dialog.style.color = '#e5e7eb';
  }

  dialog.style.borderRadius = '12px';
  dialog.style.padding = '18px';
  dialog.style.maxWidth = '500px';
  dialog.style.width = '96%';
  dialog.style.boxShadow = '0 30px 80px rgba(0, 0, 0, 0.4)';

  const headingColor = isLightMode ? '#0f172a' : '#e5e7eb';
  const textColor = isLightMode ? '#334155' : '#cbd5e1';

  dialog.innerHTML = `
    <h3 style="margin-top:0; color: ${headingColor}; font-size: 18px; font-weight: 600;">PGP encrypted message detected</h3>
    <p style="margin: 8px 0 12px; color: ${textColor}; line-height: 1.5;">You need to add a PGP private key to decrypt this message.</p>
    <p style="margin: 0 0 16px; color: ${textColor}; line-height: 1.5;">Go to Settings &gt; Accounts &amp; Security to add a key now?</p>
    <div style="display:flex; gap:10px; justify-content:flex-end;">
      <button type="button" data-role="cancel" class="fe-button ghost" style="padding:8px 16px; cursor:pointer;">Not now</button>
      <button type="button" data-role="confirm" class="fe-button" style="padding:8px 16px; cursor:pointer;">Go to settings</button>
    </div>
  `;

  const cleanup = (): void => {
    if (overlay && overlay.parentNode) {
      overlay.remove();
    }
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      cleanup();
      onClose?.();
    }
  });

  dialog.querySelector('[data-role="cancel"]')?.addEventListener('click', () => {
    cleanup();
    onClose?.();
  });
  dialog.querySelector('[data-role="confirm"]')?.addEventListener('click', () => {
    cleanup();
    onConfirm?.();
  });

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  return cleanup;
}

function sanitizeAttachments(list: unknown[]): Attachment[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((att: unknown) => {
      const a = att as Record<string, unknown>;
      return {
        name: (a.name || a.filename) as string,
        filename: (a.filename || a.name) as string,
        size: (a.size || 0) as number,
        contentId: (a.contentId || a.cid) as string | undefined,
        href:
          a.href ||
          (typeof a.content === 'string' && (a.content as string).startsWith('data:')
            ? a.content
            : undefined),
        contentType: (a.contentType ||
          a.mimeType ||
          a.type ||
          'application/octet-stream') as string,
        needsDownload: (a.needsDownload || false) as boolean,
      } as Attachment;
    })
    .filter((a) => a.name);
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

function savePassphrase(keyName: string, passphrase: string): boolean {
  try {
    passphraseCache.set(keyName, passphrase);
    const stored = loadStoredPassphrases();
    stored[keyName] = passphrase;
    const currentAcct = Local.get('email') || 'default';
    const accountKey = `pgp_passphrases_${currentAcct}`;
    Local.set(accountKey, JSON.stringify(stored));
    refreshSyncWorkerPgpKeys();
    debugLog('[PGP] Saved passphrase for key:', keyName);
    return true;
  } catch {
    return false;
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
      // First time seeing this key - check if it needs a passphrase
      try {
        const checkResult = await unlockPgpKey({
          keyName: key.name,
          keyValue: key.value,
          checkOnly: true,
        });
        needsPassphrase = checkResult.needsPassphrase !== false;
        keyNeedsPassphraseCache.set(key.name, needsPassphrase);

        // If key is already unlocked (unprotected), add it without passphrase
        if (checkResult.success && checkResult.alreadyUnlocked) {
          debugLog(`[PGP] Key "${key.name}" is unprotected, unlocked without passphrase`);
          // Re-call without checkOnly to actually add to worker's unlocked keys
          await unlockPgpKey({
            keyName: key.name,
            keyValue: key.value,
            checkOnly: false,
          });
          continue;
        }
      } catch {
        // Assume needs passphrase if check fails
        needsPassphrase = true;
        keyNeedsPassphraseCache.set(key.name, true);
      }
    }

    // Only prompt for passphrase if the key actually needs one
    if (!passphrase && needsPassphrase && allowPrompt && !passphraseModalRef?.open) {
      warn('[PGP] Passphrase modal ref not available — cannot prompt for passphrase');
    }
    if (!passphrase && needsPassphrase && allowPrompt && passphraseModalRef?.open) {
      debugLog(`[PGP] [WORKER] Prompting user for passphrase for key "${key.name}"`);
      try {
        const res = await withTimeout(
          passphraseModalRef.open(key.name || 'PGP key'),
          PASSPHRASE_MODAL_TIMEOUT,
          'Passphrase modal',
        );
        passphrase = res?.passphrase;

        if (passphrase) {
          debugLog(`[PGP] [WORKER] User provided passphrase for key "${key.name}"`);
          savePassphrase(key.name, passphrase);
        }
      } catch (err: unknown) {
        const isTimeout = (err as Error)?.message?.includes('timed out');
        debugLog(
          `[PGP] [WORKER] ${isTimeout ? 'Passphrase modal timed out' : 'User cancelled'} for key "${key.name}"`,
        );
      }
    }

    if (passphrase) {
      try {
        const result = await unlockPgpKey({
          keyName: key.name,
          passphrase,
          keyValue: key.value,
          remember: false,
        });

        if (result.success) {
          debugLog(`[PGP] [WORKER] Successfully unlocked key "${key.name}" in worker`);
        }
      } catch (err) {
        debugWarn(`[PGP] [WORKER] Failed to unlock key "${key.name}" in worker:`, err);
      }
    }
  }

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
      };
    } else {
      debugWarn('[PGP] [WORKER] Decryption failed:', result.reason, result.message);
      return {
        success: false,
        reason: result.reason,
        message: result.message,
        keyCount: result.keyCount,
      };
    }
  } catch {
    return { success: false };
  }
}
