import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn(() => null),
    set: vi.fn(),
  },
}));

import { sanitizeQuotedHtml } from '../../src/utils/sanitize.js';

// The function Compose.svelte's RawHtmlQuote node view uses to render the
// original message quoted in a reply or forward. The quote renders in the
// app's own DOM rather than the sandboxed reader iframe, so anything remote
// left in it is fetched as soon as Reply or Forward is pressed.
const sanitize = (html: string, options = {}) => sanitizeQuotedHtml(html, options);

describe('RawHtmlQuote sanitize', () => {
  it('strips a <style> block containing @font-face pointing at an external host', () => {
    const html =
      '<p>Hello</p>' +
      '<style>@font-face{font-family:"Google Sans";src:url(https://fonts.gstatic.com/s/googlesans/font.woff2)}</style>' +
      '<p>World</p>';
    const out = sanitize(html);
    expect(out).not.toMatch(/<style/i);
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
    expect(out).toContain('font-weight:bold');
    expect(out).toContain('Styled text');
  });

  it('preserves ordinary safe formatting', () => {
    const html = '<p><b>Bold</b> and <a href="https://example.com">a link</a></p>';
    const out = sanitize(html);
    expect(out).toContain('<b>Bold</b>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('a link</a>');
  });

  it('strips inline <script> tags and event handlers', () => {
    const html = '<p>Hi</p><script>alert(1)</script><img src="x" onerror="alert(1)">';
    const out = sanitize(html);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onerror/i);
  });

  it('neutralizes remote url() in inline styles (tracking via CSS)', () => {
    const html = `
      <div style="background-image:url('http://127.0.0.1:8123/compose-bg-tracker')">x</div>
      <ul><li style="list-style-image:url('http://127.0.0.1:8123/compose-list-tracker')">x</li></ul>
      <div style="border:10px solid transparent;border-image:url('http://127.0.0.1:8123/compose-border-tracker') 30">x</div>
      <div style="cursor:url(//tracker.example/c.cur), auto">x</div>
    `;
    const out = sanitize(html);
    expect(out).not.toContain('compose-bg-tracker');
    expect(out).not.toContain('compose-list-tracker');
    expect(out).not.toContain('compose-border-tracker');
    expect(out).not.toContain('tracker.example');
    // the rest of each declaration is kept
    expect(out).toContain('border:10px solid transparent');
  });

  it('keeps data: URLs in inline styles', () => {
    const html = '<div style="background-image:url(data:image/png;base64,AAAA)">x</div>';
    expect(sanitize(html)).toContain('data:image/png;base64,AAAA');
  });

  it('blocks tracking pixels by default', () => {
    const html =
      '<p>Hi</p><img src="https://tracker.example/open.gif?id=abc" width="1" height="1">';
    const out = sanitize(html);
    expect(out).not.toMatch(/\ssrc="https:\/\/tracker\.example/);
  });

  it('blocks remote images when the user blocks remote images', () => {
    const html = '<img src="http://127.0.0.1:8123/compose-img-tracker">';
    const out = sanitize(html, { blockRemoteImages: true });
    expect(out).not.toMatch(/\ssrc="http:\/\/127\.0\.0\.1:8123/);
  });

  it('drops remote srcset, background and poster references', () => {
    const html = `
      <img src="data:image/png;base64,AAAA" srcset="https://tracker.example/a.png 2x">
      <table background="https://tracker.example/bg.png"><tr><td>x</td></tr></table>
      <video poster="https://tracker.example/poster.png"></video>
      <picture><source srcset="https://tracker.example/s.webp"><img src="data:image/png;base64,AAAA"></picture>
    `;
    const out = sanitize(html);
    expect(out).not.toContain('tracker.example');
  });

  it('treats protocol-relative image sources as remote', () => {
    const out = sanitize('<img src="//tracker.example/p.png" width="300" height="200">', {
      blockRemoteImages: true,
    });
    expect(out).not.toMatch(/\ssrc="\/\/tracker\.example/);
    const pixel = sanitize('<img src="//tracker.example/p.gif" width="1" height="1">');
    expect(pixel).not.toMatch(/\ssrc="\/\/tracker\.example/);
  });

  it('removes media, embeds, frames and form images that load on their own', () => {
    const html = `
      <video src="https://tracker.example/v.mp4"></video>
      <audio src="https://tracker.example/a.mp3" autoplay></audio>
      <input type="image" src="https://tracker.example/i.png">
      <embed src="https://tracker.example/e.swf">
      <object data="https://tracker.example/o.pdf"></object>
      <iframe src="https://tracker.example/f.html"></iframe>
      <svg><image href="https://tracker.example/s.png"></image></svg>
      <p>kept</p>
    `;
    const out = sanitize(html);
    expect(out).not.toContain('tracker.example');
    expect(out).toContain('kept');
  });

  it('sees through CSS escapes and comments hiding a remote url()', () => {
    const html =
      '<div style="background:u\\72l(https://tracker.example/a.png)">x</div>' +
      '<div style="background-image:u/**/rl(https://tracker.example/b.png)">x</div>' +
      '<div style="color:red;background-image:\\75 rl(https://tracker.example/c.png)">x</div>';
    const out = sanitize(html);
    expect(out).not.toContain('tracker.example');
    expect(out).toContain('color:red');
  });

  it('drops image-set(), image() and cross-fade() with remote strings', () => {
    const html =
      '<div style="background-image:image-set(\'https://tracker.example/a.png\' 1x)">x</div>' +
      '<div style="background-image:-webkit-image-set(\'https://tracker.example/b.png\' 1x)">x</div>' +
      '<div style="background-image:cross-fade(\'https://tracker.example/c.png\', red 50%)">x</div>';
    expect(sanitize(html)).not.toContain('tracker.example');
  });

  it('is not misled by a src inside another attribute', () => {
    // a pattern-matching image rewrite finds the fake src in alt and keeps
    // the real tracker; the parsed document is not fooled
    const html = '<img alt=" src=data:x" src="https://tracker.example/p.gif" width="1" height="1">';
    expect(sanitize(html)).not.toMatch(/\ssrc="https:\/\/tracker\.example/);
  });

  it('keeps data: images and remote images the user allows', () => {
    const out = sanitize(
      '<img src="data:image/png;base64,AAAA"><img src="https://cdn.example/photo.jpg" width="300" height="200">',
      { blockRemoteImages: false },
    );
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).toContain('src="https://cdn.example/photo.jpg"');
  });

  it('returns an empty string for empty input', () => {
    expect(sanitize('')).toBe('');
  });

  // The quote is not in the sandboxed reader frame: a box taken out of the
  // flow would be drawn over the app's own interface.
  it('removes fixed, absolute and sticky positioning', () => {
    const out = sanitize(
      '<div style="position:fixed;inset:0;z-index:2147483647;color:red">Sign in again</div>' +
        '<p style="position: absolute; top: 0">a</p>' +
        '<p style="position:sticky">b</p>' +
        '<p style="position:-webkit-sticky">c</p>',
    );
    expect(out).not.toMatch(/position\s*:\s*(?:fixed|absolute|sticky|-webkit-sticky)/i);
    expect(out).toContain('color:red');
    expect(out).toContain('Sign in again');
  });

  it('sees through CSS escapes and comments hiding fixed positioning', () => {
    const out = sanitize(
      '<div style="posi\\74 ion:\\66 ixed;top:0">a</div><div style="position:/**/fixed">b</div>',
    );
    expect(out).not.toMatch(/fixed|\\66/i);
  });

  it('keeps relative positioning, which stays in the flow', () => {
    const out = sanitize('<p style="position:relative;color:blue">x</p>');
    expect(out).toContain('position:relative');
  });

  it('is not misled by a quote inside a comment', () => {
    // the browser ignores the comment, quote included, and applies the rest
    const out = sanitize(`<div style="color:red/*'*/;position:fixed;inset:0">a</div>`);
    expect(out).not.toMatch(/fixed/i);
    expect(out).toContain('color:red');
  });

  it('removes positioning it cannot resolve, such as var()', () => {
    const out = sanitize(
      '<div style="position:var(--x,fixed)">a</div>' +
        '<div style="--p:fixed;position:var(--p)">b</div>' +
        '<div style="position:inherit">c</div>',
    );
    expect(out).not.toMatch(/position\s*:/i);
  });

  it('removes forms, form controls, dialogs and popovers', () => {
    const out = sanitize(
      '<form action="https://evil.example/" method="post">' +
        '<button type="submit" formaction="https://evil.example/">View message</button>' +
        '<select name="s"><option>One</option></select><textarea name="t">Two</textarea>' +
        '</form>' +
        '<dialog open style="top:0;left:0;width:100vw;height:100vh">Sign in</dialog>' +
        '<div popover id="p">Three</div><span popovertarget="p" popovertargetaction="show">Four</span>',
    );
    expect(out).not.toMatch(/<(?:form|button|select|textarea|dialog)\b/i);
    expect(out).not.toMatch(/popover|evil\.example/i);
    for (const text of ['View message', 'One', 'Two', 'Sign in', 'Three', 'Four'])
      expect(out).toContain(text);
  });
});
