/**
 * The self-updater against a real HTTP server standing in for GitHub:
 * release lookup, checksum verification and swapping the executable.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assetName,
  backgroundUpdate,
  checkForTerminalUpdate,
  cleanupPreviousBinary,
  compareVersions,
  detectInstall,
  detectPackageManager,
  installBinary,
  parseChecksums,
  updatePackageInstall,
} from '../../src/cli/update';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

let server;
let base;
let routes;
let dir;

beforeEach(async () => {
  routes = new Map();
  server = http.createServer((request, response) => {
    const body = routes.get(request.url);
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-update-'));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

// Serves a release whose binary for this machine contains `contents`, with a
// SHA256SUMS.txt that lists `listedHash` (the right one unless overridden).
function publish(version, contents, { listedHash } = {}) {
  const name = `${assetName()}.gz`;
  const gz = gzipSync(Buffer.from(contents));
  routes.set(`/download/${name}`, gz);
  routes.set(
    '/download/SHA256SUMS.txt',
    `${listedHash ?? sha256(gz)}  ${name}\n${'0'.repeat(64)}  other-file.gz\n`,
  );
  routes.set(
    '/api/latest',
    JSON.stringify({
      tag_name: `v${version}`,
      html_url: `${base}/release`,
      assets: [
        { name, browser_download_url: `${base}/download/${name}` },
        { name: 'SHA256SUMS.txt', browser_download_url: `${base}/download/SHA256SUMS.txt` },
      ],
    }),
  );
  return {
    tag: `v${version}`,
    version,
    url: `${base}/release`,
    assets: [
      { name, url: `${base}/download/${name}` },
      { name: 'SHA256SUMS.txt', url: `${base}/download/SHA256SUMS.txt` },
    ],
  };
}

// fetch that sends GitHub API calls to the local server.
const localFetch = (input, init) =>
  fetch(
    String(input).replace(
      'https://api.github.com/repos/forwardemail/mail.forwardemail.net/releases/latest',
      `${base}/api/latest`,
    ),
    init,
  );

describe('versions', () => {
  it('orders by semver precedence', () => {
    expect(compareVersions('0.15.0', '0.14.14')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('0.14.9', '0.14.10')).toBe(-1);
  });

  it('reads sha256sum output', () => {
    const sums = parseChecksums(`${'a'.repeat(64)}  one.gz\n${'B'.repeat(64)} *two.gz\n\nnoise\n`);
    expect(sums.get('one.gz')).toBe('a'.repeat(64));
    expect(sums.get('two.gz')).toBe('b'.repeat(64));
    expect(sums.size).toBe(2);
  });
});

describe('installBinary', () => {
  it('replaces the executable with the verified, decompressed release binary', async () => {
    const target = path.join(dir, 'forwardemail');
    fs.writeFileSync(target, 'old build', { mode: 0o755 });
    const release = publish('9.9.9', 'new build');

    await installBinary(release, { target });

    expect(fs.readFileSync(target, 'utf8')).toBe('new build');
    if (process.platform === 'win32') {
      // Windows cannot delete a running .exe, so the old build is renamed
      // and removed on the next start.
      expect(fs.readFileSync(`${target}.old`, 'utf8')).toBe('old build');
      cleanupPreviousBinary(target);
    } else {
      expect(fs.statSync(target).mode & 0o111).not.toBe(0);
    }
    expect(fs.readdirSync(dir)).toEqual(['forwardemail']);
  });

  it('refuses a binary that does not match SHA256SUMS.txt and keeps the old one', async () => {
    const target = path.join(dir, 'forwardemail');
    fs.writeFileSync(target, 'old build', { mode: 0o755 });
    const release = publish('9.9.9', 'tampered build', { listedHash: 'f'.repeat(64) });

    await expect(installBinary(release, { target })).rejects.toThrow(/Checksum mismatch/);
    expect(fs.readFileSync(target, 'utf8')).toBe('old build');
    expect(fs.readdirSync(dir)).toEqual(['forwardemail']);
  });

  it('waits for a release that does not carry this platform yet', async () => {
    const release = { tag: 'v9.9.9', version: '9.9.9', url: '', assets: [] };
    await expect(
      installBinary(release, { target: path.join(dir, 'forwardemail') }),
    ).rejects.toThrow(/has no/);
  });
});

describe('backgroundUpdate', () => {
  it('updates a standalone binary once a day and says so', async () => {
    const target = path.join(dir, 'forwardemail');
    fs.writeFileSync(target, 'old build', { mode: 0o755 });
    publish('9.9.9', 'new build');
    const stateFile = path.join(dir, 'update.json');
    const originalExecPath = process.execPath;
    Object.defineProperty(process, 'execPath', { value: target, configurable: true });
    try {
      const message = await backgroundUpdate({
        version: '1.0.0',
        stateFile,
        install: 'binary',
        fetchImpl: localFetch,
      });
      expect(message).toContain('updated to 9.9.9');
      expect(fs.readFileSync(target, 'utf8')).toBe('new build');
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({
        latest: '9.9.9',
        applied: '9.9.9',
      });

      // Within the day: no second check.
      routes.clear();
      expect(
        await backgroundUpdate({
          version: '9.9.9',
          stateFile,
          install: 'binary',
          fetchImpl: localFetch,
        }),
      ).toBeNull();
    } finally {
      Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    }
  });

  it('only tells an npm install that an update exists', async () => {
    publish('9.9.9', 'new build');
    const stateFile = path.join(dir, 'update.json');
    const message = await backgroundUpdate({
      version: '1.0.0',
      stateFile,
      install: 'npm',
      fetchImpl: localFetch,
    });
    expect(message).toBe(
      'Forward Email 9.9.9 is available (you have 1.0.0). Update with: forwardemail update',
    );
    // Remembered for the rest of the day without asking GitHub again.
    routes.clear();
    expect(
      await backgroundUpdate({
        version: '1.0.0',
        stateFile,
        install: 'npm',
        fetchImpl: localFetch,
      }),
    ).toContain('9.9.9 is available');
  });

  it('stays quiet when up to date or when GitHub cannot be reached', async () => {
    publish('1.0.0', 'same build');
    expect(
      await backgroundUpdate({
        version: '1.0.0',
        stateFile: path.join(dir, 'a.json'),
        install: 'binary',
        fetchImpl: localFetch,
      }),
    ).toBeNull();

    routes.clear();
    expect(
      await backgroundUpdate({
        version: '1.0.0',
        stateFile: path.join(dir, 'b.json'),
        install: 'binary',
        fetchImpl: localFetch,
      }),
    ).toBeNull();
  });

  it('says so when a newer binary cannot be installed, instead of keeping quiet', async () => {
    // A folder that cannot take the new file, as for an executable installed
    // where the user cannot write.
    const target = path.join(dir, 'missing', 'forwardemail');
    publish('9.9.9', 'new build');
    const stateFile = path.join(dir, 'update.json');
    const originalExecPath = process.execPath;
    Object.defineProperty(process, 'execPath', { value: target, configurable: true });
    try {
      const message = await backgroundUpdate({
        version: '1.0.0',
        stateFile,
        install: 'binary',
        fetchImpl: localFetch,
      });
      expect(message).toContain('Forward Email 9.9.9 is available (you have 1.0.0)');
      expect(message).toContain('installing it failed');

      // Later that day it is still pointed out, without asking GitHub again.
      routes.clear();
      expect(
        await backgroundUpdate({
          version: '1.0.0',
          stateFile,
          install: 'binary',
          fetchImpl: localFetch,
        }),
      ).toBe('Forward Email 9.9.9 is available (you have 1.0.0). Update with: forwardemail update');
    } finally {
      Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    }
  });
});

// The shell's view of PATH runs these stand-ins, and they need node and sh.
const posixOnly = it.skipIf(process.platform === 'win32');
const envWith = (...dirs) => ({
  ...process.env,
  PATH: [...dirs, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
});

// A global install laid out the way a package manager does it: the package
// in its own folder, and a link to the package's entry in a bin folder.
function globalInstall(root, packageDir) {
  const entry = path.join(root, packageDir, 'dist', 'forwardemail.cjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '#!/usr/bin/env node\n', { mode: 0o755 });
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const link = path.join(binDir, 'forwardemail');
  fs.symlinkSync(path.relative(binDir, entry), link);
  return link;
}

// A `forwardemail` on PATH that prints `version`.
function forwardemailOnPath(binDir, version) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'forwardemail'), `#!/bin/sh\necho ${version}\n`, {
    mode: 0o755,
  });
}

// A package manager on PATH that records its arguments and, with `upgradeTo`,
// leaves a forwardemail that reports that version in its own folder.
function packageManagerOnPath(binDir, name, { upgradeTo, exitCode = 0 } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const log = path.join(binDir, `${name}-args.json`);
  const installed = path.join(binDir, 'forwardemail');
  const lines = [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`,
    upgradeTo
      ? `fs.writeFileSync(${JSON.stringify(installed)}, '#!/bin/sh\\necho ${upgradeTo}\\n', { mode: 0o755 });`
      : '',
    `process.exit(${exitCode});`,
  ];
  fs.writeFileSync(path.join(binDir, name), lines.join('\n'), { mode: 0o755 });
  return () => JSON.parse(fs.readFileSync(log, 'utf8'));
}

describe('which install this is', () => {
  posixOnly('follows the bin link of a global npm install into node_modules', () => {
    // Run as `forwardemail`, process.argv[1] is this link, not the package.
    const link = globalInstall(
      path.join(dir, 'prefix'),
      path.join('lib', 'node_modules', 'forwardemail'),
    );
    expect(link.split(path.sep)).not.toContain('node_modules');
    expect(detectInstall(link)).toBe('npm');
    expect(detectPackageManager(link)).toBe('npm');
  });

  it('treats a copy outside node_modules as a source checkout', () => {
    const file = path.join(dir, 'checkout', 'cli', 'dist', 'forwardemail.cjs');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(detectInstall(file)).toBe('source');
  });

  posixOnly('tells pnpm, Yarn and Bun global installs apart', () => {
    const pnpm = globalInstall(
      path.join(dir, 'pnpm-home'),
      path.join(
        'global',
        '5',
        'node_modules',
        '.pnpm',
        'forwardemail@1.0.0',
        'node_modules',
        'forwardemail',
      ),
    );
    const yarn = globalInstall(
      path.join(dir, '.config', 'yarn'),
      path.join('global', 'node_modules', 'forwardemail'),
    );
    const bun = globalInstall(
      path.join(dir, '.bun', 'install'),
      path.join('global', 'node_modules', 'forwardemail'),
    );
    expect(detectPackageManager(pnpm)).toBe('pnpm');
    expect(detectPackageManager(yarn)).toBe('yarn');
    expect(detectPackageManager(bun)).toBe('bun');
    for (const link of [pnpm, yarn, bun]) expect(detectInstall(link)).toBe('npm');
  });

  posixOnly('keeps npm for an npm install under a Node that pnpm manages', () => {
    const link = globalInstall(
      path.join(dir, '.local', 'share', 'pnpm', 'nodejs', '22'),
      path.join('lib', 'node_modules', 'forwardemail'),
    );
    expect(detectPackageManager(link)).toBe('npm');
  });
});

describe('forwardemail update for a package install', () => {
  const run = (options) => {
    const out = [];
    const err = [];
    return updatePackageInstall({
      ...options,
      print: (text) => out.push(text),
      printError: (text) => err.push(text),
    }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
  };

  posixOnly('runs the package manager that installed it and reports the new version', async () => {
    const bin = path.join(dir, 'bin');
    forwardemailOnPath(bin, '1.0.0');
    const args = packageManagerOnPath(bin, 'pnpm', { upgradeTo: '9.9.9' });
    const result = await run({ version: '1.0.0', manager: 'pnpm', env: envWith(bin) });
    expect(args()).toEqual(['add', '--global', 'forwardemail@latest']);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain('Updated Forward Email 1.0.0 → 9.9.9.');
  });

  posixOnly('says where the copy on PATH is when it still reports an older version', async () => {
    // An older forwardemail comes first on PATH; the update lands in the
    // package manager's own folder after it.
    const first = path.join(dir, 'first');
    const second = path.join(dir, 'second');
    forwardemailOnPath(first, '0.9.0');
    packageManagerOnPath(second, 'npm', { upgradeTo: '9.9.9' });
    const result = await run({ version: '1.0.0', manager: 'npm', env: envWith(first, second) });
    expect(result.code).toBe(1);
    expect(result.err).toContain(path.join(first, 'forwardemail'));
    expect(result.err).toContain('is 0.9.0');
  });

  posixOnly('says so when the copy on PATH is this one, still old', async () => {
    // The npm on PATH belongs to another Node.js install and put the update
    // in its own folder.
    const bin = path.join(dir, 'bin');
    const tools = path.join(dir, 'tools');
    forwardemailOnPath(bin, '0.9.0');
    packageManagerOnPath(tools, 'npm');
    const result = await run({
      version: '1.0.0',
      manager: 'npm',
      env: envWith(bin, tools),
      script: path.join(bin, 'forwardemail'),
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain(`(${path.join(bin, 'forwardemail')}) is still 0.9.0`);
    expect(result.err).toContain('npm prefix --global');
  });

  posixOnly('succeeds when no forwardemail is on PATH to check', async () => {
    const tools = path.join(dir, 'tools');
    packageManagerOnPath(tools, 'npm');
    const result = await run({ version: '1.0.0', manager: 'npm', env: envWith(tools) });
    expect(result.code).toBe(0);
    expect(result.err).toContain('no forwardemail is on your PATH');
  });

  posixOnly('reports the same version as up to date', async () => {
    const bin = path.join(dir, 'bin');
    forwardemailOnPath(bin, '1.0.0');
    packageManagerOnPath(bin, 'bun');
    const result = await run({ version: '1.0.0', manager: 'bun', env: envWith(bin) });
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain('Forward Email 1.0.0 is up to date.');
  });

  posixOnly('stops with the exit code when the package manager fails', async () => {
    const bin = path.join(dir, 'bin');
    packageManagerOnPath(bin, 'yarn', { exitCode: 3 });
    const result = await run({ version: '1.0.0', manager: 'yarn', env: envWith(bin) });
    expect(result.code).toBe(3);
    expect(result.err).toContain('yarn global add forwardemail@latest failed');
  });
});

describe("Settings' Check for Updates in the terminal client", () => {
  it('installs a newer release for a standalone binary, for the next start', async () => {
    const target = path.join(dir, 'forwardemail');
    fs.writeFileSync(target, 'old build', { mode: 0o755 });
    publish('9.9.9', 'new build');
    const stateFile = path.join(dir, 'update.json');
    const result = await checkForTerminalUpdate({
      version: '1.0.0',
      install: 'binary',
      fetchImpl: localFetch,
      target,
      stateFile,
    });
    expect(result).toEqual({
      upToDate: false,
      currentVersion: '1.0.0',
      latestVersion: '9.9.9',
      message: 'v9.9.9 is installed; it takes effect the next time you start forwardemail',
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('new build');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({
      latest: '9.9.9',
      applied: '9.9.9',
    });
  });

  it('does not download a release this session already installed', async () => {
    const target = path.join(dir, 'forwardemail');
    fs.writeFileSync(target, 'installed build', { mode: 0o755 });
    publish('9.9.9', 'another build');
    const stateFile = path.join(dir, 'update.json');
    fs.writeFileSync(stateFile, JSON.stringify({ latest: '9.9.9', applied: '9.9.9' }));
    const requests = [];
    const result = await checkForTerminalUpdate({
      version: '1.0.0',
      install: 'binary',
      fetchImpl: (input, init) => {
        requests.push(String(input));
        return localFetch(input, init);
      },
      target,
      stateFile,
    });
    expect(result.message).toBe(
      'v9.9.9 is installed; it takes effect the next time you start forwardemail',
    );
    expect(requests.filter((url) => url.includes('/download/'))).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('installed build');
  });

  it('tells a package install the command to run, and changes nothing', async () => {
    publish('9.9.9', 'new build');
    const result = await checkForTerminalUpdate({
      version: '1.0.0',
      install: 'npm',
      fetchImpl: localFetch,
    });
    expect(result.message).toBe(
      'v9.9.9 is available (you have v1.0.0). Quit and run: forwardemail update',
    );
  });

  it('says when it is up to date, and when GitHub cannot be reached', async () => {
    publish('1.0.0', 'same build');
    const current = await checkForTerminalUpdate({
      version: '1.0.0',
      install: 'binary',
      fetchImpl: localFetch,
    });
    expect(current).toMatchObject({
      upToDate: true,
      message: "You're on the latest version (v1.0.0)",
    });

    routes.clear();
    const offline = await checkForTerminalUpdate({
      version: '1.0.0',
      install: 'binary',
      fetchImpl: localFetch,
    });
    expect(offline).toMatchObject({
      upToDate: false,
      latestVersion: null,
      message: 'Could not check for updates',
    });
  });
});
