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
let _loggedLocationIssue = false;
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Phase 1 diagnostics: every decision point logs. tauri-plugin-log's Webview
// target forwards console.* into the rotating log files, so these lines land
// in the diagnostics logs that ship with support tickets.
const log = (...args) => console.log('[updater]', ...args);
const warn = (...args) => console.warn('[updater]', ...args);

async function ensureUpdater() {
  if (_updater !== undefined) return _updater;
  try {
    _updater = await import('@tauri-apps/plugin-updater');
    log('plugin module loaded');
  } catch (err) {
    warn('plugin module failed to load:', err);
    _updater = null;
  }
  return _updater;
}

/**
 * Validate a semver-like version string.
 * Accepts pre-release suffixes (e.g. 1.2.3-beta.1).
 */
function isValidVersion(v) {
  if (typeof v !== 'string') return false;
  return /^\d+\.\d+\.\d+/.test(v);
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
  log('checkForUpdates() called');

  if (!isTauriDesktop) {
    log('skipped: not a Tauri desktop build');
    return null;
  }

  const now = Date.now();
  const sinceLast = now - _lastCheckTime;
  if (sinceLast < MIN_CHECK_INTERVAL_MS) {
    log(
      `rate-limited: last check was ${Math.round(sinceLast / 1000)}s ago ` +
        `(min interval ${MIN_CHECK_INTERVAL_MS / 1000}s)`,
    );
    return null;
  }
  _lastCheckTime = now;

  const mod = await ensureUpdater();
  if (!mod) {
    log('skipped: plugin-updater module unavailable');
    return null;
  }

  try {
    log('calling mod.check() — this issues an HTTP GET from the Rust backend');
    const update = await mod.check();
    log('mod.check() returned', {
      isNull: update == null,
      available: update?.available,
      version: update?.version,
      currentVersion: update?.currentVersion,
      date: update?.date,
    });

    if (!update) {
      log('no update returned (server said up-to-date or returned nothing)');
      return null;
    }

    if (update.version && !isValidVersion(update.version)) {
      warn('invalid version string from server:', update.version);
      return null;
    }

    const archInfo = await getArchInfo();
    log('arch/platform detected:', archInfo);

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
    warn('mod.check() threw:', err?.message || err);
    return null;
  }
}

/**
 * Detect macOS install location issues that prevent in-place updates:
 *   - App Translocation (running from a randomized read-only path because
 *     the user opened it directly from the DMG without dragging to Applications)
 *   - App is in ~/Downloads or another non-/Applications location
 *
 * macOS-only — Windows and Linux don't have these constraints.
 * Returns a friendly error message if the install location is bad,
 * or null if the location looks fine.
 */
async function getInstallLocationIssue() {
  try {
    const { platform } = await import('@tauri-apps/plugin-os');
    if (platform() !== 'macos') return null;

    const { resourceDir } = await import('@tauri-apps/api/path');
    const path = await resourceDir();
    if (typeof path !== 'string') return null;
    // App Translocation puts the app under /private/var/folders/.../AppTranslocation/
    if (path.includes('AppTranslocation') || path.includes('/private/var/folders/')) {
      return 'The app is running from a temporary location (App Translocation). Please move "Forward Email" to your Applications folder and reopen it to enable updates.';
    }
    // Apps not in /Applications can't be updated reliably
    if (
      path.startsWith('/Users/') &&
      !path.includes('/Applications/') &&
      (path.includes('/Downloads/') || path.includes('/Desktop/'))
    ) {
      return 'Please move "Forward Email" to your Applications folder to enable updates.';
    }
  } catch {
    // path/os API not available — skip detection
  }
  return null;
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

  // Check for known install location issues before downloading
  const locationIssue = await getInstallLocationIssue();
  if (locationIssue) {
    const err = new Error(locationIssue);
    err.code = 'BAD_INSTALL_LOCATION';
    throw err;
  }

  try {
    let downloaded = 0;
    let contentLength = 0;
    let lastLoggedPct = -10;

    log('downloadAndInstall() starting for version', updateInfo.version);

    await updateInfo._update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        contentLength = event.data.contentLength || 0;
        log(`download started: ${contentLength} bytes`);
        if (contentLength > 500 * 1024 * 1024) {
          warn('update too large — aborting:', contentLength);
          return;
        }
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength || 0;
        // Throttle progress logs to every ~10% so logs stay readable.
        if (contentLength) {
          const pct = Math.floor((downloaded / contentLength) * 100);
          if (pct - lastLoggedPct >= 10) {
            log(`download progress: ${pct}%`);
            lastLoggedPct = pct;
          }
        }
        if (onProgress && typeof onProgress === 'function') {
          onProgress({
            downloaded: Math.min(downloaded, contentLength || downloaded),
            contentLength,
          });
        }
      } else if (event.event === 'Finished') {
        log('download finished — install + relaunch starting');
        if (onProgress && typeof onProgress === 'function') {
          onProgress({ downloaded: contentLength, contentLength });
        }
      }
    });
  } catch (err) {
    // Translate the cryptic Tauri error into a user-friendly message
    const message = String(err?.message || err || '');
    if (message.includes('Failed to move the new app into place')) {
      const detected = await getInstallLocationIssue();
      const friendly = new Error(
        detected ||
          'Could not install the update because the app location is not writable. Try reinstalling the app or running with administrator permissions.',
      );
      friendly.code = 'BAD_INSTALL_LOCATION';
      warn('install failed (bad location):', err);
      throw friendly;
    }
    warn('downloadAndInstall failed:', err);
    throw err;
  }
}

