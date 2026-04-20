/**
 * Normalized AI Error Codes
 *
 * Every provider adapter normalizes its native error semantics into this enum
 * before returning to the worker. Retry policy and user-facing copy key off the
 * code, not the raw HTTP status — Ollama's error shapes are very different
 * from Anthropic's.
 */

export type AIErrorCode =
  | 'rate_limited'
  | 'context_overflow'
  | 'model_unavailable'
  | 'invalid_credentials'
  | 'network_error'
  | 'malformed_tool_call'
  | 'egress_blocked'
  | 'cancelled'
  | 'unknown';

export interface AIErrorDetails {
  /** Provider-native error code or HTTP status, for logging. */
  raw_code?: string | number;
  /** Provider id this error came from, if known. */
  provider_id?: string;
  /** Wall-clock retry hint in milliseconds, if the provider told us. */
  retry_after_ms?: number;
}

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly retryable: boolean;
  readonly details: AIErrorDetails;

  constructor(code: AIErrorCode, message: string, details: AIErrorDetails = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.retryable = isRetryable(code);
    this.details = details;
  }
}

export const isRetryable = (code: AIErrorCode): boolean => {
  switch (code) {
    case 'rate_limited':
    case 'network_error':
    case 'model_unavailable':
      return true;
    case 'context_overflow':
    case 'invalid_credentials':
    case 'malformed_tool_call':
    case 'egress_blocked':
    case 'cancelled':
    case 'unknown':
      return false;
  }
};

/**
 * Default retry delay in milliseconds for a given error code. Honors
 * `details.retry_after_ms` when present. Returns `null` for non-retryable
 * codes.
 */
export const retryDelayMs = (err: AIError, attempt: number): number | null => {
  if (!err.retryable) return null;
  if (typeof err.details.retry_after_ms === 'number') {
    return err.details.retry_after_ms;
  }
  const base = err.code === 'rate_limited' ? 2000 : 500;
  return Math.min(base * 2 ** attempt, 30_000);
};

/**
 * User-facing message for an error. Short; the audit log holds the raw detail.
 */
export const userMessageFor = (err: AIError): string => {
  switch (err.code) {
    case 'rate_limited':
      return 'The AI provider is rate-limiting requests. Try again in a moment.';
    case 'context_overflow':
      return 'This request is too large for the selected model.';
    case 'model_unavailable':
      return 'The selected AI model is temporarily unavailable.';
    case 'invalid_credentials':
      return 'The API key for this provider is missing or invalid.';
    case 'network_error':
      return "Couldn't reach the AI provider. Check your connection.";
    case 'malformed_tool_call':
      return 'The AI returned an invalid response. Retrying may help.';
    case 'egress_blocked':
      return 'Local-only mode blocked this request from leaving the device.';
    case 'cancelled':
      return 'Request cancelled.';
    case 'unknown':
      return 'The AI request failed for an unknown reason.';
  }
};
