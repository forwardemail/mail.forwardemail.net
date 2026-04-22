/**
 * Markdown renderer for AI output.
 *
 * Claude writes in markdown — headings, lists, code fences, bold/italic.
 * Before this module the panel rendered raw text in a <pre>, so the reader
 * saw `**important**` literally. Fixed: marked → DOMPurify → innerHTML.
 *
 * Security posture: the model's output is NOT upstream-attacker controlled
 * in the same way an email body is, but we still sanitize because:
 *   - The model can echo attacker-supplied content (e.g., a hostile email
 *     the model summarizes).
 *   - A future `render_raw_html` tool could sneak through.
 * DOMPurify with the default config strips script tags, event handlers,
 * javascript: URLs — the standard XSS mitigations.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

export const renderMarkdownSafe = (source: string): string => {
  if (!source) return '';
  const html = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'code',
      'pre',
      'blockquote',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'a',
      'del',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
    ],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
    // Be strict about links — only http/https.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
};
