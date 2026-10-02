#!/usr/bin/env node
/**
 * Decides whether a release build compiles in the web inspector.
 *
 * The inspector stays out unless WEB_INSPECTOR is true (1, true, yes or on).
 * It maps to the `devtools` Cargo feature in src-tauri/Cargo.toml, which also
 * explains why it is off by default. Debug builds (`pnpm tauri:dev`, `--debug`)
 * always include the inspector, whatever this says.
 *
 * Usage:
 *   node scripts/web-inspector-args.cjs           prints "--features devtools" or nothing
 *   node scripts/web-inspector-args.cjs --names   prints "devtools" or nothing, to join
 *                                                 with other Cargo features
 *   node scripts/web-inspector-args.cjs --exec tauri build [args...]
 *                                                 runs the command with the flag appended
 *
 * `--exec tauri` runs the project's Tauri CLI through Node, so no shell is
 * involved on any platform (on Windows a shell would re-split quoted
 * arguments such as a JSON --config). Other commands run as given.
 */
const { spawnSync } = require('node:child_process');

const FEATURE = 'devtools';
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function webInspectorEnabled(value = process.env.WEB_INSPECTOR) {
  return TRUE_VALUES.has(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

function webInspectorFeatures(value) {
  return webInspectorEnabled(value) ? [FEATURE] : [];
}

function webInspectorArgs(value) {
  return webInspectorEnabled(value) ? ['--features', FEATURE] : [];
}

function main(argv) {
  if (argv[0] === '--names') {
    process.stdout.write(webInspectorFeatures().join(','));
    return 0;
  }

  if (argv[0] === '--exec') {
    const [command, ...args] = argv.slice(1);
    if (!command) {
      console.error('web-inspector-args: --exec needs a command to run');
      return 2;
    }

    let file = command;
    let fileArgs = [...args, ...webInspectorArgs()];
    if (command === 'tauri') {
      let cli;
      try {
        cli = require.resolve('@tauri-apps/cli/tauri.js');
      } catch {
        console.error('web-inspector-args: @tauri-apps/cli is not installed (run pnpm install)');
        return 1;
      }
      file = process.execPath;
      fileArgs = [cli, ...fileArgs];
    }

    const result = spawnSync(file, fileArgs, { stdio: 'inherit' });
    if (result.error) {
      console.error(`web-inspector-args: ${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  }

  process.stdout.write(webInspectorArgs().join(' '));
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { webInspectorEnabled, webInspectorFeatures, webInspectorArgs };
