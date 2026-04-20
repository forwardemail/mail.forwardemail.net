/**
 * Desktop Download Helper
 *
 * Resolves the correct Tauri desktop installer for the user's OS and
 * CPU architecture from the latest GitHub release, so the "Download
 * Desktop App" button in Settings > About & Help can one-click the
 * right artifact.
 *
 * Scope is deliberately limited to first-time install resolution.
 * Once the user installs a Tauri-built binary, self-updating is
 * handled by `@tauri-apps/plugin-updater` and `updater-bridge.js`,
 * pulling from the same GitHub release's `latest.json` manifest.
 *
 * This module is browser-only and has no UI dependencies.
 */

const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/forwardemail/mail.forwardemail.net/releases/latest';

const CACHE_KEY = 'webmail_desktop_release_cache';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Assets that are part of the updater pipeline but not a user-facing
 * installer — never surface these in the UI.
 */
const EXCLUDED_ASSET_PATTERNS = [
  /\.sig$/i,
  /\.tar\.gz$/i,
  /\.blockmap$/i,
  /^latest\.json$/i,
  /^sha256sums\.txt$/i,
  /checksums/i,
];

function isInstallerAsset(name) {
  if (!name) return false;
  return !EXCLUDED_ASSET_PATTERNS.some((re) => re.test(name));
}

/**
 * Read the cached release metadata from localStorage. Returns `null`
 * if missing, malformed, or stale beyond TTL (when `allowStale` is false).
 */
function readCache({ allowStale = false } = {}) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data || typeof parsed.fetchedAt !== 'number') return null;
    const age = Date.now() - parsed.fetchedAt;
    if (!allowStale && age > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch {
    // ignore quota errors — caching is best-effort
  }
}

/**
 * Fetch the latest desktop release metadata from GitHub.
 *
 * Results are cached in localStorage for 1 hour. On fetch failure,
 * returns stale cache if present; otherwise throws.
 *
 * @param {Object} [options]
 * @param {boolean} [options.forceRefresh=false] - skip the cache read
 * @returns {Promise<{tag:string, version:string, publishedAt:string, htmlUrl:string, assets:Array, fetchedAt:number}>}
 */
export async function getLatestDesktopRelease({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = readCache();
    if (cached) return cached;
  }

  let response;
  try {
    response = await fetch(GITHUB_RELEASES_URL, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const stale = readCache({ allowStale: true });
    if (stale) return stale;
    throw err;
  }

  if (!response.ok) {
    const stale = readCache({ allowStale: true });
    if (stale) return stale;
    throw new Error(`GitHub API returned ${response.status}`);
  }

  const release = await response.json();
  if (!release?.tag_name) {
    throw new Error('Invalid release payload from GitHub');
  }

  const data = {
    tag: release.tag_name,
    version: release.tag_name.replace(/^v/, '').replace(/^desktop-v/, ''),
    publishedAt: release.published_at,
    htmlUrl: release.html_url,
    assets: (release.assets || [])
      .filter((a) => isInstallerAsset(a.name))
      .map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: a.size,
        contentType: a.content_type,
      })),
    fetchedAt: Date.now(),
  };

  writeCache(data);
  return data;
}

/**
 * Detect the user's OS and CPU architecture in the browser.
 *
 * Uses `navigator.userAgentData.getHighEntropyValues()` when available
 * (Chromium) — the only reliable way to distinguish Apple Silicon from
 * Intel on macOS. Falls back to `navigator.platform` + userAgent
 * heuristics on Safari / Firefox.
 *
 * @returns {Promise<{os:'mac'|'windows'|'linux'|'unknown', arch:'x64'|'arm64'|'unknown', label:string}>}
 */
export async function detectPlatform() {
  const uaData = typeof navigator !== 'undefined' ? navigator.userAgentData : null;

  if (uaData?.getHighEntropyValues) {
    try {
      const hints = await uaData.getHighEntropyValues(['architecture', 'bitness', 'platform']);
      const os = normalizeOs(hints.platform);
      const arch = normalizeArch(hints.architecture, hints.bitness);
      return { os, arch, label: buildLabel(os, arch) };
    } catch {
      // fall through to UA heuristics
    }
  }

  // Fallback path — Safari, Firefox, or old Chromium
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const platform = typeof navigator !== 'undefined' ? navigator.platform || '' : '';

  let os = 'unknown';
  let arch = 'unknown';

  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    os = 'mac';
    // Safari on Apple Silicon reports `MacIntel` — we cannot reliably
    // distinguish here. Default to x64 and let the asset resolver
    // prefer universal/aarch64 when available.
    arch = 'x64';
  } else if (/Win/i.test(platform) || /Windows/i.test(ua)) {
    os = 'windows';
    arch = /ARM64|aarch64/i.test(ua) ? 'arm64' : 'x64';
  } else if (/Linux/i.test(platform) || /Linux/i.test(ua)) {
    os = 'linux';
    if (/aarch64|arm64/i.test(ua)) arch = 'arm64';
    else if (/x86_64|x64|amd64/i.test(ua)) arch = 'x64';
    else arch = 'x64';
  }

  return { os, arch, label: buildLabel(os, arch) };
}

