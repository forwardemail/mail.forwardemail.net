/**
 * Helpers for switching a compose body between rich text and plain text.
 */

import { Extension } from '@tiptap/core';

/**
 * Each paragraph of the editor takes its direction from its own text, so a
 * line in Arabic or Hebrew is written right to left next to one in English,
 * and reads the same way for the recipient. A direction the message already
 * had is kept.
 */
export const TextDirection = Extension.create({
  name: 'textDirection',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          dir: {
            default: 'auto',
            parseHTML: (element: HTMLElement) => {
              const dir = element.getAttribute('dir')?.toLowerCase();
              return dir === 'ltr' || dir === 'rtl' ? dir : 'auto';
            },
            renderHTML: (attributes: { dir?: string }) => ({ dir: attributes.dir || 'auto' }),
          },
        },
      },
    ];
  },
});

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
