import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Updates for the terminal client.
 *
 * Standalone binaries replace themselves with the matching asset of the
 * latest GitHub release (gzipped), after checking it against the release's
 * SHA256SUMS.txt, and that file against its signature (SHA256SUMS.txt.sig)
 * by the key below and against the version it names. Installs from the npm
 * registry update through the package manager that installed them (npm, pnpm,
 * Yarn or Bun). A background check runs at most once a day on launch;
 * binaries apply what it finds and report it when the session ends, package
 * installs report that an update is available.
 */

export const REPOSITORY = 'forwardemail/mail.forwardemail.net';
export const PACKAGE = 'forwardemail';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'forwardemail-cli';

/**
 * The minisign public key release checksums are signed with: the key the
 * desktop app's updater trusts (plugins.updater.pubkey in
 * src-tauri/tauri.conf.json). A checksum only shows the download is the file
 * the release lists; the signature shows the list is ours, so a release
 * published by someone else is not installed.
 */
export const UPDATE_PUBLIC_KEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDdCRjY2OTc5RDA0RkI0MUQKUldRZHRFL1FlV24yZTV4ZThJeERhR3hTUXJRdUNqU0dRbXJrTjBjN2VycldUMXpWOG5pb3Q2SUEK';

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

/**
 * The file this copy runs from. A global install starts through a link in the
 * package manager's bin folder (/usr/local/bin/forwardemail ->
 * ../lib/node_modules/forwardemail/dist/forwardemail.cjs), and process.argv[1]
 * is the link, so the link is followed to see where the copy lives.
 */
function runningScript(script: string): string {
  try {
    return fs.realpathSync(script);
  } catch {
    return script;
  }
}

const pathParts = (file: string) => file.toLowerCase().split(/[\\/]+/);

