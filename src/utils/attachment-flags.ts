/**
 * Whether a message list row has attachments.
 *
 * List rows carry no attachments array. Synced messages say so with
 * `has_attachment` (sometimes 1 or "1" from the cache) and conversations with
 * `hasAttachment`, so the row check has to read those flags too, or the
 * paperclip never shows in the list.
 */

type Attachment = {
  contentId?: string;
  contentType?: string;
  mimeType?: string;
  type?: string;
  disposition?: 'inline' | 'attachment';
  // Callers read their own fields (filename, size, href).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

/**
 * Attachments for the download and preview section. Only purely inline
 * decorations are hidden (a CID image with inline disposition, such as a
 * signature logo); every other attachment is shown.
 */
/**
 * The two parts of a PGP/MIME envelope. The server counts them as attachments,
 * so every encrypted message would show a paperclip.
 */
export function isPgpEnvelopePart(att: Attachment): boolean {
  const type = (att.contentType || att.mimeType || att.type || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (type === 'application/pgp-encrypted') return true;
  const name = String(att.filename || att.name || '').toLowerCase();
  return name === 'encrypted.asc' && (type === 'application/octet-stream' || type === '');
}

export function filterDownloadableAttachments(atts: unknown): Attachment[] {
  if (!Array.isArray(atts)) return [];
  return atts.filter((att: Attachment) => {
    if (isPgpEnvelopePart(att)) return false;
    if (!att.contentId) return true;
    const type = (att.contentType || att.mimeType || att.type || '').toLowerCase();
    if (!type.startsWith('image/')) return true;
    return (att.disposition || '').toLowerCase() !== 'inline';
  });
}

const isSet = (value: unknown) => value === true || value === 1 || value === '1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function hasAttachments(item: any): boolean {
  if (!item) return false;
  // With the full array, leave out inline CID images such as signature logos.
  if (Array.isArray(item.attachments) && item.attachments.length) {
    return filterDownloadableAttachments(item.attachments).length > 0;
  }
  if (isSet(item.has_attachment) || isSet(item.hasAttachment)) return true;
  if (item.has_attachments) return true;
  if (item.attachment_count > 0) return true;
  if (item.latestHasAttachments) return true;
  if (Array.isArray(item.messages)) {
    return item.messages.some((m: unknown) => hasAttachments(m));
  }
  return false;
}
