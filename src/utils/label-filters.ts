const RESERVED_FLAGS = new Set(
  [
    'NonJunk',
    'Junk',
    'NotJunk',
    '$NotJunk',
    '$MDNSent',
    '\\Seen',
    '\\Flagged',
    '\\Answered',
    '\\Draft',
    '\\Drafts',
    '\\Trash',
    '\\Junk',
    '\\Sent',
    '\\Inbox',
    '\\Archive',
    '$Forwarded',
  ].map((f) => f.toLowerCase()),
);

const HIDDEN_PATTERNS: RegExp[] = [
  /^\$label\d+$/i,
  /^\$maillabel\d+$/i,
  /^\$mailflagbit\d+$/i,
  /^\d+$/i,
  /^calendar$/i,
  /^purge_issue$/i,
  /^purge-issue$/i,
  /^purge issue$/i,
  /^enterprise$/i,
  /^webmail$/i,
  /^notjunk$/i,
  /^\$notjunk$/i,
  // Structural keyword-object keys that leak through when IMAP returns
  // `keywords: { data: true, type: true, ... }` rather than a label list.
  /^data$/i,
  /^type$/i,
  /^content$/i,
  /^size$/i,
  /^flags$/i,
  /^uid$/i,
  /^id$/i,
];

/**
 * Returns true if a label name is a system/internal flag that should never
 * be surfaced to the user — either in per-message badges or the label picker.
 */
export function isHiddenLabel(flag: unknown): boolean {
  const key = String(flag ?? '').trim();
  if (!key) return true;
  if (/^\[\s*\]$/.test(key)) return true;
  const lower = key.toLowerCase();
  if (RESERVED_FLAGS.has(lower)) return true;
  if (key.startsWith('\\') || key.startsWith('$')) return true;
  return HIDDEN_PATTERNS.some((re) => re.test(key));
}