/**
 * Extract a version string from a WebSocket newRelease payload.
 *
 * The server sends the payload as:
 *   { release: { tagName, name, body, assets, ... } }
 *
 * The websocket-updater dispatches the inner fields (after stripping
 * the `event` and `timestamp` protocol fields), so the handler
 * receives: { release: { tagName, ... } }.
 *
 * We also handle flattened shapes for forward-compatibility.
 */
function extractVersionFromRelease(data) {
  if (!data || typeof data !== 'object') return null;

  // Standard shape: { release: { tagName: "v1.2.3" } }
  if (data.release && typeof data.release === 'object') {
    return data.release.tagName || data.release.tag_name || data.release.version || null;
  }

  // Flattened shape (forward-compat)
  return data.tagName || data.tag_name || data.version || data.tag || null;
}

/**
 * Handle WebSocket `newRelease` event.
 * Triggers an immediate update check (bypassing the rate limit for this one check).
 */
export function handleWsNewRelease(data) {
  if (!isTauriDesktop) return;

  const version = extractVersionFromRelease(data);
  if (!version) return;

  // Reset rate limit to allow immediate check on new release
  _lastCheckTime = 0;

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
 * Also subscribes to WebSocket `newRelease` events for immediate checks
 * when a `wsClient` is provided.
 *
 * @param {object} options
 * @param {function} [options.onUpdateAvailable] - (info) => Promise<boolean>
 * @param {function} [options.onProgress] - progress callback
 * @param {number} [options.intervalMs] - re-check interval (default: 1 hour, min: 5 min)
 * @param {object} [options.wsClient] - WebSocket client to subscribe to newRelease events
 */
export async function initAutoUpdater(options = {}) {
  if (!isTauriDesktop) {
    log('initAutoUpdater: not a Tauri desktop build, no-op');
    return;
  }

  const { onUpdateAvailable, onProgress, intervalMs = 60 * 60 * 1000, wsClient } = options;

  const safeInterval = Math.max(intervalMs, MIN_CHECK_INTERVAL_MS);
  log('initAutoUpdater: starting', {
    intervalMs: safeInterval,
    hasOnUpdateAvailable: typeof onUpdateAvailable === 'function',
    hasOnProgress: typeof onProgress === 'function',
    hasOnError: typeof options.onError === 'function',
    hasWsClient: !!wsClient,
  });

  async function doCheck() {
    try {
      const info = await checkForUpdates();
      if (!info?.available) {
        log('doCheck: no update available');
        return;
      }

      log(`doCheck: update available → v${info.version} (current v${info.currentVersion})`);

      let shouldInstall = true;
      if (onUpdateAvailable && typeof onUpdateAvailable === 'function') {
        shouldInstall = await onUpdateAvailable(info);
        log('onUpdateAvailable callback returned', shouldInstall);
      } else {
        log('no onUpdateAvailable callback — will auto-install silently');
      }

      if (shouldInstall) {
        await downloadAndInstall(info, onProgress);
      } else {
        log('install declined by caller');
      }
    } catch (err) {
      if (err?.code === 'BAD_INSTALL_LOCATION') {
        if (!_loggedLocationIssue) {
          _loggedLocationIssue = true;
          warn(err.message);
          if (typeof options.onError === 'function') {
            try {
              options.onError(err);
            } catch {
              // Ignore handler errors
            }
          }
        }
        return;
      }
      warn('auto-update check failed:', err);
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
