/**
 * Email <style> handling.
 *
 * Email templates ship their own responsive stylesheet. A builder writes
 * `min-width: 720px` inline for Outlook and overrides it from an
 * `@media (max-width: 480px)` block in <style>. Stripping <style> left only
 * the desktop half, so desktop-width email overflowed on a phone and the
 * reader measured a 720px-wide layout. These tests cover keeping the sheet
 * without reopening the things it can smuggle.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeHtml, sanitizeEmailCss, restoreBlockedImages } from '../../src/utils/sanitize.js';

const unblocked = { blockRemoteImages: false, blockTrackingPixels: false };

describe('sanitizeEmailCss', () => {
  it('keeps the media query that makes a template responsive', () => {
    const { css } = sanitizeEmailCss(
      '@media (max-width:480px){.u-col{min-width:320px !important;max-width:100% !important}}',
    );
    expect(css).toContain('@media (max-width:480px)');
    expect(css).toContain('min-width:320px !important');
  });

  it('strips the </style> breakout sequence', () => {
    // The only way a <style> body escapes back into markup once re-serialized.
    const { css } = sanitizeEmailCss('a{}</style><img src=x onerror=alert(1)>');
    expect(css).not.toContain('</style');
    expect(css).not.toContain('</');
  });

  it('keeps the child combinator, which also uses >', () => {
    const { css } = sanitizeEmailCss('.row > .col{color:red}');
    expect(css).toContain('.row > .col');
  });

  it('drops @import', () => {
    const { css } = sanitizeEmailCss('@import url("https://evil.test/x.css"); a{padding:4px}');
    expect(css).not.toMatch(/@import/i);
    expect(css).toContain('a{padding:4px}');
  });

  it('strips comments so they cannot hide an at-rule from these checks', () => {
    const { css } = sanitizeEmailCss('/* @import url(https://evil.test/x.css); */ a{color:red}');
    expect(css).not.toMatch(/@import/i);
    expect(css).not.toContain('/*');
  });

  it('neutralizes position: fixed', () => {
    // It leaves the flow, so it adds nothing to the height we measure and can
    // leave an invisible layer sitting over the whole message.
    const { css } = sanitizeEmailCss('.overlay{position:fixed;top:0;left:0}');
    expect(css).not.toMatch(/position\s*:\s*fixed/i);
    expect(css).toMatch(/position:\s*static/i);
  });

  it('leaves remote url() alone when image blocking is off', () => {
    const { css, blockedCount } = sanitizeEmailCss(
      '.a{background-image:url(https://cdn.test/a.png)}',
      {
        blockRemoteUrls: false,
      },
    );
    expect(css).toContain('url(https://cdn.test/a.png)');
    expect(blockedCount).toBe(0);
  });

  it('neutralizes remote url() when image blocking is on', () => {
    const { css, blockedCount } = sanitizeEmailCss(
      '.a{background-image:url(https://cdn.test/a.png)}',
      {
        blockRemoteUrls: true,
      },
    );
    expect(css).not.toContain('url(https://cdn.test/a.png)');
    expect(css).toContain('none');
    expect(blockedCount).toBe(1);
  });

  it('refuses to mark a url that could close the marker comment early', () => {
    const { css, blockedCount } = sanitizeEmailCss(
      '.a{background-image:url(https://x.test/a*/b.png)}',
      {
        blockRemoteUrls: true,
      },
    );
    expect(css).not.toContain('fe-blocked-url');
    expect(css).toContain('none');
    expect(blockedCount).toBe(0);
  });
});

