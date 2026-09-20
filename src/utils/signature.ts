/**
 * Email signature helpers.
 *
 * A signature is stored as a pair: `html` for the rich-text editor and `text`
 * for plain-text mode. Older installs only ever stored plain text, so `html`
 * may be empty — in that case it is generated from the text, which reproduces
 * exactly what earlier versions rendered.
 *
 * Compose inserts the signature into a fresh new / reply / forward at open time
 * so the user can see and edit it, mirroring Gmail. It is NOT re-inserted when
 * a saved draft is reopened (the draft body already contains whatever was
 * composed), which avoids duplicate signatures.
 */
import { sanitizeHtml, htmlToPlainText } from './sanitize.js';

// RFC 3676 signature delimiter. Lets receiving clients recognize and collapse
// the signature when quoting a reply.
const DELIMITER = '-- ';

export interface SignatureValue {
  html?: string;
  text?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Accept either the old bare-string form or the {html, text} pair, so callers
 * that have not been updated keep working.
 */
function coerce(value: SignatureValue | string | null | undefined): SignatureValue {
  if (typeof value === 'string') return { text: value };
  return value || {};
}

/** True when the signature would render nothing. */
export function isSignatureEmpty(value: SignatureValue | string | null | undefined): boolean {
  const sig = coerce(value);
  if ((sig.text || '').trim()) return false;
  // An HTML signature of only empty paragraphs is what an emptied rich editor
  // leaves behind; treating it as content would prepend blank lines forever.
  return !htmlToPlainText(sig.html || '').trim();
}

/**
 * Render the signature as an HTML block for the rich-text editor.
 *
 * The stored HTML is sanitized on the way out rather than trusted. A signature
 * travels between devices through the pairing bundle, so treating it as safe
 * because "the user typed it" would make that a script injection path into
 * every message the user sends.
 */
export function signatureHtml(value: SignatureValue | string | null | undefined): string {
  const sig = coerce(value);
  if (isSignatureEmpty(sig)) return '';

  // The remote-image and tracking-pixel blocking that sanitizeHtml applies by
  // default is for mail the user received. This is the user's own signature,
  // so blocking its logo would be wrong; only the XSS stripping is wanted.
  const inner = (sig.html || '').trim()
    ? sanitizeHtml(sig.html || '', { blockRemoteImages: false, blockTrackingPixels: false })
        ?.html || ''
    : escapeHtml((sig.text || '').replace(/\s+$/, '')).replace(/\n/g, '<br>');
  if (!inner.trim()) return '';

  // data-fe-signature marks the block so a future feature could strip or
  // swap it; the fe-signature class is available for styling.
  return `<div class="fe-signature" data-fe-signature="true">${DELIMITER}<br>${inner}</div>`;
}

/**
 * Render the signature for plain-text mode with the standard delimiter.
 *
 * Falls back to flattening the HTML so a user who only ever wrote a rich
 * signature still gets a sensible one when composing in plain text.
 */
export function signaturePlain(value: SignatureValue | string | null | undefined): string {
  const sig = coerce(value);
  const text = (sig.text || '').trim() ? sig.text || '' : htmlToPlainText(sig.html || '');
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return '';
  return `${DELIMITER}\n${trimmed}`;
}

/**
 * Prepend the signature above any existing content (empty for a new message,
 * the quoted original for a reply/forward), leaving a blank line at the top
 * for the cursor. Returns existingContent unchanged when there's no signature.
 */
export function applySignatureHtml(
  value: SignatureValue | string | null | undefined,
  existingHtml: string,
): string {
  const sig = signatureHtml(value);
  if (!sig) return existingHtml || '';
  const lead = '<p><br></p>';
  return existingHtml ? `${lead}${sig}<p><br></p>${existingHtml}` : `${lead}${sig}`;
}

export function applySignaturePlain(
  value: SignatureValue | string | null | undefined,
  existingText: string,
): string {
  const sig = signaturePlain(value);
  if (!sig) return existingText || '';
  return existingText ? `\n\n${sig}\n\n${existingText}` : `\n\n${sig}`;
}
