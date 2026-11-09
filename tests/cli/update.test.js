/**
 * The self-updater against a real HTTP server standing in for GitHub:
 * release lookup, checksum verification and swapping the executable.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
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
  UPDATE_PUBLIC_KEY,
  updatePackageInstall,
  verifySignature,
} from '../../src/cli/update';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// A minisign key pair, and signatures in the file format `tauri signer sign`
// writes (which the release workflow signs SHA256SUMS.txt with).
function signingKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = Buffer.from('0102030405060708', 'hex');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    publicKey: Buffer.from(
      `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`,
    ).toString('base64'),
    sign(data) {
      const signature = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
      const comment = 'timestamp:1\tfile:SHA256SUMS.txt';
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
      return Buffer.from(
        [
          'untrusted comment: signature from tauri secret key',
          Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64'),
          `trusted comment: ${comment}`,
          global.toString('base64'),
          '',
        ].join('\n'),
      ).toString('base64');
    },
  };
}

const KEY = signingKey();

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
// SHA256SUMS.txt that lists `listedHash` (the right one unless overridden)
// and ends with `ending` (the line that names the release unless overridden),
// signed by `signedBy` (the key the tests trust unless overridden, or not
// signed at all for null).
function publish(
  version,
  contents,
  { listedHash, signedBy = KEY, ending = `# version: ${version}\n` } = {},
) {
  const name = `${assetName()}.gz`;
  const gz = gzipSync(Buffer.from(contents));
  const sums = `${listedHash ?? sha256(gz)}  ${name}\n${'0'.repeat(64)}  other-file.gz\n${ending}`;
  const signed = signedBy
    ? [{ name: 'SHA256SUMS.txt.sig', url: `${base}/download/SHA256SUMS.txt.sig` }]
    : [];
  routes.set(`/download/${name}`, gz);
  routes.set('/download/SHA256SUMS.txt', sums);
  if (signedBy) routes.set('/download/SHA256SUMS.txt.sig', signedBy.sign(Buffer.from(sums)));
  routes.set(
    '/api/latest',
    JSON.stringify({
      tag_name: `v${version}`,
      html_url: `${base}/release`,
      assets: [
        { name, browser_download_url: `${base}/download/${name}` },
        { name: 'SHA256SUMS.txt', browser_download_url: `${base}/download/SHA256SUMS.txt` },
        ...signed.map((asset) => ({ name: asset.name, browser_download_url: asset.url })),
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
      ...signed,
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

  it('orders prereleases by their identifiers, numbers by value', () => {
    expect(compareVersions('1.2.0-beta.10', '1.2.0-beta.9')).toBe(1);
    expect(compareVersions('1.2.0-beta.9', '1.2.0-beta.10')).toBe(-1);
    expect(compareVersions('1.2.0-rc.1', '1.2.0-beta.11')).toBe(1);
    expect(compareVersions('1.2.0-alpha', '1.2.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.2.0-alpha.1', '1.2.0-alpha.beta')).toBe(-1);
    expect(compareVersions('1.2.0-beta.2', '1.2.0-beta.2')).toBe(0);
    expect(compareVersions('1.2.0-beta.1+build.9', '1.2.0-beta.2')).toBe(-1);
    expect(compareVersions('1.2.0+build.2', '1.2.0+build.1')).toBe(0);
  });

  it('reads sha256sum output', () => {
    const sums = parseChecksums(`${'a'.repeat(64)}  one.gz\n${'B'.repeat(64)} *two.gz\n\nnoise\n`);
    expect(sums.get('one.gz')).toBe('a'.repeat(64));
    expect(sums.get('two.gz')).toBe('b'.repeat(64));
    expect(sums.size).toBe(2);
  });
});

describe('verifySignature', () => {
  // made with `tauri signer generate` and `tauri signer sign` (a key for this test only)
  const publicKey =
    'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJFQ0JGMDBFOUE1MzFDQUMKUldTc0hGT2FEdkRMTHVDeXNNS3ZUUVdQWGVhYmd6UWRRdGY0aVJhZGFTbEp6bDZmR0x4MDUvWEgK';
  const signature =
    'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTc0hGT2FEdkRMTG1xNmRYUHpaMlVySW0yU0pIOXd6SENGTHRJNnBURmRsRzYzcFNRNC9Eb0NSTCtBTStCdnR1elJIR1dUeFVPeE13Szhwb3pqMUpQVzQyUG9QNktLd0FFPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MzM3NzY5CWZpbGU6U0hBMjU2U1VNUy50eHQKT1lKcVpFM1RZbEl1VW1Pd3Y3UTdsaVQ3MEJxS1RmSlZvdzRqaTFwSGVhdUZreUwyblVtUUhPNWVZdkRjMy91cVI2ZzZ0RDV4TUxvaEdTY3FOWVFsQVE9PQo=';

  it('accepts a signature made by tauri signer, and only for the signed file', () => {
    expect(verifySignature(Buffer.from('abc  file\n'), signature, publicKey)).toBe(true);
    expect(verifySignature(Buffer.from('abd  file\n'), signature, publicKey)).toBe(false);
    expect(verifySignature(Buffer.from('abc  file\n'), signature)).toBe(false);
    expect(verifySignature(Buffer.from('abc  file\n'), '', publicKey)).toBe(false);
  });

  it('does not accept a signature whose trusted comment was changed', () => {
    const lines = Buffer.from(signature, 'base64').toString('utf8').split('\n');
    lines[2] = lines[2].replace('SHA256SUMS.txt', 'SHA256SUMS.tx_');
    expect(verifySignature(Buffer.from('abc  file\n'), lines.join('\n'), publicKey)).toBe(false);
  });

  it('does not accept the hash of a signed file in place of the file', () => {
    const data = Buffer.from('abc  file\n');
    const lines = Buffer.from(KEY.sign(data), 'base64').toString('utf8').split('\n');
    // (relabelled from "the hash of the data is signed" to "the data is signed")
    const signed = Buffer.from(lines[1], 'base64');
    signed.write('Ed', 0, 'latin1');
    lines[1] = signed.toString('base64');
    const hash = createHash('blake2b512').update(data).digest();

    expect(verifySignature(data, KEY.sign(data), KEY.publicKey)).toBe(true);
    expect(verifySignature(hash, lines.join('\n'), KEY.publicKey)).toBe(false);
  });

  it('trusts the key the desktop updater trusts', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'src-tauri', 'tauri.conf.json'), 'utf8'),
    );
    expect(UPDATE_PUBLIC_KEY).toBe(config.plugins.updater.pubkey);
  });
});

describe('installBinary', () => {
  it('replaces the executable with the verified, decompressed release binary', async () => {
    const target = path.join(dir, 'forwardemail');
    fs.writeFileSync(target, 'old build', { mode: 0o755 });
    const release = publish('9.9.9', 'new build');

    await installBinary(release, { target, publicKey: KEY.publicKey });

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

    await expect(installBinary(release, { target, publicKey: KEY.publicKey })).rejects.toThrow(
      /Checksum mismatch/,
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('old build');
    expect(fs.readdirSync(dir)).toEqual(['forwardemail']);
  });

  it('refuses a release whose checksums are not signed by the trusted key', async () => {
    const target = path.join(dir, 'forwardemail');
    fs.writeFileSync(target, 'old build', { mode: 0o755 });
    const install = (release, publicKey = KEY.publicKey) =>
      installBinary(release, { target, publicKey });

    // (not signed at all)
    await expect(install(publish('9.9.9', 'new build', { signedBy: null }))).rejects.toThrow(
      /has no SHA256SUMS\.txt\.sig/,
    );
    // (signed by someone else)
    await expect(
      install(publish('9.9.9', 'new build', { signedBy: signingKey() })),
    ).rejects.toThrow(/not signed by Forward Email/);
    // (a signed list, changed afterwards to list another build)
    const release = publish('9.9.9', 'new build');
    const gz = gzipSync(Buffer.from('another build'));
    routes.set(`/download/${assetName()}.gz`, gz);
    routes.set('/download/SHA256SUMS.txt', `${sha256(gz)}  ${assetName()}.gz\n`);
    await expect(install(release)).rejects.toThrow(/not signed by Forward Email/);
    // (signed by the key the test trusts, which is not the one built in)
    await expect(installBinary(publish('9.9.9', 'new build'), { target })).rejects.toThrow(
      /not signed by Forward Email/,
    );

    expect(fs.readFileSync(target, 'utf8')).toBe('old build');
    expect(fs.readdirSync(dir)).toEqual(['forwardemail']);
  });

  it('refuses the signed files of another release', async () => {
    const target = path.join(dir, 'forwardemail');
    fs.writeFileSync(target, 'old build', { mode: 0o755 });
    const install = (release) => installBinary(release, { target, publicKey: KEY.publicKey });

    // (the assets of an earlier release, attached to a later one)
    const earlier = publish('1.0.0', 'an earlier build');
    await expect(install({ ...earlier, tag: 'v9.9.9', version: '9.9.9' })).rejects.toThrow(
      /not the list of that release/,
    );
    // (a signed list that names no release)
    await expect(install(publish('9.9.9', 'new build', { ending: '' }))).rejects.toThrow(
      /not the list of that release/,
    );
    // (a signed list that ends with the name of another release)
    await expect(
      install(publish('9.9.9', 'new build', { ending: '# version: 9.9.9\n# version: 1.0.0\n' })),
    ).rejects.toThrow(/not the list of that release/);

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
        publicKey: KEY.publicKey,
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
          publicKey: KEY.publicKey,
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
      publicKey: KEY.publicKey,
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
        publicKey: KEY.publicKey,
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
        publicKey: KEY.publicKey,
      }),
    ).toBeNull();

    routes.clear();
    expect(
      await backgroundUpdate({
        version: '1.0.0',
        stateFile: path.join(dir, 'b.json'),
        install: 'binary',
        fetchImpl: localFetch,
        publicKey: KEY.publicKey,
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
        publicKey: KEY.publicKey,
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
          publicKey: KEY.publicKey,
        }),
      ).toBe('Forward Email 9.9.9 is available (you have 1.0.0). Update with: forwardemail update');
    } finally {
      Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    }
  });
});

// The shell's view of PATH runs these stand-ins, and they need node and sh.
const posixOnly = it.skipIf(process.platform === 'win32');
// Node alone, not the folder it is installed in, where a global forwardemail
// may be installed too.
let nodeDir = null;
const nodeOnly = () => {
  if (!nodeDir) {
    nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-node-'));
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
  }
  return nodeDir;
};

const envWith = (...dirs) => ({
  ...process.env,
  PATH: [...dirs, nodeOnly(), '/usr/bin', '/bin'].join(path.delimiter),
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
      publicKey: KEY.publicKey,
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
      publicKey: KEY.publicKey,
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
      publicKey: KEY.publicKey,
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
      publicKey: KEY.publicKey,
    });
    expect(offline).toMatchObject({
      upToDate: false,
      latestVersion: null,
      message: 'Could not check for updates',
    });
  });
});
