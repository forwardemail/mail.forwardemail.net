import { describe, it, expect } from 'vitest';
import {
  decodeMimeHeader,
  applyInlineAttachments,
  bufferToDataUrl,
} from '../../src/utils/mime-utils.js';
import { sanitizeHtml } from '../../src/utils/sanitize.js';

describe('decodeMimeHeader', () => {
  it('returns the original value for non-string input', () => {
    expect(decodeMimeHeader(null)).toBe('');
    expect(decodeMimeHeader(undefined)).toBe('');
    expect(decodeMimeHeader('')).toBe('');
  });

  it('passes through plain ASCII unchanged', () => {
    expect(decodeMimeHeader('Hello world')).toBe('Hello world');
  });

  it('decodes Q-encoded UTF-8 tokens', () => {
    expect(decodeMimeHeader('=?UTF-8?Q?Foobar_H=C3=A4gerstr=C3=B6m?=')).toBe('Foobar Hägerström');
  });

  it('decodes B-encoded UTF-8 tokens', () => {
    // "Hello" → base64 "SGVsbG8="
    expect(decodeMimeHeader('=?UTF-8?B?SGVsbG8=?=')).toBe('Hello');
  });

  it('preserves an empty-payload encoded-word rather than dropping it', () => {
    // Previously `=?utf-8?B??=` collapsed silently to '' and erased the
    // entire header. Should now surface the raw token so the field stays
    // visible and we have telemetry instead of silent data loss.
    expect(decodeMimeHeader('=?utf-8?B??=')).toBe('=?utf-8?B??=');
    expect(decodeMimeHeader('=?UTF-8?Q??=')).toBe('=?UTF-8?Q??=');
  });

  it('does not erase surrounding plain text when an encoded-word is empty', () => {
    expect(decodeMimeHeader('Hi =?utf-8?B??= friend')).toBe('Hi =?utf-8?B??= friend');
  });
});

describe('applyInlineAttachments', () => {
  const png = 'iVBORw0KGgo=';
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

  it('resolves cid: references to the attachment data URL', () => {
    const out = applyInlineAttachments('<p><img src="cid:logo@x" alt="logo"></p>', [
      { contentId: '<logo@x>', href: `data:image/png;base64,${png}` },
    ]);
    const img = parse(out).querySelector('img');
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${png}`);
  });

  it('keeps the attribute after an unquoted cid: value', () => {
    const out = applyInlineAttachments('<p><img src=cid:logo@x alt=hi width=10></p>', [
      { contentId: '<logo@x>', href: `data:image/png;base64,${png}` },
    ]);
    const img = parse(out).querySelector('img');
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${png}`);
    expect(img.getAttribute('alt')).toBe('hi');
    expect(img.getAttribute('width')).toBe('10');
  });

  it('never lets a Content-Type from the message add markup to the sanitized HTML', () => {
    const contentType =
      'image/png"><meta http-equiv="refresh" content="0;url=https://evil.example/">';
    const html = sanitizeHtml(
      '<p><img src="cid:logo@x"><img alt="logo.png"><span style="background:url(cid:logo@x)">x</span></p>',
    ).html;
    const out = applyInlineAttachments(html, [
      {
        contentId: '<logo@x>',
        name: 'logo.png',
        href: bufferToDataUrl({ content: png, contentType }),
      },
    ]);
    const doc = parse(out);
    expect(doc.querySelector('meta')).toBeNull();
    expect(out).not.toContain('evil.example');
  });

  it('does not end an attribute that holds "src=cid:" in its text', () => {
    const html = sanitizeHtml(
      '<p><img title="src=cid:logo@x src=https://tracker.example/open.gif" alt="x"></p>',
    ).html;
    const out = applyInlineAttachments(html, [
      { contentId: '<logo@x>', href: `data:image/png;base64,${png}` },
    ]);
    const img = parse(out).querySelector('img');
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.getAttribute('title')).toContain('tracker.example');
  });

  it('does not end an attribute value that a ">" made look like the end of the tag', () => {
    const html =
      '<p><img alt="logo.png" title="x><meta http-equiv=refresh content=0;url=https://evil.example/>"></p>';
    // (unpadded base64, as the attachment bytes are the sender's choice too)
    const out = applyInlineAttachments(html, [
      { name: 'logo.png', href: 'data:image/png;base64,AAAA' },
    ]);
    const doc = parse(out);
    expect(doc.querySelector('meta')).toBeNull();
    expect(doc.querySelectorAll('img')).toHaveLength(1);
  });
});

describe('bufferToDataUrl', () => {
  it('keeps only a plain MIME type from a malformed Content-Type', () => {
    for (const contentType of ['image/png name=a.png', 'IMAGE/PNG,', 'image/png; name="a b.png"']) {
      expect(bufferToDataUrl({ content: 'AAAA', contentType })).toBe('data:image/png;base64,AAAA');
    }
    expect(bufferToDataUrl({ content: 'AAAA', contentType: '"><b>' })).toBe(
      'data:application/octet-stream;base64,AAAA',
    );
  });

  it('still resolves an inline image whose Content-Type was malformed', () => {
    const href = bufferToDataUrl({ content: 'AAAA', contentType: 'image/png name=logo.png' });
    const out = applyInlineAttachments('<img src="cid:logo@x">', [{ contentId: '<logo@x>', href }]);
    expect(out).toBe('<img src="data:image/png;base64,AAAA">');
  });
});
