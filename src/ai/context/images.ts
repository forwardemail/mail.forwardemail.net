/**
 * Image-attachment → Anthropic vision content block.
 *
 * Converts attachments from the mailbox (shape: `{ filename, mimeType,
 * dataUrl }`) into the shared `ContentBlock` form the provider layer
 * expects. Skips non-image attachments, bad data URLs, and anything
 * over the per-image budget so a malformed 20 MB PNG can't blow the
 * request size.
 *
 * Only handles `dataUrl`-hydrated attachments. Attachments that still
 * need to be fetched from the server are out of scope for this MVP —
 * users would have to click them to trigger a download first.
 */

import type { ContentBlock } from '../providers/types';
import type { Attachment } from '../../types';

const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024; // 5 MB
const MAX_IMAGES = 10;
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface ImageAttachmentSummary {
  filename: string;
  mimeType: string;
  approxBytes: number;
}

export interface CollectedImages {
  blocks: Extract<ContentBlock, { type: 'image' }>[];
  summaries: ImageAttachmentSummary[];
  skipped: Array<{ filename: string; reason: string }>;
}

/**
 * Base64 byte-length estimator. A base64 string is 4/3 × original bytes,
 * minus up to 2 `=` padding chars. `(len * 3) / 4` is close enough.
 */
const approxBytesOfBase64 = (b64: string): number => Math.floor((b64.length * 3) / 4);

/**
 * Parse a data URL into `{ mimeType, base64 }`. Accepts standard
 * `data:<mime>;base64,<payload>`; rejects non-base64 encodings.
 */
const parseDataUrl = (dataUrl: string): { mimeType: string; base64: string } | null => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
};

export const collectImageBlocks = (
  attachments: Attachment[] | null | undefined,
): CollectedImages => {
  const result: CollectedImages = { blocks: [], summaries: [], skipped: [] };
  if (!Array.isArray(attachments) || attachments.length === 0) return result;

  for (const att of attachments) {
    const filename = att.filename ?? 'attachment';
    const mime = (att.mimeType ?? att.contentType ?? '').toLowerCase();

    if (!mime.startsWith('image/')) continue;

    if (result.blocks.length >= MAX_IMAGES) {
      result.skipped.push({ filename, reason: `image cap reached (${MAX_IMAGES})` });
      continue;
    }

    if (!SUPPORTED_MIME.has(mime)) {
      result.skipped.push({ filename, reason: `unsupported type: ${mime}` });
      continue;
    }

    if (typeof att.dataUrl !== 'string' || att.dataUrl.length === 0) {
      result.skipped.push({ filename, reason: 'not downloaded yet (open the message to hydrate)' });
      continue;
    }

    const parsed = parseDataUrl(att.dataUrl);
    if (!parsed) {
      result.skipped.push({ filename, reason: 'invalid data URL' });
      continue;
    }

    const bytes = approxBytesOfBase64(parsed.base64);
    if (bytes > MAX_BYTES_PER_IMAGE) {
      result.skipped.push({
        filename,
        reason: `too large (${Math.round(bytes / 1024 / 1024)} MB > ${MAX_BYTES_PER_IMAGE / 1024 / 1024} MB)`,
      });
      continue;
    }

    result.blocks.push({ type: 'image', mime_type: parsed.mimeType, data: parsed.base64 });
    result.summaries.push({ filename, mimeType: parsed.mimeType, approxBytes: bytes });
  }

  return result;
};
