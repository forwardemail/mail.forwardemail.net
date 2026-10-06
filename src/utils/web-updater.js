/**
 * Web Updater
 *
 * Handles update detection for the web PWA.  Listens for `newRelease`
 * events from the WebSocket connection and periodically checks GitHub
 * releases as a fallback.
 *
 * When a new version is detected the `onUpdateAvailable` callback is
 * invoked.  The callback is responsible for orchestrating the actual
 * reload (draft-save, toast, push notification, SW cache flush, etc.)
 * so that all channels funnel through a single code-path in main.ts.
 *
 * Detection channels:
 *   1. WebSocket `newRelease` event — real-time, fastest
 *   2. GitHub releases polling — fallback every 10 minutes
 *   3. Visibility change — re-checks when the user returns to the tab
 *      after being away for at least 5 minutes
 *   4. Manual "Check for Updates" button in Settings
 *
 * Service-worker `controllerchange` / `updatefound` detection lives
 * in main.ts and also funnels through the same centralized handler.
 *
 * For Tauri desktop/mobile, updater-bridge.js handles updates via the
 * Tauri updater plugin instead.
 */

const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/forwardemail/mail.forwardemail.net/releases/latest';
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes fallback polling
const VISIBILITY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between visibility re-checks
// Last reload we triggered for a release: { version, at }. Only used to stop
// a reload loop when the server still hands out the old bundle (deploy lag,
// service worker not yet swapped). It is never treated as the running version.
const ATTEMPT_KEY = 'webmail_update_attempt';
const ATTEMPT_COOLDOWN_MS = 10 * 60 * 1000;
// Older builds stored the version they were about to reload into here and then
// read it back as the running version, so a reload that still served the old
// bundle looked up to date forever.
const LEGACY_VERSION_KEY = 'webmail_current_version';

let _currentVersion = null;
let _latestVersion = null;
let _checkTimer = null;
let _onUpdateAvailable = null;
let _wsUnsubscribe = null;
let _visibilityHandler = null;
let _lastVisibilityCheck = 0;

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
 * Get the version of the bundle that is actually running.
 *
 * This must come from the code itself. Anything persisted (localStorage) can
 * describe a version we tried to load rather than the one we got.
 */
function getCurrentVersion() {
  if (_currentVersion) return _currentVersion;

  // Test/override hook; production builds do not emit this tag.
  try {
    const meta = document.querySelector('meta[name="app-version"]');
    if (meta?.content) {
      _currentVersion = meta.content;
      return _currentVersion;
    }
  } catch {
    // ignore
  }

  try {
    const env = import.meta.env || {};
    const bundled = env.VITE_PKG_VERSION || env.VITE_APP_VERSION;
    if (bundled) {
      _currentVersion = bundled;
      return _currentVersion;
    }
  } catch {
    // ignore
  }

  return null;
}

