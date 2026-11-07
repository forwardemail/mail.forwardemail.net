/**
 * The composer's rich-to-plain switch is lossy, so it confirms first — but only
 * when there is something to lose. A prompt on every plain paragraph would be
 * noise, and no prompt on a formatted reply would be a silent data loss.
 */
import { describe, expect, it } from 'vitest';
import { hasRichFormatting, TextDirection } from '../../src/utils/compose-format';

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

// <https://github.com/forwardemail/forwardemail.net/issues/485>
describe('TextDirection', () => {
  const render = async (content: string) => {
    const { Editor } = await import('@tiptap/core');
    const { default: StarterKit } = await import('@tiptap/starter-kit');
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, TextDirection],
      content,
    });
    const html = editor.getHTML();
    editor.destroy();
    return html;
  };

  it('lets each paragraph take its direction from its text', async () => {
    const html = await render('<p>Hello</p><p>مرحبا بالعالم</p><h2>Title</h2>');
    expect(html).toBe(
      '<p dir="auto">Hello</p><p dir="auto">مرحبا بالعالم</p><h2 dir="auto">Title</h2>',
    );
  });

  it('keeps a direction the message already had', async () => {
    const html = await render('<p dir="rtl">שלום</p><p dir="LTR">Hi</p><p dir="bogus">x</p>');
    expect(html).toBe('<p dir="rtl">שלום</p><p dir="ltr">Hi</p><p dir="auto">x</p>');
  });
});
