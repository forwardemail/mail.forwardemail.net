/**
 * Pure builders for the feedback submission payload.
 *
 * The modal calls `buildPayload` once to render the user-visible preview,
 * then again at submit time. Output is identical for identical inputs so
 * "what you see is what gets sent" holds. Every string passes through the
 * shared `redact()` so a future bug in the send path cannot leak unredacted
 * content.
 */

import { redact } from './redaction';

export type FeedbackType = 'bug' | 'feature' | 'question' | 'other';

export interface FeedbackConsents {
  systemInfo: boolean;
  jsErrors: boolean;
  nativeLogs: boolean;
  networkErrors: boolean;
}

export interface SystemInfo {
  userAgent?: string;
  platform?: string;
  language?: string;
  screenResolution?: string;
  viewportSize?: string;
  online?: boolean;
  appVersion?: string;
  storageQuota?: { usage?: number; quota?: number; percentUsed?: string };
  serviceWorker?: { active: boolean; scope?: string };
  [k: string]: unknown;
}

export interface LogEntry {
  type?: string;
  timestamp?: string;
  message?: string;
  url?: string;
  stack?: string;
  endpoint?: string;
  reason?: string;
  [k: string]: unknown;
}

export interface FeedbackSources {
  systemInfo?: SystemInfo;
  jsErrors?: LogEntry[];
  nativeLogs?: string;
  networkErrors?: LogEntry[];
}

export interface FeedbackInputs {
  type: FeedbackType;
  subject: string;
  description: string;
  correlationId: string;
  consents: FeedbackConsents;
  sources: FeedbackSources;
}

export interface FeedbackPayload {
  correlationId: string;
  type: FeedbackType;
  subject: string;
  description: string;
  timestamp: string;
  systemInfo?: SystemInfo;
  jsErrors?: LogEntry[];
  nativeLogs?: string;
  networkErrors?: LogEntry[];
}

const REDACTABLE_LOG_FIELDS = ['message', 'url', 'stack', 'endpoint', 'reason'] as const;

function redactEntry(entry: LogEntry): LogEntry {
  const out: LogEntry = { ...entry };
  for (const field of REDACTABLE_LOG_FIELDS) {
    const value = out[field];
    if (typeof value === 'string') out[field] = redact(value);
  }
  return out;
}

/**
 * Generate a random correlation ID (`fb-` + 8 hex chars) for support to
 * cross-reference a submission. Not a user identifier — never persisted,
 * regenerated on every modal open.
 */
export function generateCorrelationId(rng?: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(4);
  if (rng) {
    rng(bytes);
  } else if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `fb-${hex}`;
}

/**
 * Build the payload that gets sent and previewed. Pure: same input → same
 * output, except for `timestamp` which the caller may inject.
 */
export function buildPayload(
  inputs: FeedbackInputs,
  now: () => string = () => new Date().toISOString(),
): FeedbackPayload {
  const { consents, sources } = inputs;
  const payload: FeedbackPayload = {
    correlationId: inputs.correlationId,
    type: inputs.type,
    subject: redact(inputs.subject),
    description: redact(inputs.description),
    timestamp: now(),
  };

  if (consents.systemInfo && sources.systemInfo) {
    payload.systemInfo = sources.systemInfo;
  }
  if (consents.jsErrors && sources.jsErrors?.length) {
    payload.jsErrors = sources.jsErrors.map(redactEntry);
  }
  if (consents.nativeLogs && sources.nativeLogs) {
    payload.nativeLogs = redact(sources.nativeLogs);
  }
  if (consents.networkErrors && sources.networkErrors?.length) {
    payload.networkErrors = sources.networkErrors.map(redactEntry);
  }

  return payload;
}

const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: 'Bug Report',
  feature: 'Feature Request',
  question: 'Question',
  other: 'Feedback',
};

/**
 * Build the email subject. Correlation ID is prefixed so support can search
 * by `fb-xxxxxxxx` to find the message regardless of how the user describes it.
 */
export function buildEmailSubject(payload: FeedbackPayload, userSubject?: string): string {
  const label = TYPE_LABELS[payload.type] ?? 'Feedback';
  const suffix = (userSubject?.trim() || payload.description.trim()).slice(0, 60);
  return `[${payload.correlationId}] Webmail ${label}: ${suffix}`;
}

/**
 * Render the payload as a human-readable email body for support@. The same
 * structured data is included so support can copy/paste fields without
 * re-parsing the prose.
 */
export function buildEmailBody(payload: FeedbackPayload): string {
  const lines: string[] = [];
  lines.push('Webmail Feedback Submission');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');
  lines.push(`Reference: ${payload.correlationId}`);
  lines.push(`Type: ${payload.type.toUpperCase()}`);
  lines.push(`Submitted: ${payload.timestamp}`);
  lines.push('');
  if (payload.subject) {
    lines.push(`Subject: ${payload.subject}`);
    lines.push('');
  }
  lines.push('Description:');
  lines.push(payload.description);
  lines.push('');

  if (payload.systemInfo) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('System Information');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(JSON.stringify(payload.systemInfo, null, 2));
    lines.push('');
  }
  if (payload.networkErrors?.length) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`Network Errors (${payload.networkErrors.length})`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(payload.networkErrors.map((e) => JSON.stringify(e)).join('\n'));
    lines.push('');
  }
  if (payload.jsErrors?.length) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`JS Errors (${payload.jsErrors.length})`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(payload.jsErrors.map((e) => JSON.stringify(e)).join('\n'));
    lines.push('');
  }
  if (payload.nativeLogs) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('Native Log Tail');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(payload.nativeLogs);
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('End of Report');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  return lines.join('\n');
}