export function detectInstall(script = process.argv[1] ?? ''): InstallKind {
  if (isStandaloneBinary()) return 'binary';
  return pathParts(runningScript(script)).includes('node_modules') ? 'npm' : 'source';
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Which package manager installed this copy, from the folder it lives in:
 * ~/.bun/install/global, pnpm's global store (…/global/…/node_modules/.pnpm/…),
 * Yarn's …/yarn/global, and npm's global node_modules otherwise. Updating
 * with a different one installs a second copy elsewhere and leaves this one,
 * the one on PATH, as it was.
 */
export function detectPackageManager(script = process.argv[1] ?? ''): PackageManager {
  const parts = pathParts(runningScript(script));
  if (parts.includes('.bun')) return 'bun';
  // Only .pnpm: an npm install under a Node that pnpm manages also has a
  // folder named pnpm in its path.
  if (parts.includes('.pnpm')) return 'pnpm';
  if (parts.includes('yarn') && parts.includes('global')) return 'yarn';
  return 'npm';
}

const GLOBAL_INSTALL: Record<PackageManager, string[]> = {
  npm: ['install', '--global', `${PACKAGE}@latest`],
  pnpm: ['add', '--global', `${PACKAGE}@latest`],
  yarn: ['global', 'add', `${PACKAGE}@latest`],
  bun: ['add', '--global', `${PACKAGE}@latest`],
};

// Where each manager puts global packages, for when its copy is not the one
// on PATH (a manager that belongs to another Node.js install).
const GLOBAL_FOLDER: Record<PackageManager, string> = {
  npm: 'npm prefix --global',
  pnpm: 'pnpm root --global',
  yarn: 'yarn global dir',
  bun: 'bun pm bin --global',
};

/** The command that updates a copy installed with `manager`. */
export function updateCommand(manager: PackageManager): string {
  return [manager, ...GLOBAL_INSTALL[manager]].join(' ');
}

/**
 * The version that `forwardemail --version` prints for the command a shell
 * finds on PATH, which is what the user runs next; null if it cannot run.
 */
export function versionOnPath(command = PACKAGE, env: NodeJS.ProcessEnv = process.env) {
  // npm and pnpm put .cmd shims on Windows, which only a shell runs. A shell
  // gets one command line: arguments next to shell: true are deprecated.
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? `"${command}" --version` : command,
    windows ? [] : ['--version'],
    {
      encoding: 'utf8',
      env,
      shell: windows,
      timeout: 30_000,
    },
  );
  if (result.status !== 0) return null;
  const line = String(result.stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .pop();
  return line && /^\d+\.\d+\.\d+/.test(line) ? line : null;
}

/** The first `name` on PATH, the way a shell looks it up, or null. */
export function findOnPath(name = PACKAGE, env: NodeJS.ProcessEnv = process.env): string | null {
  const windows = process.platform === 'win32';
  // Windows runs only these (npm's extension-less sh shim is for Git Bash).
  const extensions = windows
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const file = path.join(dir, `${name}${extension}`);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && (windows || (stat.mode & 0o111) !== 0)) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** The executable built for this OS and CPU, as named on a release (plus .gz). */
export function assetName(platform = process.platform, arch = process.arch): string {
  const os = platform === 'win32' ? 'win' : platform;
  return `forwardemail-${os}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

function parseVersion(version: string) {
  // (build metadata, after "+", does not count)
  const [core, ...pre] = version.replace(/^v/, '').replace(/\+.*$/, '').split('-');
  const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return { parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre: pre.join('-') };
}

// Prerelease identifiers ("beta.10"): numbers by value and before words,
// words in ASCII order, and fewer identifiers before more. As text,
// "beta.9" would come after "beta.10".
function comparePrerelease(a: string, b: string): number {
  const x = a.split('.');
  const y = b.split('.');
  const number = /^\d+$/;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (number.test(x[i]) !== number.test(y[i])) return number.test(x[i]) ? -1 : 1;
    const [p, q] = number.test(x[i]) ? [Number(x[i]), Number(y[i])] : [x[i], y[i]];
    if (p < q) return -1;
    if (p > q) return 1;
  }
  return Math.sign(x.length - y.length);
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
  return comparePrerelease(x.pre, y.pre);
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

// A minisign key or signature, as text (`tauri signer` writes them base64-encoded)
function minisignLines(value: string): string[] {
  const text = value.includes('untrusted comment:')
    ? value
    : Buffer.from(value.trim(), 'base64').toString('utf8');
  return text.split(/\r?\n/);
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Whether `signature` (a minisign signature file) is a signature of `data`
 * by `publicKey` (a minisign public key). Both of its signatures are checked:
 * the one of the data, and the one that covers the trusted comment.
 */
export function verifySignature(
  data: Buffer,
  signature: string,
  publicKey: string = UPDATE_PUBLIC_KEY,
): boolean {
  try {
    const key = Buffer.from(minisignLines(publicKey)[1] ?? '', 'base64');
    const [, signatureLine = '', commentLine = '', globalLine = ''] = minisignLines(signature);
    const signed = Buffer.from(signatureLine, 'base64');
    const global = Buffer.from(globalLine, 'base64');
    const prefix = 'trusted comment: ';
    if (
      key.length !== 42 ||
      key.subarray(0, 2).toString('latin1') !== 'Ed' ||
      signed.length !== 74 ||
      global.length !== 64 ||
      !commentLine.startsWith(prefix) ||
      // (signed by another key)
      !key.subarray(2, 10).equals(signed.subarray(2, 10))
    )
      return false;

    // "ED": the BLAKE2b-512 hash of the data is signed, which is what
    // `tauri signer` writes. ("Ed" signs the data itself. These two letters
    // are not signed, so with both accepted a signature of a file would
    // also pass for the 64 bytes of that file's hash.)
    if (signed.subarray(0, 2).toString('latin1') !== 'ED') return false;
    const message = createHash('blake2b512').update(data).digest();
    const publicKeyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, key.subarray(10)]),
      format: 'der',
      type: 'spki',
    });
    const dataSignature = signed.subarray(10);
    return (
      verify(null, message, publicKeyObject, dataSignature) &&
      verify(
        null,
        Buffer.concat([dataSignature, Buffer.from(commentLine.slice(prefix.length), 'utf8')]),
        publicKeyObject,
        global,
      )
    );
  } catch {
    return false;
  }
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
 * Downloads this platform's binary from a release, verifies the signature of
 * the release's checksums, that they are the checksums of that release and
 * the binary's checksum, and swaps it in for the running executable. The
 * running process keeps its open copy; the new version starts next time.
 */
export async function installBinary(
  release: Release,
  options: {
    target?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** The key the checksums must be signed with (default: ours) */
    publicKey?: string;
  } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = options.target ?? process.execPath;
  const name = `${assetName()}.gz`;
  const asset = release.assets.find((item) => item.name === name);
  const sumsAsset = release.assets.find((item) => item.name === 'SHA256SUMS.txt');
  if (!asset) throw new Error(`Release ${release.tag} has no ${name} yet`);
  const signatureAsset = release.assets.find((item) => item.name === 'SHA256SUMS.txt.sig');
  if (!sumsAsset) throw new Error(`Release ${release.tag} has no SHA256SUMS.txt yet`);
  if (!signatureAsset) throw new Error(`Release ${release.tag} has no SHA256SUMS.txt.sig yet`);

  const sums = await download(sumsAsset.url, fetchImpl, options.signal);
  const signature = await download(signatureAsset.url, fetchImpl, options.signal);
  if (!verifySignature(sums, signature.toString('utf8'), options.publicKey)) {
    throw new Error(`SHA256SUMS.txt in ${release.tag} is not signed by Forward Email`);
  }
  // The list ends with its release ("# version: 1.2.3", written by the
  // release workflow before it signs). Without this, the signed files of an
  // earlier release, attached to a later one, would install the earlier build.
  const listed = sums.toString('utf8').match(/(?:^|\n)# version: (\S+)\n?$/)?.[1];
  if (listed !== release.version) {
    throw new Error(`SHA256SUMS.txt in ${release.tag} is not the list of that release`);
  }

  const expected = parseChecksums(sums.toString('utf8')).get(name);
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

/**
 * Removes the copies Windows updates left behind: forwardemail.exe.old, and
 * forwardemail.exe.<pid>.old when .old was still running.
 */
export function cleanupPreviousBinary(target = process.execPath) {
  if (process.platform !== 'win32') return;
  const base = path.basename(target);
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(target));
  } catch {
    return;
  }
  for (const name of names) {
    if (name !== `${base}.old` && !(name.startsWith(`${base}.`) && /\.\d+\.old$/.test(name)))
      continue;
    try {
      fs.rmSync(path.join(path.dirname(target), name), { force: true });
    } catch {
      // still in use by an old process; next time
    }
  }
}

/**
 * `forwardemail update` for a copy installed from the npm registry: runs the
 * package manager that installed it, then asks the forwardemail on PATH for
 * its version, since that is what the user runs next. Resolves the exit code.
 */
export async function updatePackageInstall(options: {
  version: string;
  manager?: PackageManager;
  env?: NodeJS.ProcessEnv;
  print?: (text: string) => void;
  printError?: (text: string) => void;
  /** This copy's script (default: the one running) */
  script?: string;
}): Promise<number> {
  const manager = options.manager ?? detectPackageManager(options.script);
  const env = options.env ?? process.env;
  const print = options.print ?? ((text: string) => process.stdout.write(`${text}\n`));
  const printError = options.printError ?? ((text: string) => process.stderr.write(`${text}\n`));
  const command = updateCommand(manager);
  print(`Updating with ${manager}: ${command}`);
  const code = await updateWithPackageManager(manager, env);
  if (code !== 0) {
    printError(`forwardemail: ${command} failed (exit code ${code}).`);
    return code;
  }
  const now = versionOnPath(PACKAGE, env);
  if (now && compareVersions(now, options.version) > 0) {
    print(`Updated Forward Email ${options.version} → ${now}.`);
    return 0;
  }
  if (now === options.version) {
    print(`Forward Email ${options.version} is up to date.`);
    return 0;
  }
  const found = findOnPath(PACKAGE, env);
  if (!found) {
    // Run by its full path, or the manager's bin folder is not on PATH.
    printError(
      `forwardemail: ${manager} installed the update, but no forwardemail is on your PATH to check it. Add ${manager}'s global bin folder to PATH.`,
    );
    return 0;
  }
  if (!now) {
    printError(`forwardemail: the forwardemail on your PATH (${found}) could not be run.`);
    return 1;
  }
  if (runningScript(found) === runningScript(options.script ?? process.argv[1] ?? '')) {
    // This very copy is still old: the manager on PATH installs somewhere
    // else, e.g. it belongs to another Node.js install (nvm, fnm, Volta).
    printError(
      `forwardemail: the forwardemail on your PATH (${found}) is still ${now}; ${manager} installed the update into another folder. See where with: ${GLOBAL_FOLDER[manager]}`,
    );
    return 1;
  }
  printError(
    `forwardemail: the forwardemail on your PATH (${found}) is ${now}, another copy that comes before the one ${manager} updated. Update or remove it.`,
  );
  return 1;
}

