/**
 * Forward Email – Verified Network Status
 *
 * Replaces raw `navigator.onLine` checks with a verified connectivity probe.
 * `navigator.onLine` is unreliable on Linux, corporate/VPN networks, and
 * after sleep/resume — it can report "offline" even when the network works.
 *
 * This module:
 *   1. Uses `navigator.onLine` as a fast hint only
 *   2. When the browser claims offline, probes the API with a lightweight
 *      HEAD request to verify actual connectivity
 *   3. Caches the verified result briefly (30s) to avoid hammering the server
 *   4. Exposes a reactive Svelte store (`onlineStatus`) and a synchronous
 *      helper (`isOnline()`) for use throughout the app
 *   5. Automatically re-checks on browser online/offline events and
 *      visibility changes
 */

import { writable, get } from 'svelte/store';
import { config } from '../config';

// ── Configuration ─────────────────────────────────────────────────────────
const PROBE_TIMEOUT_MS = 5000; // Max time to wait for connectivity probe
const CACHE_TTL_MS = 30_000; // Cache verified result for 30s
const RETRY_INTERVAL_MS = 15_000; // Re-check every 15s while showing offline
const PROBE_PATH = '/v1/'; // Lightweight endpoint (returns 401 or 200, either proves connectivity)

// ── State ─────────────────────────────────────────────────────────────────
let _lastProbeTime = 0;
let _lastProbeResult = true; // Optimistic default
let _probing = false;
let _retryTimer = null;

/**
 * Reactive Svelte store: true = online (verified), false = offline (verified).
 * Defaults to true (optimistic) to avoid false offline banners on startup.
 */
export const onlineStatus = writable(true);

/**
 * Synchronous helper — returns the current verified online status.
 * Use this as a drop-in replacement for `navigator.onLine`.
 */
export function isOnline() {
  return get(onlineStatus);
}

/**
 * Probe the API to verify actual connectivity.
 * Returns true if the server responds (any status), false on network error.
 */
async function probeConnectivity() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    // Use HEAD to minimize bandwidth; any response (even 401) proves connectivity
    await fetch(`${config.apiBase}${PROBE_PATH}`, {
      method: 'HEAD',
      mode: 'no-cors', // Avoid CORS preflight; opaque response still proves connectivity
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Any response (including opaque from no-cors) means we're online
    return true;
  } catch {
    // Network error, DNS failure, or abort — genuinely offline
    return false;
  }
}

/**
 * Check connectivity and update the store.
 * If `navigator.onLine` says true, trust it (it rarely lies about being online).
 * If it says false, verify with an actual probe before declaring offline.
 *
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - Skip cache and always probe
 * @returns {Promise<boolean>} Verified online status
 */
export async function checkConnectivity({ force = false } = {}) {
  // Fast path: browser says online — trust it (false positives for "online" are rare)
  if (navigator.onLine) {
    _lastProbeResult = true;
    _lastProbeTime = Date.now();
    onlineStatus.set(true);
    _stopRetryTimer();
    return true;
  }

  // Browser says offline — but don't trust it. Verify with a probe.
  const now = Date.now();
  if (!force && now - _lastProbeTime < CACHE_TTL_MS) {
    // Return cached result if recent enough
    return _lastProbeResult;
  }

  // Prevent concurrent probes
  if (_probing) return _lastProbeResult;
  _probing = true;

  try {
    const online = await probeConnectivity();
    _lastProbeResult = online;
    _lastProbeTime = Date.now();
    onlineStatus.set(online);

    if (!online) {
      _startRetryTimer();
    } else {
      _stopRetryTimer();
    }

    return online;
  } finally {
    _probing = false;
  }
}

// ── Retry timer ───────────────────────────────────────────────────────────

function _startRetryTimer() {
  if (_retryTimer) return;
  _retryTimer = setInterval(() => {
    checkConnectivity({ force: true });
  }, RETRY_INTERVAL_MS);
}

function _stopRetryTimer() {
  if (_retryTimer) {
    clearInterval(_retryTimer);
    _retryTimer = null;
  }
}

// ── Browser event listeners ───────────────────────────────────────────────

let _initialized = false;

/**
 * Initialize network status monitoring.
 * Call once during app bootstrap. Safe to call multiple times.
 */
export function initNetworkStatus() {
  if (_initialized) return;
  _initialized = true;

  // Initial check
  checkConnectivity();

  // Browser online/offline events
  window.addEventListener('online', () => {
    _lastProbeResult = true;
    _lastProbeTime = Date.now();
    onlineStatus.set(true);
    _stopRetryTimer();
  });

  window.addEventListener('offline', () => {
    // Don't immediately declare offline — verify first
    checkConnectivity({ force: true });
  });

  // Re-check on visibility change (covers resume from sleep, tab switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkConnectivity({ force: true });
    }
  });
}

/**
 * Tear down network status monitoring (for tests / HMR).
 */
export function destroyNetworkStatus() {
  _stopRetryTimer();
  _initialized = false;
  _lastProbeTime = 0;
  _lastProbeResult = true;
  _probing = false;
  onlineStatus.set(true);
}
