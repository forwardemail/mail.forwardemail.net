/**
 * Bodies that failed to download back off per message. Holds left by an API
 * or database outage have to lift once things work again, or the cache stays
 * empty for hours after the outage, until the app restarts.
 */
import { describe, expect, it } from 'vitest';
import {
  BODY_RECOVERY_QUIET_MS,
  BODY_RETRY_BASE_MS,
  createBodyFailureMemo,
  isTransientBodyFailure,
} from '../../src/workers/sync-pure.ts';

const A = 'support@example.com';
const httpError = (status: number) => Object.assign(new Error('Request failed'), { status });
const abortError = () => Object.assign(new Error('signal is aborted'), { name: 'AbortError' });

describe('isTransientBodyFailure', () => {
  it('treats timeouts, dropped connections, 408, 429, 5xx and db stalls as transient', () => {
    expect(isTransientBodyFailure(abortError())).toBe(true);
    expect(isTransientBodyFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientBodyFailure(httpError(408))).toBe(true);
    expect(isTransientBodyFailure(httpError(429))).toBe(true);
    expect(isTransientBodyFailure(httpError(503))).toBe(true);
    expect(
      isTransientBodyFailure(new Error('Database request "put" timed out after 60000ms')),
    ).toBe(true);
    expect(isTransientBodyFailure(new Error('Database worker reconnected'))).toBe(true);
  });

  it('treats a missing message or a parse error as the message itself', () => {
    expect(isTransientBodyFailure(httpError(404))).toBe(false);
    expect(isTransientBodyFailure(new Error('Unexpected end of MIME part'))).toBe(false);
    expect(isTransientBodyFailure(null)).toBe(false);
  });
});

describe('createBodyFailureMemo', () => {
  it('backs off a failing message with growing gaps', () => {
    const memo = createBodyFailureMemo();
    memo.note(A, 'm1', httpError(404), 0);
    expect(memo.blocked(A, 'm1', BODY_RETRY_BASE_MS - 1)).toBe(true);
    expect(memo.blocked(A, 'm1', BODY_RETRY_BASE_MS)).toBe(false);
    memo.note(A, 'm1', httpError(404), BODY_RETRY_BASE_MS);
    expect(memo.blocked(A, 'm1', BODY_RETRY_BASE_MS * 2.5)).toBe(true);
  });

  it('lifts outage holds once requests have worked for the quiet period', () => {
    const memo = createBodyFailureMemo();
    // Five failed passes during an outage, each when the last hold ran out.
    // The last one leaves a 16 minute hold.
    let t = 0;
    for (let i = 0; i < 5; i += 1) {
      if (i > 0) t += BODY_RETRY_BASE_MS * 2 ** (i - 1);
      memo.note(A, 'm1', abortError(), t);
      memo.note(A, 'gone', httpError(404), t);
    }

    // The API answers again, but too soon after the last timeout to trust.
    memo.healthy(t + BODY_RECOVERY_QUIET_MS - 1);
    expect(memo.blocked(A, 'm1', t + BODY_RECOVERY_QUIET_MS)).toBe(true);

    memo.healthy(t + BODY_RECOVERY_QUIET_MS);
    expect(memo.blocked(A, 'm1', t + BODY_RECOVERY_QUIET_MS)).toBe(false);
    // A message the server will not return keeps backing off.
    expect(memo.blocked(A, 'gone', t + BODY_RECOVERY_QUIET_MS)).toBe(true);
  });

  it('a body cached after the outage lifts the other holds too', () => {
    const memo = createBodyFailureMemo();
    // Three 503s in a row leave a four minute hold.
    memo.note(A, 'm1', httpError(503), 0);
    memo.note(A, 'm1', httpError(503), 0);
    memo.note(A, 'm1', httpError(503), 0);
    expect(memo.blocked(A, 'm1', BODY_RECOVERY_QUIET_MS)).toBe(true);
    memo.succeeded(A, 'm2', BODY_RECOVERY_QUIET_MS);
    expect(memo.blocked(A, 'm1', BODY_RECOVERY_QUIET_MS)).toBe(false);
  });

  it('keeps backing off while the API is still flapping', () => {
    const memo = createBodyFailureMemo();
    memo.note(A, 'm1', abortError(), 0);
    memo.note(A, 'm2', abortError(), 30_000);
    // A body was cached 50 s in, but only 20 s after the latest timeout.
    memo.succeeded(A, 'm3', 50_000);
    expect(memo.blocked(A, 'm1', 50_000)).toBe(true);
    expect(memo.blocked(A, 'm2', 50_000)).toBe(true);
  });
});
