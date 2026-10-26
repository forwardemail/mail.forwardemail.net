/**
 * Shared redaction module.
 *
 * Single source of truth for stripping sensitive data from log lines and
 * diagnostic strings before they are persisted to disk / sessionStorage or
 * included in feedback submissions. Mirrored by src-tauri/src/redaction.rs;
 * both implementations are validated against tests/fixtures/redaction-cases.json
 * so they cannot drift.
 */

export const REDACTION_VERSION = 1;

type Pattern = readonly [RegExp, string];

// Stage 1 — credentials. Matches the pre-existing patterns from error-logger.ts
// byte-for-byte so this refactor is a pure extraction.
const CREDENTIAL_PATTERNS: readonly Pattern[] = [
  [/\b(Basic|Bearer)\s+[A-Za-z0-9+/=_-]{8,}/gi, '$1 [REDACTED]'],
  [/\b(alias_auth|api_key|password|token|secret|credential)[=:]\s*\S+/gi, '$1=[REDACTED]'],
  [/(["']?authorization["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]'],
];

// Stage 2 — home-directory paths. Replace the user-identifying segment with `~`.
// Runs after credentials so values that happen to look like paths get wholly
// redacted first.
const PATH_PATTERNS: readonly Pattern[] = [
  [/\/(?:Users|home)\/[A-Za-z0-9._-]+/g, '~'],
  [/([A-Za-z]):\\Users\\[A-Za-z0-9._-]+/g, '$1:\\Users\\~'],
];

// Stage 3 — email addresses. Hashed with FNV-1a/32 so the same address always
// collapses to the same token within a submission (enables correlation without
// exposing the address itself). Lowercased before hashing for stability.
//
// The pattern is /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g (the one
// redaction.rs uses), but it is matched by replaceEmails below: a JS regex
// rescans the rest of the string from every start position, which took seconds
// on a 16 KB log line such as "a@" + "a.".repeat(8000). The Rust regex crate
// is linear already.

const isLocalChar = (c: number) =>
  (c >= 48 && c <= 57) || // 0-9
  (c >= 65 && c <= 90) || // A-Z
  (c >= 97 && c <= 122) || // a-z
  c === 46 || // .
  c === 95 || // _
  c === 37 || // %
  c === 43 || // +
  c === 45; // -
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDomainChar = (c: number) => isLetter(c) || (c >= 48 && c <= 57) || c === 46 || c === 45; // [A-Za-z0-9.-]
const isWordChar = (c: number) => isLetter(c) || (c >= 48 && c <= 57) || c === 95;

/**
 * End index of `[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b` matched at `from` (greedy,
 * as the regex takes it), or -1.
 */
function matchDomain(str: string, from: number): number {
  let runEnd = from;
  while (runEnd < str.length && isDomainChar(str.charCodeAt(runEnd))) runEnd++;
  // The greedy run gives back one character at a time until a "." follows
  // that starts two or more letters ending on a word boundary.
  for (let dot = runEnd - 1; dot > from; dot--) {
    if (str.charCodeAt(dot) !== 46) continue;
    let end = dot + 1;
    while (end < str.length && isLetter(str.charCodeAt(end))) end++;
    // only the full letter run can end on a boundary (a shorter one is
    // followed by another letter)
    if (end - dot - 1 >= 2 && (end >= str.length || !isWordChar(str.charCodeAt(end)))) return end;
  }
  return -1;
}

/**
 * Replace each email address, matched exactly as the pattern above matches
 * them (leftmost, non-overlapping), in linear time. Every match is anchored on
 * an "@": its local part is a run of local characters ending right before it,
 * and its domain does not depend on where the local part starts, so each "@"
 * is examined once.
 */
function replaceEmails(str: string, replace: (email: string) => string): string {
  let out = '';
  let copied = 0;
  let at = str.indexOf('@');
  while (at !== -1) {
    const domainEnd = matchDomain(str, at + 1);
    if (domainEnd !== -1) {
      let start = at;
      while (start > copied && isLocalChar(str.charCodeAt(start - 1))) start--;
      // leftmost start on a word boundary (\b)
      for (; start < at; start++) {
        const before = start > 0 && isWordChar(str.charCodeAt(start - 1));
        if (before !== isWordChar(str.charCodeAt(start))) break;
      }
      if (start < at) {
        out += str.slice(copied, start) + replace(str.slice(start, domainEnd));
        copied = domainEnd;
        at = str.indexOf('@', domainEnd);
        continue;
      }
    }
    at = str.indexOf('@', at + 1);
  }
  return copied ? out + str.slice(copied) : str;
}

/**
 * FNV-1a 32-bit hash over UTF-8 bytes of the lowercased input. Deterministic
 * and portable — the Rust port produces the identical value for the same
 * input.
 */
export function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input.toLowerCase());
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function hashEmail(email: string): string {
  return fnv1a32(email).toString(16).padStart(8, '0');
}

/**
 * Redact sensitive patterns from a string. Non-strings and empty values pass
 * through untouched, matching the semantics of the previous sanitize() helper.
 */
export function redact(input: string | undefined | null): string {
  if (!input || typeof input !== 'string') return (input as string) || '';
  let out = input;
  for (const [re, replacement] of CREDENTIAL_PATTERNS) out = out.replace(re, replacement);
  for (const [re, replacement] of PATH_PATTERNS) out = out.replace(re, replacement);
  out = replaceEmails(out, (m) => `<email:${hashEmail(m)}>`);
  return out;
}
