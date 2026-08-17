import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';

// Mirrors the exact DOMPurify config used by Compose.svelte's RawHtmlQuote
// node view when rendering forwarded/quoted email HTML into the compose
// preview. A <style> block left in place can carry @font-face/@import rules
// pointing at external hosts (e.g. Gmail calendar invites embed
// fonts.gstatic.com for "Google Sans"), which the compose window's CSP
// blocks — surfacing as a font-src violation. Forbidding style/script here
// closes that off while leaving inline style="..." attributes intact.
const sanitize = (html: string) => DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script'] });

describe('RawHtmlQuote sanitize config', () => {
  it('strips a <style> block containing @font-face pointing at an external host', () => {
    const html =
      '<p>Hello</p>' +
      '<style>@font-face{font-family:"Google Sans";src:url(https://fonts.gstatic.com/s/googlesans/font.woff2)}</style>' +
      '<p>World</p>';
    const out = sanitize(html);
    expect(out).not.toMatch(/style/i);
    expect(out).not.toMatch(/fonts\.gstatic\.com/);
    expect(out).toContain('Hello');
    expect(out).toContain('World');
  });

  it('strips a <style> block containing @import', () => {
    const html =
      '<style>@import url(https://fonts.googleapis.com/css?family=Roboto);</style><p>x</p>';
    const out = sanitize(html);
    expect(out).not.toMatch(/@import/);
    expect(out).not.toMatch(/googleapis\.com/);
  });

  it('preserves inline style attributes on ordinary elements', () => {
    const html = '<p style="color:red;font-weight:bold">Styled text</p>';
    const out = sanitize(html);
    expect(out).toContain('style="color:red;font-weight:bold"');
    expect(out).toContain('Styled text');
  });

  it('preserves ordinary safe formatting', () => {
    const html = '<p><b>Bold</b> and <a href="https://example.com">a link</a></p>';
    const out = sanitize(html);
    expect(out).toContain('<b>Bold</b>');
    expect(out).toContain('<a href="https://example.com">a link</a>');
  });

  it('strips inline <script> tags', () => {
    const html = '<p>Hi</p><script>alert(1)</script>';
    const out = sanitize(html);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/alert/);
  });
});
