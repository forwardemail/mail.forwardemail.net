/**
 * Helpers for switching a compose body between rich text and plain text.
 */

// Tags that carry formatting a plain-text conversion would throw away.
// Paragraphs, line breaks and bare spans survive the round trip through
// htmlToPlainText + plainTextToHtml, so they are not counted as a loss.
const FORMATTING_TAGS =
  /<(strong|b|em|i|u|s|mark|a|img|ul|ol|li|blockquote|pre|code|table|h[1-6])\b|<span\s[^>]*(style|class)=/i;

/**
 * True when converting this HTML to plain text would lose something the user
 * can see. Drives the confirm prompt on the composer's rich-to-plain switch:
 * a message that is only paragraphs converts silently, one with bold or links
 * asks first.
 */
export function hasRichFormatting(html: string | null | undefined): boolean {
  if (!html) return false;
  return FORMATTING_TAGS.test(String(html));
}
