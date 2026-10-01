import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Updates for the terminal client.
 *
 * Standalone binaries replace themselves with the matching asset of the
 * latest GitHub release (gzipped), after checking it against the release's
 * SHA256SUMS.txt. npm installs update through npm. A background check runs
 * at most once a day on launch; binaries apply what it finds and report it
 * when the session ends, npm installs report that an update is available.
 */

export const REPOSITORY = 'forwardemail/mail.forwardemail.net';
export const PACKAGE = 'forwardemail';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'forwardemail-cli';

export type InstallKind = 'binary' | 'npm' | 'source';

export interface Release {
  version: string;
  tag: string;
  url: string;
  assets: Array<{ name: string; url: string }>;
}

export interface UpdateState {
  checkedAt?: number;
  latest?: string;
  applied?: string;
}

export function isStandaloneBinary(): boolean {
  try {
    // node:sea exists in every Node that can build this binary.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return Boolean(require('node:sea').isSea());
  } catch {
    return false;
  }
}

export function detectInstall(): InstallKind {
  if (isStandaloneBinary()) return 'binary';
  const script = process.argv[1] ?? '';
  return script.split(path.sep).includes('node_modules') ? 'npm' : 'source';
}

/** The executable built for this OS and CPU, as named on a release (plus .gz). */
export function assetName(platform = process.platform, arch = process.arch): string {
  const os = platform === 'win32' ? 'win' : platform;
  return `forwardemail-${os}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

function parseVersion(version: string) {
  const [core, pre = ''] = version.replace(/^v/, '').split('-', 2);
  const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return { parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre };
}

/** Semver precedence: 1 when a is newer, -1 when older, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i] > y.parts[i] ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Release> {
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Could not check for updates (GitHub responded ${response.status})`);
  }
  const body = (await response.json()) as {
    tag_name: string;
    html_url: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };
  return {
    tag: body.tag_name,
    version: body.tag_name.replace(/^v/, ''),
    url: body.html_url,
    assets: (body.assets ?? []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
    })),
  };
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

async function download(url: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
    signal,
  });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Downloads this platform's binary from a release, verifies its checksum and
 * swaps it in for the running executable. The running process keeps its
 * open copy; the new version starts next time.
 */
export async function installBinary(
  release: Release,
  options: { target?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = options.target ?? process.execPath;
  const name = `${assetName()}.gz`;
  const asset = release.assets.find((item) => item.name === name);
  const sumsAsset = release.assets.find((item) => item.name === 'SHA256SUMS.txt');
  if (!asset) throw new Error(`Release ${release.tag} has no ${name} yet`);
  if (!sumsAsset) throw new Error(`Release ${release.tag} has no SHA256SUMS.txt yet`);

  const expected = parseChecksums(
    (await download(sumsAsset.url, fetchImpl, options.signal)).toString('utf8'),
  ).get(name);
  if (!expected) throw new Error(`SHA256SUMS.txt in ${release.tag} does not list ${name}`);

  const compressed = await download(asset.url, fetchImpl, options.signal);
  const actual = createHash('sha256').update(compressed).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  const binary = gunzipSync(compressed);

  const dir = path.dirname(target);
  const staged = path.join(dir, `.${path.basename(target)}.${process.pid}.new`);
  try {
    fs.writeFileSync(staged, binary, { mode: 0o755 });
    if (process.platform === 'win32') {
      // A running .exe cannot be replaced, but it can be renamed.
      // A previous .old may still be running (another window); then this one
      // gets its own name, and cleanupPreviousBinary() leaves it for later.
      let old = `${target}.old`;
      try {
        fs.rmSync(old, { force: true });
      } catch {
        old = `${target}.${process.pid}.old`;
      }
      fs.renameSync(target, old);
      try {
        fs.renameSync(staged, target);
      } catch (error) {
        fs.renameSync(old, target);
        throw error;
      }
    } else {
      fs.renameSync(staged, target);
    }
  } catch (error) {
    fs.rmSync(staged, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `No permission to replace ${target}. Run the installer again (with sudo if it was installed system-wide).`,
      );
    }
    throw error;
  }
  return release.version;
}

/** Removes the copy a Windows update left behind. */
export function cleanupPreviousBinary(target = process.execPath) {
  if (process.platform !== 'win32') return;
  try {
    fs.rmSync(`${target}.old`, { force: true });
  } catch {
    // still in use by an old process; next time
  }
}

export function updateWithNpm(): Promise<number> {
  const windows = process.platform === 'win32';
  return new Promise((resolve) => {
    const child = spawn(windows ? 'npm.cmd' : 'npm', ['install', '--global', `${PACKAGE}@latest`], {
      stdio: 'inherit',
      // npm is a .cmd script on Windows, which spawn only runs through a shell.
      shell: windows,
    });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export function readState(file: string): UpdateState {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as UpdateState;
  } catch {
    return {};
  }
}

export function writeState(file: string, state: UpdateState) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // an update check is best-effort
  }
}

/**
 * The launch-time check. Returns a line to print when the session ends, or
 * null. Never throws: a failed check just waits for the next launch.
 */
export async function backgroundUpdate(options: {
  version: string;
  stateFile: string;
  install?: InstallKind;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const now = options.now ?? Date.now();
  const install = options.install ?? detectInstall();
  const state = readState(options.stateFile);
  if (state.checkedAt && now - state.checkedAt < CHECK_INTERVAL_MS) {
    return install === 'npm' && state.latest && compareVersions(state.latest, options.version) > 0
      ? npmNotice(options.version, state.latest)
      : null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    timer.unref?.();
    const release = await fetchLatestRelease(options.fetchImpl, controller.signal);
    writeState(options.stateFile, { ...state, checkedAt: now, latest: release.version });
    if (compareVersions(release.version, options.version) <= 0) return null;

    if (install === 'binary') {
      await installBinary(release, { fetchImpl: options.fetchImpl, signal: controller.signal });
      clearTimeout(timer);
      writeState(options.stateFile, {
        checkedAt: now,
        latest: release.version,
        applied: release.version,
      });
      return `Forward Email was updated to ${release.version}; it takes effect the next time you start it.`;
    }
    clearTimeout(timer);
    return install === 'npm' ? npmNotice(options.version, release.version) : null;
  } catch {
    return null;
  }
}

function npmNotice(current: string, latest: string) {
  return `Forward Email ${latest} is available (you have ${current}). Update with: forwardemail update`;
}
