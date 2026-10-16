// Body text kept per message in the search index. The whole index is saved
// as one record and sent between workers in one message, so it has to stay
// well under what structured clone can carry. A mailbox of 100k messages
// with every body at this cap is still under a gigabyte.
export const MAX_INDEXED_BODY_CHARS = 10_000;

// HTML read before tags are stripped. Inline images can make a body many
// megabytes of markup with little text; reading past this gains nothing.
const MAX_HTML_SCAN_CHARS = MAX_INDEXED_BODY_CHARS * 8;

const htmlToText = (html) =>
  html
    .slice(0, MAX_HTML_SCAN_CHARS)
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const capIndexedBody = (text) =>
  text.length > MAX_INDEXED_BODY_CHARS ? text.slice(0, MAX_INDEXED_BODY_CHARS) : text;

/**
 * The text of a cached body record that goes into the search index: its
 * plain text, or the HTML body with the markup stripped when there is none,
 * cut to MAX_INDEXED_BODY_CHARS.
 */
export const indexableBodyText = (record) => {
  if (!record) return '';
  const text = typeof record.textContent === 'string' ? record.textContent.trim() : '';
  if (text) return capIndexedBody(text);
  if (typeof record.body === 'string' && record.body)
    return capIndexedBody(htmlToText(record.body));
  return '';
};
