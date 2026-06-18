export const LABEL_PALETTE = [
  '#2563eb',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#0ea5e9',
  '#f97316',
];

export const pickLabelColor = (index = 0, palette = LABEL_PALETTE) => {
  if (!palette.length) return '';
  return palette[index % palette.length];
};

// Canonical form of a label keyword for matching, sending, and labelMap keying.
// MUST mirror the backend (forwardemail.net app/models/aliases.js
// `normalizeLabelKeyword` = trim + lowercase): the backend lowercases every
// message label keyword on save, so a client that keys/compares labels with
// case preserved fails to match (and hide-renders) any label containing an
// uppercase letter after a server round-trip. Canonicalize on every label
// identity boundary so "Work" (definition) and "work" (stored keyword) match.
export const canonicalizeLabelKeyword = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