function normalizeOs(platform) {
  if (!platform) return 'unknown';
  const p = platform.toLowerCase();
  if (p.includes('mac')) return 'mac';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux') || p.includes('chrome os') || p.includes('chromium')) return 'linux';
  return 'unknown';
}

function normalizeArch(architecture, bitness) {
  if (!architecture) return 'unknown';
  const a = architecture.toLowerCase();
  if (a.includes('arm')) return 'arm64';
  if (a === 'x86' && bitness === '64') return 'x64';
  if (a.includes('x86') || a.includes('amd')) return 'x64';
  return 'unknown';
}

function buildLabel(os, arch) {
  switch (os) {
    case 'mac':
      if (arch === 'arm64') return 'macOS (Apple Silicon)';
      if (arch === 'x64') return 'macOS (Intel)';
      return 'macOS';
    case 'windows':
      if (arch === 'arm64') return 'Windows (ARM64)';
      return 'Windows (64-bit)';
    case 'linux':
      if (arch === 'arm64') return 'Linux (ARM64)';
      return 'Linux (x86_64)';
    default:
      return 'your platform';
  }
}

/**
 * Ordered list of regex patterns used to pick the best installer for
 * each (os, arch) combination. The resolver tries each pattern in order
 * and returns the first matching asset.
 *
 * Name-agnostic on purpose: `tauri-action`'s default naming convention
 * has shifted between Tauri 1 and 2, so we match by arch + extension
 * rather than pinning exact filenames.
 */
const ASSET_PRIORITY = {
  mac: {
    arm64: [/aarch64.*\.dmg$/i, /arm64.*\.dmg$/i, /universal.*\.dmg$/i, /\.dmg$/i],
    x64: [/x64.*\.dmg$/i, /x86_64.*\.dmg$/i, /intel.*\.dmg$/i, /universal.*\.dmg$/i, /\.dmg$/i],
  },
  windows: {
    x64: [
      /x64.*-setup\.exe$/i,
      /x64.*_setup\.exe$/i,
      /-setup\.exe$/i,
      /_setup\.exe$/i,
      /x64.*\.msi$/i,
      /x64_.*\.msi$/i,
      /\.msi$/i,
      /\.exe$/i,
    ],
    arm64: [
      /arm64.*-setup\.exe$/i,
      /aarch64.*-setup\.exe$/i,
      /arm64.*\.msi$/i,
      /-setup\.exe$/i,
      /\.exe$/i,
    ],
  },
  linux: {
    x64: [
      /amd64.*\.AppImage$/i,
      /x86_64.*\.AppImage$/i,
      /\.AppImage$/i,
      /amd64.*\.deb$/i,
      /x86_64.*\.rpm$/i,
      /\.deb$/i,
      /\.rpm$/i,
    ],
    arm64: [
      /aarch64.*\.AppImage$/i,
      /arm64.*\.AppImage$/i,
      /aarch64.*\.deb$/i,
      /arm64.*\.deb$/i,
      /aarch64.*\.rpm$/i,
      /arm64.*\.rpm$/i,
    ],
  },
};

/**
 * Resolve the best-matching installer asset for the given platform.
 *
 * @param {Array<{name:string,url:string,size:number}>} assets
 * @param {{os:string, arch:string}} platform
 * @returns {{name:string,url:string,size:number,format:string} | null}
 */
export function resolveAssetForPlatform(assets, platform) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  if (!platform?.os || platform.os === 'unknown') return null;

  const archKey = platform.arch === 'arm64' ? 'arm64' : 'x64';
  const patterns = ASSET_PRIORITY[platform.os]?.[archKey];
  if (!patterns) return null;

  for (const pattern of patterns) {
    const match = assets.find((a) => pattern.test(a.name));
    if (match) {
      return { ...match, format: inferFormat(match.name) };
    }
  }
  return null;
}

function inferFormat(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.dmg')) return 'dmg';
  if (lower.endsWith('-setup.exe') || lower.endsWith('_setup.exe')) return 'exe';
  if (lower.endsWith('.exe')) return 'exe';
  if (lower.endsWith('.msi')) return 'msi';
  if (lower.endsWith('.appimage')) return 'AppImage';
  if (lower.endsWith('.deb')) return 'deb';
  if (lower.endsWith('.rpm')) return 'rpm';
  return 'installer';
}

/**
 * Group assets into macOS / Windows / Linux buckets for the
 * "Other platforms" disclosure in the UI.
 */
export function groupAssetsByPlatform(assets) {
  const groups = { mac: [], windows: [], linux: [] };
  if (!Array.isArray(assets)) return groups;

  for (const asset of assets) {
    const lower = asset.name.toLowerCase();
    const entry = { ...asset, format: inferFormat(asset.name) };

    if (lower.endsWith('.dmg')) {
      groups.mac.push(entry);
    } else if (lower.endsWith('.exe') || lower.endsWith('.msi')) {
      groups.windows.push(entry);
    } else if (lower.endsWith('.appimage') || lower.endsWith('.deb') || lower.endsWith('.rpm')) {
      groups.linux.push(entry);
    }
  }

  return groups;
}

/**
 * Format a byte size for display (e.g. "12.4 MB").
 */
export function formatAssetSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
