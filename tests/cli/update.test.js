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
  compareVersions,
  installBinary,
  parseChecksums,
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
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o111).not.toBe(0);
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
});
