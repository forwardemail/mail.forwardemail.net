/**
 * Signature helper tests. Covers the plain-text path (HTML escaping, the RFC
 * delimiter, placement above existing content) and the HTML path, where the
 * stored markup is sanitized on the way out because a signature travels
 * between devices through the pairing bundle.
 */
import { describe, expect, it } from 'vitest';
import {
  signatureHtml,
  signaturePlain,
  applySignatureHtml,
  applySignaturePlain,
  isSignatureEmpty,
} from '../../src/utils/signature';

describe('signature helpers', () => {
  it('returns empty for blank signature text', () => {
    expect(signatureHtml('')).toBe('');
    expect(signatureHtml('   \n  ')).toBe('');
    expect(signaturePlain('')).toBe('');
    expect(applySignatureHtml('', '<p>hi</p>')).toBe('<p>hi</p>');
    expect(applySignaturePlain('', 'body')).toBe('body');
  });

  it('escapes HTML and converts newlines to <br>', () => {
    const html = signatureHtml('Jane <b>Doe</b>\nA & B');
    expect(html).toContain('Jane &lt;b&gt;Doe&lt;/b&gt;');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('<br>');
    expect(html).toContain('data-fe-signature="true"');
  });

  it('uses the RFC 3676 delimiter in plain text', () => {
    expect(signaturePlain('Jane\nForward Email')).toBe('-- \nJane\nForward Email');
  });

  it('places the signature above existing content with a leading blank line', () => {
    const quote = '<blockquote>original</blockquote>';
    const out = applySignatureHtml('Jane', quote);
    // Leading cursor line, then signature, then the quote.
    expect(out.startsWith('<p><br></p>')).toBe(true);
    expect(out.indexOf('Jane')).toBeLessThan(out.indexOf('blockquote'));
  });

  it('new message (no existing content) is just the cursor line + signature', () => {
    const out = applySignatureHtml('Jane', '');
    // A div, not a p: an HTML signature can hold paragraphs and lists, which
    // are illegal inside a p and would be hoisted out by the parser.
    expect(out).toBe(
      '<p><br></p><div class="fe-signature" data-fe-signature="true">-- <br>Jane</div>',
    );
  });

  it('plain-text placement keeps the signature above the quote', () => {
    const out = applySignaturePlain('Jane', 'On x, y wrote:\n> hi');
    expect(out.indexOf('-- ')).toBeLessThan(out.indexOf('> hi'));
    expect(out.startsWith('\n\n-- \nJane')).toBe(true);
  });
});

describe('HTML signatures', () => {
  it('keeps the formatting a user applied in the rich editor', () => {
    const out = signatureHtml({ html: '<p><strong>Jane</strong> Doe</p>', text: 'Jane Doe' });
    expect(out).toContain('<strong>Jane</strong>');
    expect(out).toContain('data-fe-signature="true"');
  });

  it('strips script and event handlers from stored markup', () => {
    // A signature syncs between devices through the pairing bundle, so it is
    // not trusted input just because the user typed it somewhere.
    const out = signatureHtml({ html: '<p onclick="steal()">Jane</p><script>bad()</' + 'script>' });
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('<script');
    expect(out).toContain('Jane');
  });

  it('prefers stored HTML over the plain fallback', () => {
    const out = signatureHtml({ html: '<p><em>Rich</em></p>', text: 'Plain' });
    expect(out).toContain('<em>Rich</em>');
    expect(out).not.toContain('Plain');
  });

  it('falls back to escaping the text when no HTML is stored', () => {
    // The pre-HTML storage shape, which must keep rendering exactly as before.
    const out = signatureHtml({ text: 'Jane <b>Doe</b>' });
    expect(out).toContain('Jane &lt;b&gt;Doe&lt;/b&gt;');
  });

  it('flattens HTML for plain-text mode when no text form was stored', () => {
    const out = signaturePlain({ html: '<p>Jane</p><p>Forward Email</p>' });
    expect(out).toBe('-- \nJane\nForward Email');
  });

  it('keeps link targets when flattening, since plain text cannot hold them', () => {
    const out = signaturePlain({ html: '<p><a href="https://example.com">site</a></p>' });
    expect(out).toContain('https://example.com');
  });

  it('still accepts the old bare-string form', () => {
    expect(signatureHtml('Jane')).toContain('Jane');
    expect(signaturePlain('Jane')).toBe('-- \nJane');
  });
});

describe('isSignatureEmpty', () => {
  it('treats an emptied rich editor as empty rather than prepending blank lines', () => {
    // TipTap leaves this behind when the user deletes everything.
    expect(isSignatureEmpty({ html: '<p></p>' })).toBe(true);
    expect(isSignatureEmpty({ html: '<p><br></p>' })).toBe(true);
    expect(isSignatureEmpty({ html: '', text: '   ' })).toBe(true);
    expect(isSignatureEmpty(null)).toBe(true);
  });

  it('recognizes real content in either representation', () => {
    expect(isSignatureEmpty({ html: '<p>Jane</p>' })).toBe(false);
    expect(isSignatureEmpty({ text: 'Jane' })).toBe(false);
  });

  it('does not render anything for an empty rich signature', () => {
    expect(signatureHtml({ html: '<p><br></p>' })).toBe('');
    expect(applySignatureHtml({ html: '<p></p>' }, '<p>body</p>')).toBe('<p>body</p>');
  });
});
