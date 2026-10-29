// Pure helpers extracted from mailService.ts so they can be unit-tested without
// loading the store's heavy I/O graph (Dexie, db worker, Remote, attachment
// cache). These cover two concerns: PGP-armor detection on raw message bodies,
// and the attachment download path (filename sanitization + byte decoding).
// Keep them side-effect-free — anything touching the network, disk, DOM, or
// store state belongs back in mailService.ts.

import type { Attachment } from '../types';
import { REMOTE_IMAGES_BLOCKED_MARKER } from '../utils/remote-images-marker';

/**
 * Trim a raw body down to just its inline PGP MESSAGE block. Returns the input
 * unchanged when no complete armor block is present.
 */
export function extractPgpArmor(raw: string): string {
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
export function isPgpEncrypted(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  if (raw.includes('-----BEGIN PGP MESSAGE-----')) return true;
  // PGP/MIME: Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"
  if (raw.includes('multipart/encrypted') && raw.includes('application/pgp-encrypted')) {
    return true;
  }
  return false;
}

const WINDOWS_RESERVED_FILENAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * Make an attachment filename safe to write to disk: strip control chars and
 * path separators, collapse whitespace, drop trailing dots/spaces, and guard
 * against empty names and Windows reserved device names (CON, NUL, COM1…).
 */
export function sanitizeDownloadFilename(filename: string): string {
  const withoutControlChars = Array.from(String(filename || 'attachment'))
    .map((char) => {
      const code = char.charCodeAt(0);
      return (code >= 0 && code <= 31) || (code >= 127 && code <= 159) ? '_' : char;
    })
    .join('')
    // Bidi overrides, isolates and marks (and other invisible format
    // characters) reorder or hide what the save dialog and file manager show:
    // "invoice_\u202Efdp.exe" displays as "invoice_exe.pdf". ZWJ/ZWNJ stay,
    // as scripts and emoji sequences need them.
    .replace(/[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '');

  const sanitized = withoutControlChars
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return 'attachment';
  }

  const lastDot = sanitized.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < sanitized.length - 1;
  const baseName = (hasExtension ? sanitized.slice(0, lastDot) : sanitized)
    .replace(/[. ]+$/g, '')
    .trim();
  const extension = hasExtension ? sanitized.slice(lastDot) : '';

  const normalizedBaseName = baseName || 'attachment';
  const safeBaseName = WINDOWS_RESERVED_FILENAMES.has(normalizedBaseName.toUpperCase())
    ? `${normalizedBaseName}_`
    : normalizedBaseName;

  return `${safeBaseName}${extension}`;
}

export function buildSaveDialogFilters(filename: string): { name: string; extensions: string[] }[] {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (!extension || extension === filename.toLowerCase()) {
    return [];
  }

  return [
    {
      name: `${extension.toUpperCase()} file`,
      extensions: [extension],
    },
  ];
}

export function decodeBase64ToBytes(value: string): Uint8Array {
  const decoder =
    typeof atob === 'function'
      ? atob
      : (encoded: string) => Buffer.from(encoded, 'base64').toString('binary');
  const binary = decoder(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesFromDataUrl(href: string): Uint8Array | null {
  if (typeof href !== 'string' || !href.startsWith('data:')) return null;
  const commaIndex = href.indexOf(',');
  if (commaIndex === -1) {
    throw new Error('Attachment data URL is malformed');
  }

  const metadata = href.slice(5, commaIndex);
  const payload = href.slice(commaIndex + 1);
  if (/;base64(?:;|$)/i.test(metadata)) {
    return decodeBase64ToBytes(payload.trim());
  }

  return new TextEncoder().encode(decodeURIComponent(payload));
}

// Convert an attachment's `content` field (which may be a base64 string,
// an ArrayBuffer, a typed array, or a { data: number[] } shape) into a
// raw Uint8Array without going through a giant intermediate data URL.
export function contentToBytes(content: unknown): Uint8Array | null {
  if (content == null) return null;
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    const view = content as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(content)) return new Uint8Array(content);
  if (typeof content === 'object' && Array.isArray((content as { data?: unknown }).data)) {
    return new Uint8Array((content as { data: number[] }).data);
  }
  if (typeof content === 'string') {
    const cleaned = content.replace(/\s+/g, '');
    const looksLikeBase64 = /^[A-Za-z0-9/+]+={0,2}$/.test(cleaned);
    if (looksLikeBase64) return decodeBase64ToBytes(cleaned);
    return new TextEncoder().encode(content);
  }
  return null;
}

/** sessionStorage key for the per-account "PGP key missing" dismissed flag. */
export function getPgpDismissKey(account: string): string {
  return `pgp_modal_dismissed_${account || 'default'}`;
}

/**
 * Combine two AbortSignals into one that aborts when either does. Uses native
 * AbortSignal.any when available, else wires one-shot listeners manually.
 */
export function composeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
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

/**
 * Build a fallback filename for an attachment with no name, derived from its
 * content-id (preferred) or content type. Pure.
 */
export function generateAttachmentName(att: Record<string, unknown>): string {
  const contentType = (att.contentType || att.mimeType || att.type || '') as string;
  const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
  const cid = (att.contentId || att.cid || '') as string;
  if (cid) {
    const cleaned = cid.replace(/^<|>$/g, '').split('@')[0];
    if (cleaned) return `${cleaned}.${ext}`;
  }
  return `attachment.${ext}`;
}

/**
 * Normalize a raw attachment list (from the API or cache) into the app's
 * Attachment shape, dropping entries with no resolvable name. Pure transform.
 */
export function sanitizeAttachments(list: unknown[]): Attachment[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((att: unknown) => {
      const a = att as Record<string, unknown>;
      const name = (a.name || a.filename) as string;
      const fallbackName = name || generateAttachmentName(a);
      return {
        name: fallbackName,
        filename: (a.filename || a.name || fallbackName) as string,
        size: (a.size || 0) as number,
        contentId: (a.contentId || a.cid) as string | undefined,
        disposition: (a.disposition || '') as string,
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

/**
 * Whether a cached body has to be sanitized again before it is shown.
 *
 * Besides rows the background writers stored raw (no trackingPixelCount), a
 * body sanitized while remote images were allowed still has them in place.
 * When blocking is on now, that copy would load them, so it is sanitized
 * again. A body sanitized with blocking on carries the blocked marker; the
 * reader restores its images itself when they are allowed.
 */
export function cachedBodyNeedsResanitize(
  cached: { body?: string; trackingPixelCount?: number } | null | undefined,
  blockRemoteImages: boolean,
): boolean {
  if (!cached?.body) return false;
  if (cached.trackingPixelCount === undefined) return true;
  return blockRemoteImages && !cached.body.includes(REMOTE_IMAGES_BLOCKED_MARKER);
}

export interface CachedBodyDisplay {
  html: string;
  hasBlockedImages: boolean;
  trackingPixelCount: number;
  blockedRemoteImageCount: number;
}

/**
 * The HTML to show for a cached body, and its image status.
 *
 * The reader's own cache writes store sanitized HTML with the image counts.
 * The background writers (sync worker, service worker) store the raw body and
 * no counts, so a row without trackingPixelCount is sanitized again before it
 * is shown: the raw HTML still has its remote images and tracking pixels.
 */
export function cachedBodyForDisplay(
  cached: { body?: string; trackingPixelCount?: number; blockedRemoteImageCount?: number },
  sanitize: (html: string) => CachedBodyDisplay,
  blockRemoteImages = false,
): CachedBodyDisplay {
  if (cachedBodyNeedsResanitize(cached, blockRemoteImages)) {
    const sanitized = sanitize(cached.body || '');
    return {
      html: sanitized.html,
      hasBlockedImages: sanitized.hasBlockedImages,
      trackingPixelCount: sanitized.trackingPixelCount,
      blockedRemoteImageCount: sanitized.blockedRemoteImageCount,
    };
  }
  const trackingPixelCount = cached.trackingPixelCount || 0;
  const blockedRemoteImageCount = cached.blockedRemoteImageCount || 0;
  return {
    html: cached.body || '',
    hasBlockedImages: blockedRemoteImageCount > 0 || trackingPixelCount > 0,
    trackingPixelCount,
    blockedRemoteImageCount,
  };
}
