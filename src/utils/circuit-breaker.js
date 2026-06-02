/**
 * A tiny request circuit breaker shared by the main-thread API client
 * (remote.js) and the sync worker (sync.worker.ts).
 *
 * Each context creates its OWN instance — state is deliberately NOT shared
 * across threads; each breaker tracks the health of its own request path.
 *
 * Rationale: under a degraded environment (e.g. a struggling WKWebView whose
 * db worker fell back to the main thread) reads time out, the retry layer
 * multiplies each into more attempts, and the backend gets hammered. After a
 * burst of transient failures (timeouts / 5xx / 429) the breaker opens for a
 * cooldown, during which `isOpen()` returns true so callers can fail GETs fast
 * instead of piling on. Any backend response that isn't 5xx/429 — including a
 * 4xx like 404 — proves the backend is alive and closes the breaker.
 *
 * A 429's Retry-After (when present) sets the cooldown directly, so we honor
 * the backend's own backpressure rather than fighting it.
 *
 * @param {object} [opts]
 * @param {number} [opts.threshold=5]     consecutive failures before opening
 * @param {number} [opts.cooldownMs=8000] default open duration
 * @param {number} [opts.maxCooldownMs=60000] cap on any cooldown (incl. Retry-After)
 * @param {() => number} [opts.now] clock injection seam for tests
 */
export function createCircuitBreaker({
  threshold = 5,
  cooldownMs = 8000,
  maxCooldownMs = 60_000,
  now = () => Date.now(),
} = {}) {
  let failures = 0;
  let openUntil = 0;

  function isOpen() {
    return now() < openUntil;
  }

  function open(ms = cooldownMs) {
    openUntil = now() + Math.min(ms, maxCooldownMs);
    failures = 0;
  }

  function recordSuccess() {
    failures = 0;
  }

  // retryAfterMs > 0 (from a 429 Retry-After) opens immediately; otherwise we
  // only open once a burst crosses the threshold.
  function recordFailure(retryAfterMs = 0) {
    if (retryAfterMs > 0) {
      open(retryAfterMs);
      return;
    }
    failures += 1;
    if (failures >= threshold) open();
  }

  return { isOpen, open, recordSuccess, recordFailure };
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns 0 when absent/unparseable so callers fall back to threshold logic.
 *
 * @param {Headers|{get?: (name: string) => string | null}|string|null|undefined} headers
 *   a Headers-like object (anything with `.get`) or the raw header string.
 * @param {() => number} [now] clock injection seam for tests
 */
export function parseRetryAfterMs(headers, now = () => Date.now()) {
  try {
    const raw = typeof headers === 'string' ? headers : headers?.get?.('retry-after');
    if (!raw) return 0;
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(raw);
    return Number.isFinite(when) ? Math.max(0, when - now()) : 0;
  } catch {
    return 0;
  }
}
