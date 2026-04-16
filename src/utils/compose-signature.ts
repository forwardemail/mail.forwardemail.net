/**
 * Signature injection/swap helpers for the compose editor.
 *
 * The signature is wrapped in a <div data-signature-id="..."> marker so it
 * can be located and swapped in place without disturbing user-typed content.
 * On replies/forwards it sits between the cursor area and the quoted block
 * (identified by TipTap's RawHtmlQuote: `<blockquote data-raw-html="...">`).
 */

import DOMPurify from 'dompurify';
import { SIGNATURE_MARKER_ATTR } from '../types/userContent';
import type { Signature } from '../types/userContent';

export function buildSignatureBlock(signature: Signature): string {
  const safeBody = DOMPurify.sanitize(signature.body || '');
  return `<div ${SIGNATURE_MARKER_ATTR}="${signature.id}" data-signature-block="true">${safeBody}</div>`;
}

/**
 * Insert the signature into an HTML string.
 *
 * - If an existing quoted block (`blockquote[data-raw-html]`) is present,
 *   the signature is inserted immediately before it.
 * - Otherwise, the signature is appended at the end of the HTML.
 *
 * A leading blank paragraph is prepended if the html is empty so the user
 * has a place to type above the signature.
 */
export function injectSignatureIntoHtml(html: string, signature: Signature | null): string {
  const base = html || '';
  if (!signature) return base;
  const sigBlock = buildSignatureBlock(signature);

  // If a quoted block is present, insert before it
  const quoteMatch = /<blockquote[^>]*data-raw-html=/i.exec(base);
  if (quoteMatch) {
    const before = base.slice(0, quoteMatch.index);
    const after = base.slice(quoteMatch.index);
    const separator = before.trim() ? '' : '<p></p>';
    return `${before}${separator}${sigBlock}${after}`;
  }

  // No quote — append with a leading paragraph if empty
  const lead = base.trim() ? '' : '<p></p>';
  return `${lead}${base}${sigBlock}`;
}

/**
 * Remove any signature block(s) from an HTML string.
 * Used when saving a draft as a template or when clearing the signature.
 */
export function stripSignatureFromHtml(html: string): string {
  if (!html) return '';
  return html.replace(/<div[^>]*data-signature-block="true"[^>]*>[\s\S]*?<\/div>/gi, '');
}

/**
 * Remove TipTap RawHtmlQuote blocks (quoted reply content) from an HTML string.
 * Used when saving a draft as a template so only the user's own body is kept.
 */
export function stripQuotedBlocksFromHtml(html: string): string {
  if (!html) return '';
  return html.replace(/<blockquote[^>]*data-raw-html=[^>]*>[\s\S]*?<\/blockquote>/gi, '');
}

/**
 * Swap the current signature block in the given editor with the provided
 * signature (or remove it if `signature` is null). Preserves all other content.
 *
 * Operates on the DOM via the editor's commands.setContent after string
 * manipulation on the current HTML — safer than trying to surgically patch
 * the ProseMirror document.
 */
export function swapSignatureInEditor(
  editor: { getHTML: () => string; commands: { setContent: (html: string) => void } } | null,
  signature: Signature | null,
): void {
  if (!editor) return;
  const current = editor.getHTML();
  const stripped = stripSignatureFromHtml(current);
  const next = signature ? injectSignatureIntoHtml(stripped, signature) : stripped;
  editor.commands.setContent(next);
}
