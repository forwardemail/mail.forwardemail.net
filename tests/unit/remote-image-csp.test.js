/**
 * "Block remote images" must hold for every way an email can reference one.
 *
 * The sanitizer rewrites <img src>, but srcset, inline style url(), the legacy
 * background attribute and video posters were left alone and the reader's CSP
 * allowed any https/http image, so a sender could still see the message open.
 * The reader document now carries `img-src data: blob:` while images are
 * blocked, and loading images lifts it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/storage', () => ({
  Local: { get: vi.fn(() => null), set: vi.fn() },
}));

import {
  sanitizeHtml,
  restoreBlockedImages,
  REMOTE_IMAGES_BLOCKED_MARKER,
} from '../../src/utils/sanitize.js';
import { buildIframeSrcdoc } from '../../src/utils/iframe-srcdoc';

const cspOf = (doc) => doc.match(/Content-Security-Policy" content="([^"]+)"/)[1];

describe('remote image blocking in the reader', () => {
  it('locks img-src to local sources while remote images are blocked', () => {
    const { html } = sanitizeHtml('<p>Hi</p><img src="https://t.example/p.png" width="300">', {
      blockRemoteImages: true,
      blockTrackingPixels: true,
    });
    const csp = cspOf(buildIframeSrcdoc(html));
    expect(csp).toContain('img-src data: blob:;');
    expect(csp).not.toMatch(/img-src[^;]*https:/);
    expect(csp).toContain('font-src data:;');
  });

  it('offers "load images" for references the <img src> rewrite cannot see', () => {
    for (const body of [
      '<img srcset="https://t.example/a.png 2x" alt="a">',
      '<table background="https://t.example/bg.png"><tr><td>x</td></tr></table>',
      '<div style="background-image:url(https://t.example/bg.png)">x</div>',
    ]) {
      const result = sanitizeHtml(body, { blockRemoteImages: true, blockTrackingPixels: true });
      expect(result.hasBlockedImages, body).toBe(true);
      expect(result.html).toContain(REMOTE_IMAGES_BLOCKED_MARKER);
    }
  });

  it('lifts the restriction once the user loads images', () => {
    const { html } = sanitizeHtml('<img src="https://t.example/p.png" width="300">', {
      blockRemoteImages: true,
      blockTrackingPixels: true,
    });
    const restored = restoreBlockedImages(html);
    expect(restored).not.toContain(REMOTE_IMAGES_BLOCKED_MARKER);
    expect(restored).toContain('src="https://t.example/p.png"');
    expect(cspOf(buildIframeSrcdoc(restored))).toMatch(/img-src data: https: http:/);
  });

  it('leaves the CSP permissive when the user allows remote images', () => {
    const { html } = sanitizeHtml('<img src="https://t.example/p.png">', {
      blockRemoteImages: false,
      blockTrackingPixels: false,
    });
    expect(html).not.toContain(REMOTE_IMAGES_BLOCKED_MARKER);
    expect(cspOf(buildIframeSrcdoc(html))).toMatch(/img-src data: https: http:/);
  });

  it('never lets email markup submit forms or rebase links', () => {
    const csp = cspOf(buildIframeSrcdoc('<p>x</p>'));
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("default-src 'none'");
  });
});
