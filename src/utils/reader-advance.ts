/**
 * What the reader shows once the open message is archived, deleted, moved or
 * reported as spam (Settings → Appearance → Reading → After archive, delete
 * or move). Stored as the reader_advance setting.
 *
 * - auto:  the neighbouring message, preferring an unread one. The default,
 *          and how it worked before there was a setting.
 * - below: the message under it in the list, whatever the sort order.
 * - above: the message over it.
 * - list:  no message. Full Screen goes back to the list, Classic empties the
 *          reading pane, and Classic stops opening the first message of a
 *          folder by itself, so nothing is marked read that was not chosen.
 */
export const READER_ADVANCE_OPTIONS = [
  { value: 'auto', label: 'Open the next message, unread first' },
  { value: 'below', label: 'Open the message below' },
  { value: 'above', label: 'Open the message above' },
  { value: 'list', label: 'Go back to the message list' },
] as const;

export type ReaderAdvance = (typeof READER_ADVANCE_OPTIONS)[number]['value'];

export const DEFAULT_READER_ADVANCE: ReaderAdvance = 'auto';

const KNOWN = new Set<string>(READER_ADVANCE_OPTIONS.map((option) => option.value));

export const normalizeReaderAdvance = (value: unknown): ReaderAdvance =>
  typeof value === 'string' && KNOWN.has(value) ? (value as ReaderAdvance) : DEFAULT_READER_ADVANCE;
