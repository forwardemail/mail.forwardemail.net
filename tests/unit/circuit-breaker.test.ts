/**
 * createCircuitBreaker() / parseRetryAfterMs() — the shared request circuit
 * breaker used by BOTH the main-thread API client (remote.js) and the sync
 * worker's raw fetch path (sync.worker.ts). It exists to stop a degraded
 * environment from turning timeouts into a backend-pounding storm, so its
 * open/close/threshold/Retry-After behavior is worth pinning exactly.
 *
 * Uses the injectable `now` seam instead of fake timers — deterministic and
 * non-flaky.
 */
import { describe, it, expect } from 'vitest';
import { createCircuitBreaker, parseRetryAfterMs } from '../../src/utils/circuit-breaker.js';

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createCircuitBreaker', () => {
  it('stays closed until the failure threshold is crossed', () => {
    const clock = makeClock();
    const cb = createCircuitBreaker({ threshold: 3, cooldownMs: 1000, now: clock.now });
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false); // 2 < 3
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true); // 3 >= 3
  });

  it('closes again once the cooldown elapses', () => {
    const clock = makeClock();
    const cb = createCircuitBreaker({ threshold: 1, cooldownMs: 1000, now: clock.now });
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    clock.advance(999);
    expect(cb.isOpen()).toBe(true);
    clock.advance(2);
    expect(cb.isOpen()).toBe(false);
  });

  it('a success resets the failure streak (transient blips do not accumulate)', () => {
    const clock = makeClock();
    const cb = createCircuitBreaker({ threshold: 3, cooldownMs: 1000, now: clock.now });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false); // only 2 since the reset
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('opens immediately on a Retry-After, ignoring the threshold, and honors its duration', () => {
    const clock = makeClock();
    const cb = createCircuitBreaker({ threshold: 5, cooldownMs: 1000, now: clock.now });
    cb.recordFailure(2000); // single 429 with Retry-After: 2s
    expect(cb.isOpen()).toBe(true);
    clock.advance(1500);
    expect(cb.isOpen()).toBe(true); // honored 2000ms, not the 1000ms default
    clock.advance(600);
    expect(cb.isOpen()).toBe(false);
  });

  it('caps any cooldown (incl. a huge Retry-After) at maxCooldownMs', () => {
    const clock = makeClock();
    const cb = createCircuitBreaker({
      threshold: 1,
      cooldownMs: 1000,
      maxCooldownMs: 5000,
      now: clock.now,
    });
    cb.recordFailure(10 * 60 * 1000); // 10 minutes
    expect(cb.isOpen()).toBe(true);
    clock.advance(5001);
    expect(cb.isOpen()).toBe(false); // capped at 5000
  });

  it('resets the streak when it opens, so re-tripping needs a fresh burst', () => {
    const clock = makeClock();
    const cb = createCircuitBreaker({ threshold: 2, cooldownMs: 1000, now: clock.now });
    cb.recordFailure();
    cb.recordFailure(); // opens
    clock.advance(1001); // closes
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure(); // only 1 failure since reopen
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('returns 0 for absent / empty', () => {
    expect(parseRetryAfterMs(null)).toBe(0);
    expect(parseRetryAfterMs(undefined)).toBe(0);
    expect(parseRetryAfterMs('')).toBe(0);
  });

  it('reads from a Headers-like object', () => {
    const headers = { get: (n: string) => (n === 'retry-after' ? '3' : null) };
    expect(parseRetryAfterMs(headers)).toBe(3000);
  });

  it('parses an HTTP-date relative to the injected now', () => {
    const now = () => 1_000_000;
    const future = new Date(1_000_000 + 4000).toUTCString();
    const ms = parseRetryAfterMs(future, now);
    // toUTCString truncates to whole seconds — allow <1s of slack.
    expect(ms).toBeGreaterThanOrEqual(3000);
    expect(ms).toBeLessThanOrEqual(4000);
  });

  it('never returns negative for a past date', () => {
    const now = () => 1_000_000;
    const past = new Date(1_000_000 - 5000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  it('returns 0 for garbage', () => {
    expect(parseRetryAfterMs('not-a-date')).toBe(0);
  });
});
