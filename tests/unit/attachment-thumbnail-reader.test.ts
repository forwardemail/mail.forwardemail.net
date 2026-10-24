/**
 * The reader's attachment strip shows image attachments small. It set each
 * <img> to the attachment's data: URL, so every photo was decoded at full size
 * (about 48 MB for 12 megapixels) for a 104px square, twice in a thread view,
 * for as long as the message stayed open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('thumbnailSrc', () => {
  let created: string[];
  let revoked: string[];

  beforeEach(() => {
    vi.resetModules();
    created = [];
    revoked = [];
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })),
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
      callback(new Blob(['small'], { type: 'image/jpeg' }));
    });
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:thumb-${created.length + 1}`;
      created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const photo = () => ({
    name: 'photo.jpg',
    contentType: 'image/jpeg',
    href: `data:image/jpeg;base64,${btoa('pretend this is a photo')}`,
  });

  it('shows a small preview, not the attachment, and frees it when removed', async () => {
    const { thumbnailSrc } = await import('../../src/utils/attachment-thumbnail');
    const img = document.createElement('img');
    const att = photo();
    const action = thumbnailSrc(img, att);
    await flush();
    expect(img.getAttribute('src')).toBe('blob:thumb-1');
    expect(img.src.startsWith('data:')).toBe(false);

    action.destroy();
    expect(img.hasAttribute('src')).toBe(false);
    expect(revoked).toEqual(['blob:thumb-1']);
  });

  it('keeps a preview two strips share until both are gone', async () => {
    const { thumbnailSrc } = await import('../../src/utils/attachment-thumbnail');
    const att = photo();
    const first = thumbnailSrc(document.createElement('img'), att);
    const second = thumbnailSrc(document.createElement('img'), att);
    await flush();
    expect(created).toHaveLength(1);
    first.destroy();
    expect(revoked).toEqual([]);
    second.destroy();
    expect(revoked).toEqual(['blob:thumb-1']);
  });

  it('falls back to the attachment when no preview can be made', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('not an image');
      }),
    );
    const { thumbnailSrc } = await import('../../src/utils/attachment-thumbnail');
    const img = document.createElement('img');
    const att = photo();
    thumbnailSrc(img, att);
    await flush();
    expect(img.getAttribute('src')).toBe(att.href);
  });
});
