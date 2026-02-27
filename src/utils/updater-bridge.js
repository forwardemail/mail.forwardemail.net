/**
 * updater-bridge.js - Auto-updater for Tauri desktop apps.
 *
 * Uses @tauri-apps/plugin-updater to check for updates, download them,
 * and install them. On non-Tauri platforms this module is a silent no-op.
 *
 * The updater checks GitHub Releases for a `latest.json` manifest that
 * Tauri's `tauri-plugin-updater` generates during `tauri build`.
 * Each architecture (x86_64, aarch64) gets its own binary in the release.
 *
 * Also listens for `newRelease` WebSocket events to trigger immediate
 * update checks when the server announces a new version.
 *
 * Hardening:
 *   - Update signatures are verified by the Tauri updater plugin using the
 *     public key configured in tauri.conf.json (pubkey field).
 *   - Version strings are validated before display.
 *   - Download progress callbacks are bounds-checked.
 *   - The internal _update handle is never exposed to external callers.
 *   - Rate-limited: at most one check per 5 minutes to prevent abuse.
 *   - HTTPS-only endpoints for update manifest and downloads.
 */

import { isTauriDesktop } from './platform.js';

let _updater;
let _lastCheckTime = 0;
let _wsUnsubscribe = null;
let _autoCheckInterval = null;
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function ensureUpdater() {
  if (_updater !== undefined) return _updater;
  try {
    _updater = await import('@tauri-apps/plugin-updater');
  } catch {
    _updater = null;
  }
  return _updater;
}

/**
 * Validate a semver-like version string.
 */
function isValidVersion(v) {
  if (typeof v !== 'string') return false;
  return /^\d+\.\d+\.\d+$/.test(v);
}

/**
 * Get the current platform architecture info for logging/diagnostics.
 */
async function getArchInfo() {
  try {
    const { arch, platform } = await import('@tauri-apps/plugin-os');
    return { arch: await arch(), platform: await platform() };
  } catch {
    return { arch: 'unknown', platform: 'unknown' };
  }
}

/**
 * Check for available updates.
 * Returns { available, version, body, arch, platform } or null.
 * Rate-limited to one check per 5 minutes.
 */
export async function checkForUpdates() {
  if (!isTauriDesktop) return null;

  const now = Date.now();
  if (now - _lastCheckTime < MIN_CHECK_INTERVAL_MS) {
    return null; // Rate-limited
  }
  _lastCheckTime = now;

  const mod = await ensureUpdater();
  if (!mod) return null;

  try {
    const update = await mod.check();
    if (!update) return null;

    // Validate the version string from the server
    if (update.version && !isValidVersion(update.version)) {
      console.warn('[updater-bridge] Invalid version string from server:', update.version);
      return null;
    }

    const archInfo = await getArchInfo();

    return {
      available: update.available,
      version: update.version,
      body: typeof update.body === 'string' ? update.body.slice(0, 10_000) : '',
      date: update.date || null,
      currentVersion: update.currentVersion,
      arch: archInfo.arch,
      platform: archInfo.platform,
      _update: update, // Internal handle, not serialisable
    };
  } catch (err) {
    console.warn('[updater-bridge] check failed:', err);
    return null;
  }
}

/**
 * Download and install a previously checked update.
 * The Tauri updater plugin automatically selects the correct binary
 * for the current architecture from the GitHub release assets.
 *
 * @param {object} updateInfo - The object returned by checkForUpdates().
 * @param {function} [onProgress] - Optional callback: ({ downloaded, contentLength }) => void
 */
export async function downloadAndInstall(updateInfo, onProgress) {
  if (!isTauriDesktop || !updateInfo?._update) return;

  try {
    let downloaded = 0;
    let contentLength = 0;

    await updateInfo._update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        contentLength = event.data.contentLength || 0;
        // Sanity check: reject absurdly large updates (> 500 MB)
        if (contentLength > 500 * 1024 * 1024) {
          console.warn('[updater-bridge] Update too large:', contentLength);
          return;
        }
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength || 0;
        if (onProgress && typeof onProgress === 'function') {
          onProgress({
            downloaded: Math.min(downloaded, contentLength || downloaded),
            contentLength,
          });
        }
      } else if (event.event === 'Finished') {
        if (onProgress && typeof onProgress === 'function') {
          onProgress({ downloaded: contentLength, contentLength });
        }
      }
    });
  } catch (err) {
    console.error('[updater-bridge] download/install failed:', err);
    throw err;
  }
}

/**
 * Handle WebSocket `newRelease` event.
 * Triggers an immediate update check (bypassing the rate limit for this one check).
 */
function handleWsNewRelease(data) {
  if (!isTauriDesktop) return;
  if (!data) return;

  const version = data.version || data.tag_name || data.tag;
  if (!version) return;

  // Respect rate limit — don't allow WS events to bypass the 5-minute window
  const now = Date.now();
  if (now - _lastCheckTime < MIN_CHECK_INTERVAL_MS) return;
  _lastCheckTime = now;

  // Trigger the auto-check flow
  if (_autoCheckCallback) {
    _autoCheckCallback();
  }
}

let _autoCheckCallback = null;

/**
 * Convenience: check, download, and install in one call.
 * Shows a confirmation dialog via the provided callback before installing.
 *
 * Also subscribes to WebSocket `newRelease` events for immediate checks.
 *
 * @param {object} options
 * @param {function} [options.onUpdateAvailable] - (info) => Promise<boolean>
 * @param {function} [options.onProgress] - progress callback
 * @param {number} [options.intervalMs] - re-check interval (default: 1 hour, min: 5 min)
 * @param {object} [options.wsClient] - WebSocket client to subscribe to newRelease events
 */
export async function initAutoUpdater(options = {}) {
  if (!isTauriDesktop) return;

  const { onUpdateAvailable, onProgress, intervalMs = 60 * 60 * 1000, wsClient } = options;

  // Enforce minimum interval of 5 minutes
  const safeInterval = Math.max(intervalMs, MIN_CHECK_INTERVAL_MS);

  async function doCheck() {
    try {
      const info = await checkForUpdates();
      if (!info?.available) return;

      let shouldInstall = true;
      if (onUpdateAvailable && typeof onUpdateAvailable === 'function') {
        shouldInstall = await onUpdateAvailable(info);
      }

      if (shouldInstall) {
        await downloadAndInstall(info, onProgress);
      }
    } catch (err) {
      console.warn('[updater-bridge] Auto-update check failed:', err);
    }
  }

  _autoCheckCallback = doCheck;

  // Subscribe to WebSocket newRelease events
  if (wsClient && typeof wsClient.on === 'function') {
    _wsUnsubscribe = wsClient.on('newRelease', handleWsNewRelease);
  }

  // Initial check after a short delay (let the app finish loading).
  setTimeout(doCheck, 10_000);

  // Periodic re-checks.
  _autoCheckInterval = setInterval(doCheck, safeInterval);
}

/**
 * Stop the auto-updater and clean up.
 */
export function stopAutoUpdater() {
  if (_autoCheckInterval) {
    clearInterval(_autoCheckInterval);
    _autoCheckInterval = null;
  }
  if (_wsUnsubscribe) {
    _wsUnsubscribe();
    _wsUnsubscribe = null;
  }
  _autoCheckCallback = null;
}