/** Runs the package manager's global update for this copy; resolves its exit code. */
export function updateWithPackageManager(
  manager: PackageManager = detectPackageManager(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const windows = process.platform === 'win32';
  return new Promise((resolve) => {
    // The managers are .cmd scripts on Windows, which spawn only runs
    // through a shell, as one command line.
    const child = spawn(
      windows ? updateCommand(manager) : manager,
      windows ? [] : GLOBAL_INSTALL[manager],
      { stdio: 'inherit', env, shell: windows },
    );
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
  publicKey?: string;
}): Promise<string | null> {
  const now = options.now ?? Date.now();
  const install = options.install ?? detectInstall();
  const state = readState(options.stateFile);
  if (state.checkedAt && now - state.checkedAt < CHECK_INTERVAL_MS) {
    // A binary that applied the update starts as the new version, so a newer
    // `latest` here means it is still waiting to be installed.
    return install !== 'source' &&
      state.latest &&
      compareVersions(state.latest, options.version) > 0
      ? availableNotice(options.version, state.latest)
      : null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  timer.unref?.();
  try {
    let release: Release;
    try {
      release = await fetchLatestRelease(options.fetchImpl, controller.signal);
    } catch {
      // Offline or GitHub unreachable: try again next launch.
      return null;
    }
    writeState(options.stateFile, { ...state, checkedAt: now, latest: release.version });
    if (compareVersions(release.version, options.version) <= 0) return null;

    if (install === 'binary') {
      try {
        await installBinary(release, {
          fetchImpl: options.fetchImpl,
          signal: controller.signal,
          publicKey: options.publicKey,
        });
      } catch (error) {
        // Say so rather than stay on the old version without a word (an
        // executable installed system-wide cannot be replaced, for one).
        return `${availableNotice(options.version, release.version)} (installing it failed: ${(error as Error).message})`;
      }
      writeState(options.stateFile, {
        checkedAt: now,
        latest: release.version,
        applied: release.version,
      });
      return `Forward Email was updated to ${release.version}; it takes effect the next time you start it.`;
    }
    return install === 'npm' ? availableNotice(options.version, release.version) : null;
  } finally {
    clearTimeout(timer);
  }
}

function availableNotice(current: string, latest: string) {
  return `Forward Email ${latest} is available (you have ${current}). Update with: forwardemail update`;
}

export interface UpdateCheck {
  upToDate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  message: string;
}

/**
 * Settings' "Check for Updates" in the terminal client. A binary installs the
 * release now (it takes effect at the next start, like the launch check); a
 * package install is told the command; a source checkout to pull. Never
 * reloads the app: the code running now stays what it is until a restart.
 */
export async function checkForTerminalUpdate(options: {
  version: string;
  stateFile?: string;
  install?: InstallKind;
  fetchImpl?: typeof fetch;
  target?: string;
  publicKey?: string;
}): Promise<UpdateCheck> {
  const install = options.install ?? detectInstall();
  const current = options.version;
  let release: Release;
  try {
    release = await fetchLatestRelease(options.fetchImpl, AbortSignal.timeout(30_000));
  } catch {
    return {
      upToDate: false,
      currentVersion: current,
      latestVersion: null,
      message: 'Could not check for updates',
    };
  }
  const applied = options.stateFile ? readState(options.stateFile).applied : undefined;
  if (options.stateFile) {
    writeState(options.stateFile, {
      ...readState(options.stateFile),
      checkedAt: Date.now(),
      latest: release.version,
    });
  }
  const latest = release.version;
  if (compareVersions(latest, current) <= 0) {
    return {
      upToDate: true,
      currentVersion: current,
      latestVersion: latest,
      message: `You're on the latest version (v${current})`,
    };
  }
  const result = { upToDate: false, currentVersion: current, latestVersion: latest };
  // Already installed this session (the launch check or an earlier click).
  if (install === 'binary' && applied === latest) {
    return {
      ...result,
      message: `v${latest} is installed; it takes effect the next time you start forwardemail`,
    };
  }
  if (install === 'binary') {
    try {
      await installBinary(release, {
        fetchImpl: options.fetchImpl,
        target: options.target,
        signal: AbortSignal.timeout(5 * 60_000),
        publicKey: options.publicKey,
      });
    } catch (error) {
      return {
        ...result,
        message: `v${latest} is available but could not be installed: ${(error as Error).message}`,
      };
    }
    if (options.stateFile) {
      writeState(options.stateFile, { checkedAt: Date.now(), latest, applied: latest });
    }
    return {
      ...result,
      message: `v${latest} is installed; it takes effect the next time you start forwardemail`,
    };
  }
  if (install === 'npm') {
    return {
      ...result,
      message: `v${latest} is available (you have v${current}). Quit and run: forwardemail update`,
    };
  }
  return {
    ...result,
    message: `v${latest} is available (you have v${current}). This copy runs from a source checkout; update it with git pull and pnpm build:cli`,
  };
}
