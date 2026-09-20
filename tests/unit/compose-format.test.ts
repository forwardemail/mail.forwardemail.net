/**
 * The composer's rich-to-plain switch is lossy, so it confirms first — but only
 * when there is something to lose. A prompt on every plain paragraph would be
 * noise, and no prompt on a formatted reply would be a silent data loss.
 */
import { describe, expect, it } from 'vitest';
import { hasRichFormatting } from '../../src/utils/compose-format';

describe('hasRichFormatting', () => {
  it('ignores structure that survives the plain-text round trip', () => {
    // htmlToPlainText turns these into newlines and plainTextToHtml turns the
    // newlines back into paragraphs, so nothing the user sees is lost.
    expect(hasRichFormatting('<p>Hello</p><p>there</p>')).toBe(false);
    expect(hasRichFormatting('Hello<br>there')).toBe(false);
    expect(hasRichFormatting('<div>Hello</div>')).toBe(false);
    expect(hasRichFormatting('<p><br></p>')).toBe(false);
  });

  it('flags inline formatting that plain text cannot represent', () => {
    expect(hasRichFormatting('<p><strong>Hi</strong></p>')).toBe(true);
    expect(hasRichFormatting('<p><em>Hi</em></p>')).toBe(true);
    expect(hasRichFormatting('<p><u>Hi</u></p>')).toBe(true);
    expect(hasRichFormatting('<p><mark>Hi</mark></p>')).toBe(true);
  });

  it('flags links and images, whose targets only survive as text', () => {
    expect(hasRichFormatting('<p><a href="https://example.com">site</a></p>')).toBe(true);
    expect(hasRichFormatting('<p><img src="cid:x" alt="chart"></p>')).toBe(true);
  });

  it('flags block structure that plain text flattens', () => {
    expect(hasRichFormatting('<ul><li>one</li></ul>')).toBe(true);
    expect(hasRichFormatting('<ol><li>one</li></ol>')).toBe(true);
    expect(hasRichFormatting('<blockquote>quoted</blockquote>')).toBe(true);
    expect(hasRichFormatting('<table><tr><td>a</td></tr></table>')).toBe(true);
    expect(hasRichFormatting('<h2>Heading</h2>')).toBe(true);
  });

  it('flags a styled span but not a bare one', () => {
    // TipTap wraps color and font choices in a styled span; an unstyled span
    // carries nothing a plain-text body would miss.
    expect(hasRichFormatting('<p><span style="color:#f00">Hi</span></p>')).toBe(true);
    expect(hasRichFormatting('<p><span>Hi</span></p>')).toBe(false);
  });

  it('does not confuse a tag name with a word in the body text', () => {
    // A naive /b|i|u/ check would fire on ordinary prose.
    expect(hasRichFormatting('<p>a bold idea about tables</p>')).toBe(false);
    expect(hasRichFormatting('<p>brunch at 5</p>')).toBe(false);
  });

  it('treats empty input as nothing to lose', () => {
    expect(hasRichFormatting('')).toBe(false);
    expect(hasRichFormatting(null)).toBe(false);
    expect(hasRichFormatting(undefined)).toBe(false);
  });
});