describe('sanitizeHtml with <style>', () => {
  it('keeps the stylesheet instead of discarding it', () => {
    const input =
      '<style>@media (max-width:480px){.u-col{min-width:320px !important}}</style>' +
      '<div class="u-col" style="max-width:320px;min-width:720px">hi</div>';
    const { html } = sanitizeHtml(input, unblocked);
    expect(html).toContain('<style>');
    expect(html).toContain('@media (max-width:480px)');
    // The inline Outlook width is still there for the media query to override.
    expect(html).toContain('min-width:720px');
  });

  it('still removes script alongside the style it now keeps', () => {
    const { html } = sanitizeHtml('<style>a{}</style><script>alert(1)</script><p>x</p>', unblocked);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('counts CSS backgrounds toward the blocked-image banner', () => {
    const input = '<style>.hero{background-image:url(https://cdn.test/hero.png)}</style>';
    const result = sanitizeHtml(input, { blockRemoteImages: true, blockTrackingPixels: false });
    expect(result.blockedRemoteImageCount).toBe(1);
    expect(result.hasBlockedImages).toBe(true);
    // The URL survives inside a CSS comment so unblocking can put it back,
    // exactly as data-original-src does for a blocked <img>. What must not
    // survive is a live url() the engine would actually fetch.
    expect(result.html).not.toMatch(/url\(\s*['"]?https:\/\/cdn\.test/);
    expect(result.html).toContain('none');
  });

  it('does not leak blocking state from one call into the next', () => {
    sanitizeHtml('<style>.a{background-image:url(https://cdn.test/a.png)}</style>', {
      blockRemoteImages: true,
      blockTrackingPixels: false,
    });
    const second = sanitizeHtml(
      '<style>.b{background-image:url(https://cdn.test/b.png)}</style>',
      unblocked,
    );
    expect(second.blockedRemoteImageCount).toBe(0);
    expect(second.html).toContain('url(https://cdn.test/b.png)');
  });

  it('unblocking restores CSS backgrounds, not just img tags', () => {
    const input = '<style>.hero{background-image:url(https://cdn.test/hero.png)}</style>';
    const { html } = sanitizeHtml(input, { blockRemoteImages: true, blockTrackingPixels: false });
    const restored = restoreBlockedImages(html, { includeTrackingPixels: false });
    expect(restored).toContain('url("https://cdn.test/hero.png")');
    expect(restored).not.toContain('fe-blocked-url');
  });
});

describe('the Unlayer shape that broke on mobile', () => {
  // A builder writes the desktop width inline (for Outlook) and overrides it
  // from a media query in <head>. Keeping only the inline half is what made a
  // 720px template overflow a 390px phone and report a 720px-wide height.
  const email = [
    '<html><head><style>',
    '@media (max-width:480px){.u-col{min-width:320px !important;max-width:100% !important}}',
    '</style></head><body>',
    '<div class="u-col" style="max-width:320px;min-width:720px">',
    '<img src="https://cdn.test/hero.png" width="720" height="1136">',
    '</div></body></html>',
  ].join('');

  it('keeps a stylesheet declared in <head>, where templates actually put it', () => {
    // <head> is where the parser puts <style>, and DOMPurify returns only
    // <body> — so this survives only because sanitizeHtml hands it a node.
    const { html } = sanitizeHtml(email, unblocked);
    expect(html).toContain('@media (max-width:480px)');
    expect(html).toContain('min-width:320px !important');
  });

  it('keeps the inline desktop width the media query has to override', () => {
    const { html } = sanitizeHtml(email, unblocked);
    expect(html).toContain('min-width:720px');
    // Both halves present is the whole point: at 390px the sheet wins on
    // specificity (!important beats a non-important inline declaration).
    expect(html.indexOf('@media')).toBeLessThan(html.indexOf('min-width:720px'));
  });

  it('still strips script from the same document', () => {
    const { html } = sanitizeHtml(
      email.replace('</body>', '<script>alert(1)</script></body>'),
      unblocked,
    );
    expect(html).not.toContain('<script');
  });
});

describe('the stylesheet cannot override the reader theme', () => {
  // email-iframe.js already strips these three from inline styles. Before
  // <style> was kept, a sheet could not reintroduce them; now it could, and an
  // !important rule can out-specify the theme's own forcing.
  it('strips color declarations, including !important ones', () => {
    const { css } = sanitizeEmailCss('.a{color:#fff !important;font-size:20px}');
    expect(css).not.toMatch(/(^|[;{])\s*color\s*:/);
    expect(css).toContain('font-size:20px');
  });

  it('strips background and background-color', () => {
    const { css } = sanitizeEmailCss('.a{background:#fff;background-color:red;padding:4px}');
    expect(css).not.toMatch(/(^|[;{])\s*background(-color)?\s*:/);
    expect(css).toContain('padding:4px');
  });

  it('leaves border-color alone despite the substring', () => {
    const { css } = sanitizeEmailCss('.a{border-color:red}');
    expect(css).toContain('border-color:red');
  });

  it('leaves background-image alone, so hero art still renders', () => {
    const { css } = sanitizeEmailCss('.a{background-image:url(https://cdn.test/hero.png)}');
    expect(css).toContain('background-image:url(https://cdn.test/hero.png)');
  });

  it('keeps the layout rules that are the reason for allowing <style>', () => {
    const { css } = sanitizeEmailCss(
      '@media (max-width:480px){.u-col{min-width:320px !important;max-width:100% !important;color:red}}',
    );
    expect(css).toContain('min-width:320px !important');
    expect(css).toContain('max-width:100% !important');
    expect(css).not.toMatch(/(^|[;{])\s*color\s*:/);
  });
});
