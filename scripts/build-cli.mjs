#!/usr/bin/env node
/**
 * Builds the `forwardemail` terminal client into cli/dist/forwardemail.cjs:
 * one CommonJS file with no runtime dependencies, used both by the npm
 * package and as the entry point of the single executable (scripts/build-sea.mjs),
 * plus cli/dist/notifier/, the programs that show desktop notifications.
 *
 *   node scripts/build-cli.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import {
  insertAfterRule,
  pruneCustomProperties,
  pruneStylesheet,
  referencedCustomProperties,
} from '../src/cli/prune-css.js';
import { convertStylesheet } from '../src/cli/px-to-cells.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const outDir = path.join(root, 'cli', 'dist');
const configFile = path.join(root, 'vite.cli.config.js');

fs.rmSync(outDir, { recursive: true, force: true });

for (const mode of ['app', 'launcher', 'thread']) {
  const started = Date.now();
  await build({ configFile, mode });
  console.log(`built ${mode} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

const read = (name) => fs.readFileSync(path.join(outDir, name), 'utf8');
const app = read('app.cjs');
const launcher = read('launcher.cjs');
const thread = read('thread.cjs');
// Custom properties that scripts, markup or the terminal theme mention by
// name are kept even when no rule reads them.
function sourceText(dir) {
  let text = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) text += sourceText(file);
    else if (/\.(ts|js|svelte|css)$/.test(entry.name)) {
      const content = fs.readFileSync(file, 'utf8');
      // A component's own <style> is in the stylesheet already.
      text += entry.name.endsWith('.svelte')
        ? content.replace(/<style[\s\S]*?<\/style>/g, '')
        : entry.name.endsWith('.css') && !file.includes(`${path.sep}cli${path.sep}`)
          ? ''
          : content;
    }
  }
  return text;
}

// The stylesheet is trimmed to what a terminal can draw and its lengths are
// converted to cells once, here, rather than on every launch.
const keep = referencedCustomProperties(sourceText(path.join(root, 'src')));
const css = insertAfterRule(
  convertStylesheet(pruneCustomProperties(pruneStylesheet(read('app.css')), keep)),
  '.inline-flex',
  fs.readFileSync(path.join(root, 'src', 'cli', 'terminal-utilities.css'), 'utf8'),
);

// The app runs only when the launcher calls __forwardemailLoadApp(), after the
// terminal document, storage and workers are installed as globals.
const output = [
  '#!/usr/bin/env node',
  `/*! forwardemail v${pkg.version} | https://github.com/forwardemail/mail.forwardemail.net | BUSL-1.1 */`,
  `var __forwardemailAppCss = ${JSON.stringify(css)};`,
  `var __forwardemailWorkerBootstrap = ${JSON.stringify(thread)};`,
  'function __forwardemailLoadApp() {',
  '  var module = { exports: {} };',
  '  (function (module, exports, require, __filename, __dirname) {',
  app,
  '  })(module, module.exports, require, __filename, __dirname);',
  '  return module.exports;',
  '}',
  // The launcher gets its own scope too: its top-level names (TermDOM declares
  // Comment, Node and the like for its own use) would otherwise shadow the
  // DOM globals the app reads by the same names.
  '(function () {',
  launcher,
  '})();',
  '',
].join('\n');

const target = path.join(outDir, 'forwardemail.cjs');
fs.writeFileSync(target, output, { mode: 0o755 });
for (const name of ['app.cjs', 'launcher.cjs', 'thread.cjs', 'app.css']) {
  fs.rmSync(path.join(outDir, name));
}

// Desktop notifications (src/cli/notifications.ts) run the system's notifier
// through toasted-notifier, which needs its programs as files: macOS's
// terminal-notifier and Windows' ntfytoast, with their licenses. Linux uses
// notify-send from the system. build-sea.mjs embeds the ones for its platform.
const toasted = path.dirname(
  createRequire(import.meta.url).resolve('toasted-notifier/package.json'),
);
const notifierDir = path.join(outDir, 'notifier');
const notifierFiles = [
  ['vendor/mac.noindex/terminal-notifier.app', 'mac.noindex/terminal-notifier.app'],
  ['vendor/terminal-notifier-LICENSE', 'LICENSE-terminal-notifier'],
  ['vendor/ntfyToast/ntfytoast.exe', 'ntfytoast.exe'],
  ['vendor/ntfyToast/LICENSE.txt', 'LICENSE-ntfytoast.txt'],
  ['LICENSE.md', 'LICENSE-toasted-notifier.md'],
];
for (const [from, to] of notifierFiles) {
  fs.cpSync(path.join(toasted, from), path.join(notifierDir, to), { recursive: true });
}
fs.copyFileSync(
  path.join(root, 'public', 'icons', 'icon-256.png'),
  path.join(notifierDir, 'icon.png'),
);
// toasted-notifier's package has them without the executable bit.
for (const program of [
  'mac.noindex/terminal-notifier.app/Contents/MacOS/terminal-notifier',
  'ntfytoast.exe',
]) {
  fs.chmodSync(path.join(notifierDir, program), 0o755);
}

const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`wrote ${path.relative(root, target)} (${size} MB)`);

// The npm package (cli/) ships the bundle with the CLI guide as its README.
const cliPkg = JSON.parse(fs.readFileSync(path.join(root, 'cli', 'package.json'), 'utf8'));
if (cliPkg.version !== pkg.version) {
  console.error(
    `cli/package.json is at ${cliPkg.version} but package.json is at ${pkg.version}; run node scripts/sync-version.cjs`,
  );
  process.exit(1);
}
fs.copyFileSync(path.join(root, 'docs', 'CLI.md'), path.join(root, 'cli', 'README.md'));
fs.copyFileSync(path.join(root, 'LICENSE.md'), path.join(root, 'cli', 'LICENSE.md'));
