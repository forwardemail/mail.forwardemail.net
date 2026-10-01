#!/usr/bin/env node
/**
 * Builds the standalone `forwardemail` executable for the current platform
 * as a Node.js single executable application (SEA): a copy of this Node
 * binary with cli/dist/forwardemail.cjs injected, so it runs without Node
 * installed. Run `node scripts/build-cli.mjs` first.
 *
 *   node scripts/build-sea.mjs            -> cli/dist/forwardemail-<os>-<arch>[.exe]
 *   node scripts/build-sea.mjs --output x -> x
 *   node scripts/build-sea.mjs --gzip     -> also writes <output>.gz, the release asset
 *   node scripts/build-sea.mjs --gzip-only <file> -> only writes <file>.gz (after signing)
 *
 * https://nodejs.org/api/single-executable-applications.html
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { inject } from 'postject';
import { hasSignature, removeSignature } from './pe-signature.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    gzip: { type: 'boolean' },
    'gzip-only': { type: 'string' },
  },
});

function gzip(file) {
  fs.writeFileSync(`${file}.gz`, gzipSync(fs.readFileSync(file), { level: 9 }));
  const megabytes = (fs.statSync(`${file}.gz`).size / 1024 / 1024).toFixed(1);
  console.log(`wrote ${path.relative(root, file)}.gz (${megabytes} MB)`);
}

if (values['gzip-only']) {
  gzip(path.resolve(values['gzip-only']));
  process.exit(0);
}

const platform = process.platform === 'win32' ? 'win' : process.platform;
const defaultName = `forwardemail-${platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const entry = path.join(root, 'cli', 'dist', 'forwardemail.cjs');
const output = path.resolve(values.output ?? path.join(root, 'cli', 'dist', defaultName));

if (!fs.existsSync(entry)) {
  console.error(`Missing ${path.relative(root, entry)}; run node scripts/build-cli.mjs first.`);
  process.exit(1);
}

// The desktop notifier for this platform (see build-cli.mjs), as assets the
// executable writes out on first use (src/cli/notifications.ts).
const notifierDir = path.join(root, 'cli', 'dist', 'notifier');
const notifierFor = {
  darwin: ['mac.noindex', 'LICENSE-terminal-notifier'],
  win32: ['ntfytoast.exe', 'LICENSE-ntfytoast.txt', 'icon.png'],
}[process.platform] ?? ['icon.png'];
const assets = {};
const manifest = [];
function addNotifierFile(relative) {
  const file = path.join(notifierDir, relative);
  if (fs.statSync(file).isDirectory()) {
    for (const name of fs.readdirSync(file)) addNotifierFile(path.join(relative, name));
    return;
  }
  const key = relative.split(path.sep).join('/');
  assets[`notifier/${key}`] = file;
  // By name: a downloaded build artifact has lost its file modes.
  const program = key.endsWith('/MacOS/terminal-notifier') || key.endsWith('.exe');
  manifest.push({ path: key, mode: program ? 0o755 : 0o644 });
}
for (const name of [...notifierFor, 'LICENSE-toasted-notifier.md']) addNotifierFile(name);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-sea-'));
try {
  const blob = path.join(work, 'sea-prep.blob');
  const config = path.join(work, 'sea-config.json');
  const manifestFile = path.join(work, 'notifier-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.writeFileSync(
    config,
    JSON.stringify({
      main: entry,
      output: blob,
      disableExperimentalSEAWarning: true,
      // V8's code cache for the bundle, so launch skips most parsing.
      useCodeCache: true,
      useSnapshot: false,
      assets: { ...assets, 'notifier/manifest.json': manifestFile },
    }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(process.execPath, output);
  fs.chmodSync(output, 0o755);

  // The copy still carries the Node.js project's signature, which would no
  // longer match once the app is injected. Remove it first, so the release
  // can sign the executable as Forward Email.
  const macos = process.platform === 'darwin';
  const windows = process.platform === 'win32';
  if (macos) execFileSync('codesign', ['--remove-signature', output], { stdio: 'inherit' });
  if (windows) removeSignature(output);

  await inject(output, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: macos ? 'NODE_SEA' : undefined,
  });

  // Checked here, where CI builds it on Windows, rather than first failing
  // when the release signs it.
  if (windows && hasSignature(output)) {
    throw new Error(`${path.basename(output)} still has a signature table; it could not be signed`);
  }

  // Apple Silicon refuses to run unsigned code; an ad-hoc signature is enough
  // for a binary that was not downloaded through a quarantining browser.
  if (macos) execFileSync('codesign', ['--sign', '-', output], { stdio: 'inherit' });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const reported = execFileSync(output, ['--version'], { encoding: 'utf8' }).trim();
if (reported !== pkg.version) {
  console.error(`${path.basename(output)} reports ${reported}, expected ${pkg.version}`);
  process.exit(1);
}

const megabytes = (file) => (fs.statSync(file).size / 1024 / 1024).toFixed(1);
console.log(
  `wrote ${path.relative(root, output)} (${megabytes(output)} MB, Node ${process.version})`,
);

if (values.gzip) gzip(output);
