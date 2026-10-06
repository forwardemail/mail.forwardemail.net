/**
 * cli/install.sh run by sh, as `curl … | sh` runs it, with a curl on PATH
 * that serves a release from a local folder: what it says about the
 * forwardemail a shell finds on PATH after installing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const INSTALLER = path.resolve('cli/install.sh');
const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir;
let tools;

// An executable that prints `version` for --version
function executable(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-install-'));

  // The release: every build the installer may pick, and their checksums
  const release = path.join(dir, 'release');
  fs.mkdirSync(release);
  const binary = gzipSync(Buffer.from('#!/bin/sh\necho 9.9.9\n'));
  const sums = [];
  for (const name of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
    const asset = `forwardemail-${name}.gz`;
    fs.writeFileSync(path.join(release, asset), binary);
    sums.push(`${createHash('sha256').update(binary).digest('hex')}  ${asset}`);
  }
  fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);

  // curl -fsSL --retry 3 -o <file> <url>: copies the release file of that name
  tools = path.join(dir, 'tools');
  fs.mkdirSync(tools);
  fs.writeFileSync(
    path.join(tools, 'curl'),
    [
      '#!/bin/sh',
      'out=""',
      'while [ "$#" -gt 1 ]; do',
      '  [ "$1" = -o ] && out="$2"',
      '  shift',
      'done',
      `cp "${release}/$(basename "$1")" "$out"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Runs the installer into `installDir` with `pathDirs` on PATH
function install(installDir, pathDirs) {
  const systemPath = process.env.PATH ?? '/usr/bin:/bin';
  const result = spawnSync('sh', [INSTALLER], {
    encoding: 'utf8',
    env: {
      HOME: dir,
      FORWARDEMAIL_INSTALL_DIR: installDir,
      FORWARDEMAIL_VERSION: '9.9.9',
      PATH: [tools, ...pathDirs, systemPath].join(path.delimiter),
    },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe('cli/install.sh', () => {
  posixOnly('installs and says how to run it when its folder is on PATH', () => {
    const bin = path.join(dir, 'bin');
    const result = install(bin, [bin]);
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain(`Installed Forward Email 9.9.9 to ${bin}/forwardemail`);
    expect(result.out).toContain('Run: forwardemail');
    expect(result.out).not.toContain('Another forwardemail');
  });

  posixOnly('treats a symlink to the install folder on PATH as that folder', () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(bin, alias);
    const result = install(bin, [alias, bin]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Run: forwardemail');
    expect(result.out).not.toContain('Another forwardemail');
  });

  posixOnly('names another copy that comes first on PATH', () => {
    const other = path.join(dir, 'npm-global', 'bin');
    executable(path.join(other, 'forwardemail'), '0.9.0');
    const bin = path.join(dir, 'bin');
    const result = install(bin, [other, bin]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      `Another forwardemail (0.9.0) comes first on your PATH: ${other}/forwardemail`,
    );
    expect(result.out).toContain(`put ${bin} before it on your PATH`);
    expect(result.out).not.toContain('Run: forwardemail');
  });

  posixOnly('says how to add the folder when it is not on PATH', () => {
    const bin = path.join(dir, 'bin');
    const result = install(bin, []);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`${bin} is not on your PATH`);
    expect(fs.readFileSync(path.join(bin, 'forwardemail'), 'utf8')).toContain('echo 9.9.9');
  });
});
