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
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

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
  out = out.replace(EMAIL_RE, (m) => `<email:${hashEmail(m)}>`);
  return out;
}
