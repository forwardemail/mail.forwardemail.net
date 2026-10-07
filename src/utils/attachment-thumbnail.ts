/**
 * Small previews of image attachments for the compose window.
 *
 * Compose used to show each image as a data: URL of the whole file at 32px.
 * A browser decodes an image at its full size, so a 12-megapixel photo held
 * about 48 MB of pixels for that one small square, for as long as compose
 * was open; on iOS a few photos were enough for the system to kill the web
 * content process (the app then reloads). Each image is now decoded once,
 * drawn onto a small canvas and kept as a small JPEG behind a blob: URL.
 */
import { attachmentToBase64 } from './mime-utils.js';

const SIZE = 96;

interface Entry {
  promise: Promise<string>;
  url: string;
  revoked: boolean;
}

const entries = new WeakMap<object, Entry>();

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

function attachmentType(att: Record<string, unknown>): string {
  const declared = String(att.contentType || att.mimeType || att.type || '')
    .split(/[;,\s]/)[0]
    .trim()
    .toLowerCase();
  return declared.startsWith('image/') ? declared : 'image/jpeg';
}

// One photo decoded at a time: attaching several at once decoded them all
// at full size together, which is the memory peak this module avoids.
let queue: Promise<unknown> = Promise.resolve();

async function decode(blob: Blob): Promise<{
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  release: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      release: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
    release: () => {
      img.src = '';
      URL.revokeObjectURL(url);
    },
  };
}

async function render(att: Record<string, unknown>): Promise<string> {
  const base64 = attachmentToBase64(att);
  if (!base64) return '';
  const image = await decode(base64ToBlob(base64, attachmentType(att)));
  try {
    const scale = Math.min(1, SIZE / Math.max(image.width, image.height, 1));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    image.draw(ctx, width, height);
    const small = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.8),
    );
    canvas.width = 0;
    canvas.height = 0;
    return small ? URL.createObjectURL(small) : '';
  } finally {
    image.release();
  }
}

/**
 * A blob: URL of a small preview of an image attachment, or '' when it
 * cannot be read as an image. One preview per attachment object.
 */
export function attachmentThumbnail(att: unknown): Promise<string> {
  if (!att || typeof att !== 'object') return Promise.resolve('');
  const existing = entries.get(att);
  if (existing) return existing.promise;
  const entry: Entry = { promise: Promise.resolve(''), url: '', revoked: false };
  const rendered = queue.then(() => (entry.revoked ? '' : render(att as Record<string, unknown>)));
  queue = rendered.catch(() => {});
  entry.promise = rendered.then(
    (url) => {
      if (entry.revoked) {
        if (url) URL.revokeObjectURL(url);
        return '';
      }
      entry.url = url;
      return url;
    },
    () => '',
  );
  entries.set(att, entry);
  return entry.promise;
}

/** Frees the preview of an attachment that left the draft. */
export function releaseAttachmentThumbnail(att: unknown): void {
  if (!att || typeof att !== 'object') return;
  const entry = entries.get(att);
  if (!entry) return;
  entry.revoked = true;
  if (entry.url) URL.revokeObjectURL(entry.url);
  entries.delete(att);
}