function readAttempt() {
  try {
    const raw = localStorage.getItem(ATTEMPT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeAttempt(version) {
  try {
    localStorage.setItem(ATTEMPT_KEY, JSON.stringify({ version, at: Date.now() }));
  } catch {
    // ignore
  }
}

function clearStaleAttempt(current) {
  try {
    localStorage.removeItem(LEGACY_VERSION_KEY);
    const attempt = readAttempt();
    if (attempt?.version && compareSemver(current, attempt.version) >= 0) {
      localStorage.removeItem(ATTEMPT_KEY);
    }
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
      signal: AbortSignal.timeout(10_000),
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
 * Handle a new version being detected from any channel.
 * If the version is newer than the current one, invokes onUpdateAvailable.
 */
function handleNewVersion(releaseInfo, { force = false } = {}) {
  if (!releaseInfo?.version) return;

  const current = getCurrentVersion();
  if (!current) return;

  // Only proceed if this is strictly newer than current
  if (compareSemver(releaseInfo.version, current) <= 0) return;

  // Only proceed if this is newer than any version we've already seen
  if (!force && _latestVersion && compareSemver(releaseInfo.version, _latestVersion) <= 0) {
    return;
  }

  // We already reloaded for this release recently and still came back on the
  // old bundle. Wait out the cooldown instead of looping; a later check retries.
  // A manual check (force) always tries again.
  const attempt = readAttempt();
  if (
    !force &&
    attempt?.version === releaseInfo.version &&
    Date.now() - Number(attempt.at || 0) < ATTEMPT_COOLDOWN_MS
  ) {
    return;
  }

  _latestVersion = releaseInfo.version;
  writeAttempt(releaseInfo.version);

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
 *
 * The server sends: { event: "newRelease", release: { tagName, name, body, ... } }
 * After protocol field stripping, the handler receives: { release: { tagName, ... } }
 *
 * Also handles flattened shapes for forward-compatibility.
 */
function handleWsNewRelease(data) {
  if (!data) return;

  let version, url, name, body, publishedAt;

  if (data.release && typeof data.release === 'object') {
    const r = data.release;
    version = r.tagName || r.tag_name || r.version;
    url = r.htmlUrl || r.html_url || r.url || '';
    name = r.name || version || '';
    body = r.body || r.notes || '';
    publishedAt = r.publishedAt || r.published_at || new Date().toISOString();
  } else {
    // Flattened shape (forward-compat)
    version = data.version || data.tag_name || data.tag || data.tagName;
    url = data.url || data.html_url || data.htmlUrl || '';
    name = data.name || version || '';
    body = data.body || data.notes || '';
    publishedAt = data.published_at || data.publishedAt || new Date().toISOString();
  }

  if (version) {
    handleNewVersion({
      version: version.replace(/^v/, ''),
      url,
      name,
      body,
      publishedAt,
    });
  }
}

/**
 * Start the web updater.
 *
 * @param {Object} options
 * @param {Function} options.onUpdateAvailable - Callback when a new version is found.
 *   Receives { currentVersion, newVersion, releaseUrl, releaseName, releaseNotes, publishedAt }.
 *   The callback is responsible for orchestrating the reload (draft-save, toast, notification).
 * @param {Object} [options.wsClient] - WebSocket client instance to subscribe to newRelease events
 */
function start(options = {}) {
  // The terminal client updates through its own updater (src/cli/update.ts).
  // A reload there restarts the same code, so an update found here would be
  // announced and never arrive.
  if (globalThis.__FORWARDEMAIL_TERMINAL__ === true) return;

  _onUpdateAvailable = options.onUpdateAvailable || null;

  const current = getCurrentVersion();
  if (current) clearStaleAttempt(current);

  // Subscribe to WebSocket newRelease events if a client is provided
  if (options.wsClient && typeof options.wsClient.on === 'function') {
    _wsUnsubscribe = options.wsClient.on('newRelease', handleWsNewRelease);
  }

  // Initial check via GitHub releases (covers page load requirement)
  checkGitHubReleases().then((release) => {
    if (release) handleNewVersion(release);
  });

  // Periodic fallback polling (every 10 minutes)
  _checkTimer = setInterval(async () => {
    const release = await checkGitHubReleases();
    if (release) handleNewVersion(release);
  }, CHECK_INTERVAL_MS);

  // Re-check when the user returns to the tab after being away 5+ minutes.
  // The cooldown prevents rapid-fire checks when the user switches tabs often.
  _lastVisibilityCheck = Date.now();
  _visibilityHandler = () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - _lastVisibilityCheck < VISIBILITY_COOLDOWN_MS) return;
    _lastVisibilityCheck = now;
    checkGitHubReleases().then((release) => {
      if (release) handleNewVersion(release);
    });
  };
  document.addEventListener('visibilitychange', _visibilityHandler);
}

/**
 * Manually trigger an update check.
 * Returns { upToDate: boolean, currentVersion, latestVersion } or throws.
 */
async function checkNow() {
  const release = await checkGitHubReleases();
  const current = getCurrentVersion();
  if (release) {
    handleNewVersion(release, { force: true });
    return {
      upToDate: compareSemver(release.version, current) <= 0,
      currentVersion: current,
      latestVersion: release.version,
    };
  }
  return {
    upToDate: true,
    currentVersion: current,
    latestVersion: current,
  };
}

/**
 * Fetch the latest service worker and wait until it controls the origin.
 *
 * The precache serves index.html, so reloading while the old worker is still
 * in charge just boots the old bundle again. registration.update() resolves
 * as soon as the new script is fetched, long before its precache install has
 * finished, which is why a fixed short delay was not enough.
 *
 * Resolves true once a new worker is activated, false when there was nothing
 * new to install, it failed, or the timeout ran out.
 */
async function waitForServiceWorkerUpdate(registration, timeoutMs = 20_000) {
  const reg =
    registration ||
    (typeof navigator !== 'undefined' && navigator.serviceWorker
      ? await navigator.serviceWorker.getRegistration().catch(() => null)
      : null);
  if (!reg) return false;

  await reg.update().catch(() => {});

  const worker = reg.installing || reg.waiting;
  if (!worker) return false;

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.removeEventListener('statechange', onState);
      resolve(result);
    };
    const onState = () => {
      if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' });
      else if (worker.state === 'activated') finish(true);
      else if (worker.state === 'redundant') finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    worker.addEventListener('statechange', onState);
    onState();
  });
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

  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }

  _onUpdateAvailable = null;
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
  getLatestVersion,
  getCurrentVersion,
  checkGitHubReleases,
  checkNow,
  compareSemver,
  handleWsNewRelease,
  waitForServiceWorkerUpdate,
};
