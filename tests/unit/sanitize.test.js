import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn(() => null),
    set: vi.fn(),
  },
}));

import { sanitizeHtml, restoreBlockedImages } from '../../src/utils/sanitize.js';

describe('sanitizeHtml', () => {
  it('returns empty result for falsy input', () => {
    const result = sanitizeHtml('');
    expect(result.html).toBe('');
    expect(result.hasBlockedImages).toBe(false);
    expect(result.trackingPixelCount).toBe(0);
    expect(result.blockedRemoteImageCount).toBe(0);
  });

  it('returns empty result for null', () => {
    const result = sanitizeHtml(null);
    expect(result.html).toBe('');
  });

  it('sanitizes basic HTML and preserves safe content', () => {
    const result = sanitizeHtml('<p>Hello <strong>world</strong></p>', {
      blockRemoteImages: false,
      blockTrackingPixels: false,
    });
    expect(result.html).toContain('<p>');
    expect(result.html).toContain('<strong>');
    expect(result.html).toContain('Hello');
  });

  it('strips script tags (XSS prevention)', () => {
    const result = sanitizeHtml('<p>Hi</p><script>alert("xss")</script>', {
      blockRemoteImages: false,
      blockTrackingPixels: false,
    });
    expect(result.html).not.toContain('<script>');
    expect(result.html).not.toContain('alert');
    expect(result.html).toContain('Hi');
  });

  it('strips event handlers', () => {
    const result = sanitizeHtml('<img src="x" onerror="alert(1)">', {
      blockRemoteImages: false,
      blockTrackingPixels: false,
    });
    expect(result.html).not.toContain('onerror');
  });

  it('preserves links through sanitization', () => {
    const result = sanitizeHtml('<a href="https://example.com">Link</a>', {
      blockRemoteImages: false,
      blockTrackingPixels: false,
    });
    expect(result.html).toContain('href="https://example.com"');
    expect(result.html).toContain('Link');
  });

  it('keeps data: URIs in images (inline content)', () => {
    const result = sanitizeHtml('<img src="data:image/png;base64,iVBOR">', {
      blockRemoteImages: true,
      blockTrackingPixels: true,
    });
    expect(result.html).toContain('data:image/png;base64,iVBOR');
    expect(result.hasBlockedImages).toBe(false);
  });

  describe('tracking pixel detection', () => {
    it('detects 1x1 pixel images', () => {
      const result = sanitizeHtml(
        '<img src="https://tracker.com/pixel.gif" width="1" height="1">',
        { blockRemoteImages: false, blockTrackingPixels: true },
      );
      expect(result.trackingPixelCount).toBe(1);
      expect(result.hasBlockedImages).toBe(true);
      expect(result.html).toContain('data-tracking-pixel="true"');
      expect(result.html).toContain('display: none');
    });

    it('detects small images (< 10px)', () => {
      const result = sanitizeHtml(
        '<img src="https://tracker.com/pixel.gif" width="3" height="5">',
        { blockRemoteImages: false, blockTrackingPixels: true },
      );
      expect(result.trackingPixelCount).toBe(1);
    });

    it('detects invisible images via style', () => {
      const result = sanitizeHtml(
        '<img src="https://tracker.com/pixel.gif" style="display: none">',
        { blockRemoteImages: false, blockTrackingPixels: true },
      );
      expect(result.trackingPixelCount).toBe(1);
    });

    it('detects opacity:0 as tracking pixel', () => {
      const result = sanitizeHtml('<img src="https://tracker.com/pixel.gif" style="opacity: 0">', {
        blockRemoteImages: false,
        blockTrackingPixels: true,
      });
      expect(result.trackingPixelCount).toBe(1);
    });

    it('detects visibility:hidden as tracking pixel', () => {
      const result = sanitizeHtml('<img src="https://t.com/p.gif" style="visibility: hidden">', {
        blockRemoteImages: false,
        blockTrackingPixels: true,
      });
      expect(result.trackingPixelCount).toBe(1);
    });

    it('does not flag normal-sized images as tracking pixels', () => {
      const result = sanitizeHtml(
        '<img src="https://cdn.example.com/photo.jpg" width="300" height="200">',
        { blockRemoteImages: false, blockTrackingPixels: true },
      );
      expect(result.trackingPixelCount).toBe(0);
      expect(result.hasBlockedImages).toBe(false);
    });
  });

  describe('remote image blocking', () => {
    it('blocks remote images when enabled', () => {
      const result = sanitizeHtml('<img src="https://cdn.example.com/photo.jpg" alt="Photo">', {
        blockRemoteImages: true,
        blockTrackingPixels: false,
      });
      expect(result.blockedRemoteImageCount).toBe(1);
      expect(result.hasBlockedImages).toBe(true);
      expect(result.html).toContain('data-original-src="https://cdn.example.com/photo.jpg"');
      // The original src= attribute should be removed (only data-original-src remains)
      expect(result.html).not.toMatch(/\ssrc="https:\/\/cdn\.example\.com\/photo\.jpg"/);
    });

    it('does not block images when disabled', () => {
      const result = sanitizeHtml('<img src="https://cdn.example.com/photo.jpg">', {
        blockRemoteImages: false,
        blockTrackingPixels: false,
      });
      expect(result.blockedRemoteImageCount).toBe(0);
      expect(result.hasBlockedImages).toBe(false);
    });

    it('counts tracking pixels and remote images separately', () => {
      const html = `
        <img src="https://tracker.com/pixel.gif" width="1" height="1">
        <img src="https://cdn.example.com/photo.jpg" width="400" height="300">
        <img src="https://tracker.com/beacon.png" style="opacity: 0">
      `;
      const result = sanitizeHtml(html, { blockRemoteImages: true, blockTrackingPixels: true });
      expect(result.trackingPixelCount).toBe(2);
      expect(result.blockedRemoteImageCount).toBe(1);
    });
  });
});

describe('restoreBlockedImages', () => {
  it('returns empty for falsy input', () => {
    expect(restoreBlockedImages('')).toBe('');
    expect(restoreBlockedImages(null)).toBe('');
  });

  it('restores blocked non-tracking images', () => {
    const blocked =
      '<img data-original-src="https://cdn.example.com/photo.jpg" alt="Photo" style="display: inline-block; min-width: 100px;">';
    const restored = restoreBlockedImages(blocked);
    expect(restored).toContain('src="https://cdn.example.com/photo.jpg"');
    expect(restored).not.toContain('data-original-src');
  });

  it('does not restore tracking pixels by default', () => {
    const blocked =
      '<img data-original-src="https://t.com/p.gif" data-tracking-pixel="true" style="display: none;">';
    const restored = restoreBlockedImages(blocked);
    // Should NOT restore tracking pixels — input unchanged
    expect(restored).toContain('data-tracking-pixel="true"');
    expect(restored).not.toMatch(/\ssrc="https:\/\/t\.com\/p\.gif"/);
  });

  it('restores tracking pixels when includeTrackingPixels is true', () => {
    const blocked =
      '<img data-original-src="https://t.com/p.gif" data-tracking-pixel="true" style="display: none;">';
    const restored = restoreBlockedImages(blocked, { includeTrackingPixels: true });
    expect(restored).toContain('src="https://t.com/p.gif"');
  });

  it('handles mixed blocked and unblocked images', () => {
    const html =
      '<img src="data:image/png;base64,abc"> <img data-original-src="https://cdn.example.com/img.jpg" style="min-width: 100px;">';
    const restored = restoreBlockedImages(html);
    expect(restored).toContain('data:image/png;base64,abc');
    expect(restored).toContain('src="https://cdn.example.com/img.jpg"');
  });
});
