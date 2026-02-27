/**
 * Web Updater
 *
 * Handles update detection and notification for the web PWA.
 * Listens for `newRelease` events from the WebSocket connection
 * and also periodically checks GitHub releases as a fallback.
 *
 * When a new version is detected:
 *   1. Shows a non-intrusive notification banner
 *   2. User can click to reload and get the new version
 *   3. The service worker (if present) handles cache invalidation
 *
 * For Tauri desktop/mobile, the updater-bridge.js handles updates
 * via the Tauri updater plugin instead.
 */

const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/forwardemail/mail.forwardemail.net/releases/latest';
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes fallback polling
const VERSION_KEY = 'webmail_current_version';
const DISMISSED_VERSION_KEY = 'webmail_dismissed_version';

let _currentVersion = null;
let _latestVersion = null;
let _checkTimer = null;
let _onUpdateAvailable = null;
let _wsUnsubscribe = null;

/**
 * Parse a semver string into comparable parts.
 */
function parseSemver(version) {
  if (!version || typeof version !== 'string') return null;
  const clean = version.replace(/^v/, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: clean,
  };
}

/**
 * Compare two semver versions.
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

/**
 * Get the current app version from the build metadata.
 */
function getCurrentVersion() {
  if (_currentVersion) return _currentVersion;

  // Try to get version from meta tag (set during build)
  try {
    const meta = document.querySelector('meta[name="app-version"]');
    if (meta?.content) {
      _currentVersion = meta.content;
      return _currentVersion;
    }
  } catch {
    // ignore
  }

  // Try localStorage (set during previous update check)
  try {
    const stored = localStorage.getItem(VERSION_KEY);
    if (stored) {
      _currentVersion = stored;
      return _currentVersion;
    }
  } catch {
    // ignore
  }

  // Fallback: try import.meta.env
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_VERSION) {
      _currentVersion = import.meta.env.VITE_APP_VERSION;
      return _currentVersion;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Check if a version has been dismissed by the user.
 */
function isVersionDismissed(version) {
  try {
    const dismissed = localStorage.getItem(DISMISSED_VERSION_KEY);
    return dismissed === version;
  } catch {
    return false;
  }
}

/**
 * Dismiss a version (user chose to skip this update).
 */
function dismissVersion(version) {
  try {
    localStorage.setItem(DISMISSED_VERSION_KEY, version);
  } catch {
    // ignore
  }
}

/**
 * Check GitHub releases for a new version.
 */
async function checkGitHubReleases() {
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const release = await response.json();
    if (!release?.tag_name) return null;

    return {
      version: release.tag_name.replace(/^v/, ''),
      url: release.html_url,
      name: release.name || release.tag_name,
      body: release.body || '',
      publishedAt: release.published_at,
    };
  } catch {
    return null;
  }
}

/**
 * Handle a new version being detected.
 */
function handleNewVersion(releaseInfo) {
  if (!releaseInfo?.version) return;

  const current = getCurrentVersion();
  if (!current) {
    // No current version known; store this as current
    _currentVersion = releaseInfo.version;
    try {
      localStorage.setItem(VERSION_KEY, releaseInfo.version);
    } catch {
      // ignore
    }
    return;
  }

  // Check if this is actually newer than current
  if (compareSemver(releaseInfo.version, current) <= 0) return;

  // Check if already tracking a newer or equal version
  if (_latestVersion && compareSemver(releaseInfo.version, _latestVersion) <= 0) return;

  // Check if user dismissed this version
  if (isVersionDismissed(releaseInfo.version)) return;

  _latestVersion = releaseInfo.version;

  if (_onUpdateAvailable) {
    _onUpdateAvailable({
      currentVersion: current,
      newVersion: releaseInfo.version,
      releaseUrl: releaseInfo.url,
      releaseName: releaseInfo.name,
      releaseNotes: releaseInfo.body,
      publishedAt: releaseInfo.publishedAt,
    });
  }
}

/**
 * Handle WebSocket `newRelease` event.
 */
function handleWsNewRelease(data) {
  if (!data) return;

  // The WebSocket event may have different shapes
  const version = data.version || data.tag_name || data.tag;
  const url = data.url || data.html_url || '';
  const name = data.name || version || '';

  if (version) {
    handleNewVersion({
      version: version.replace(/^v/, ''),
      url,
      name,
      body: data.body || data.notes || '',
      publishedAt: data.published_at || data.publishedAt || new Date().toISOString(),
    });
  }
}

/**
 * Start the web updater.
 *
 * @param {Object} options
 * @param {Function} options.onUpdateAvailable - Callback when a new version is found
 * @param {Object} [options.wsClient] - WebSocket client instance to subscribe to newRelease events
 */
function start(options = {}) {
  _onUpdateAvailable = options.onUpdateAvailable || null;

  // Subscribe to WebSocket newRelease events
  if (options.wsClient && typeof options.wsClient.on === 'function') {
    _wsUnsubscribe = options.wsClient.on('newRelease', handleWsNewRelease);
  }

  // Initial check via GitHub releases
  checkGitHubReleases().then((release) => {
    if (release) handleNewVersion(release);
  });

  // Periodic fallback polling
  _checkTimer = setInterval(async () => {
    const release = await checkGitHubReleases();
    if (release) handleNewVersion(release);
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the web updater.
 */
function stop() {
  if (_checkTimer) {
    clearInterval(_checkTimer);
    _checkTimer = null;
  }

  if (_wsUnsubscribe) {
    _wsUnsubscribe();
    _wsUnsubscribe = null;
  }

  _onUpdateAvailable = null;
}

/**
 * Apply the update (reload the page).
 * If a service worker is registered, it will handle cache invalidation.
 */
async function applyUpdate() {
  // Store the new version so we know it after reload
  if (_latestVersion) {
    try {
      localStorage.setItem(VERSION_KEY, _latestVersion);
      localStorage.removeItem(DISMISSED_VERSION_KEY);
    } catch {
      // ignore
    }
  }

  // If service worker is available, tell it to skip waiting
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration?.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        // Wait a moment for the SW to activate
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch {
      // ignore
    }
  }

  // Hard reload to get the new version
  window.location.reload();
}

/**
 * Get the latest version info.
 */
function getLatestVersion() {
  return _latestVersion;
}

export {
  start,
  stop,
  applyUpdate,
  dismissVersion,
  getLatestVersion,
  getCurrentVersion,
  checkGitHubReleases,
  compareSemver,
  handleWsNewRelease,
};
