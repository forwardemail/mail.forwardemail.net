import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getDataDir, resolveUserPath } from './paths';
import {
  backgroundUpdate,
  cleanupPreviousBinary,
  compareVersions,
  detectInstall,
  fetchLatestRelease,
  installBinary,
  updateWithNpm,
} from './update';

const VERSION = import.meta.env.VITE_PKG_VERSION as string;

const help = () => `Forward Email in your terminal: the webmail, calendar and contacts.

Usage
  forwardemail [options]       Open Forward Email
  forwardemail update          Update to the latest version
  forwardemail logout          Sign out and delete local data on this computer
  forwardemail notifications   Show whether desktop notifications work here
                               (--test sends one)

Options
  --demo                       Explore the interface with sample data
  --api <url>                  Use another API server (self-hosted Forward Email)
  --no-update-check            Skip the daily update check
  --data-dir <path>            Keep settings and the session in this directory
  --no-hints                   Hide the key hints on the bottom row
  --no-notifications           No desktop notifications for new mail
  -v, --version                Print the version
  -h, --help                   Print this help

Environment
  FORWARDEMAIL_HOME            Same as --data-dir (now: ${getDataDir()})
  FORWARDEMAIL_API_URL         Same as --api
  FORWARDEMAIL_NO_UPDATE_CHECK Same as --no-update-check
  FORWARDEMAIL_NO_HINTS        Same as --no-hints
  FORWARDEMAIL_NOTIFICATIONS   0 is the same as --no-notifications; 1 shows them
                               over SSH too (off there by default)
  FORWARDEMAIL_DOWNLOADS       Where saved files go (default: ~/Downloads)
  FORWARDEMAIL_DEBUG           Write a debug log to forwardemail.log in FORWARDEMAIL_HOME

Notifications
  New mail that arrives while the terminal is in the background shows as a
  desktop notification. Turn them on or off in Settings > Account >
  Notifications.

Keys
  The bottom row shows the keys for the screen. r replies, a replies to all,
  f forwards, e archives, s stars, Del deletes, Ctrl+N writes a new message,
  Esc closes a menu or goes back, ? lists every shortcut. Change shortcuts in
  Settings > Keyboard Shortcuts. Tab moves between controls; the mouse clicks
  and scrolls. Ctrl+C quits.

Docs: https://github.com/forwardemail/mail.forwardemail.net/blob/main/docs/CLI.md`;

function print(text: string, stream: NodeJS.WriteStream = process.stdout) {
  stream.write(`${text}\n`);
}

async function runUpdate(): Promise<number> {
  const install = detectInstall();
  if (install === 'npm') {
    print('Updating with npm…');
    return updateWithNpm();
  }
  if (install === 'source') {
    print('This copy runs from a source checkout; update it with git pull and pnpm build:cli.');
    return 1;
  }
  print(`Checking for updates (current version ${VERSION})…`);
  const release = await fetchLatestRelease();
  if (compareVersions(release.version, VERSION) <= 0) {
    print(`Forward Email ${VERSION} is up to date.`);
    return 0;
  }
  await installBinary(release);
  print(`Updated Forward Email ${VERSION} → ${release.version}.`);
  return 0;
}

function runLogout(): number {
  const dir = getDataDir();
  // Only the files this client creates; FORWARDEMAIL_HOME may point anywhere.
  const files = ['local-storage.json', 'update.json', 'notifications.json', 'forwardemail.log'];
  fs.rmSync(path.join(dir, 'notifier'), { recursive: true, force: true });
  let removed = 0;
  for (const name of files) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed++;
    }
  }
  print(
    removed > 0
      ? `Signed out and removed local data from ${dir}.`
      : `Nothing to remove; no session is stored in ${dir}.`,
  );
  return 0;
}

async function runNotifications(test: boolean): Promise<number> {
  const { createSystemNotifier, savedPermission, unavailableReason } =
    await import('./notifications');
  const dataDir = getDataDir();
  const reason = unavailableReason();
  const notifier = reason ? null : createSystemNotifier({ dataDir, version: VERSION });
  const about = notifier?.describe?.();
  if (!notifier || !about) {
    print(`Desktop notifications are off here (${reason ?? 'not supported'}).`);
    return 0;
  }
  if (!about.program) {
    print(`Desktop notifications: ${about.name} is missing from this installation.`);
    return 1;
  }
  print(`Desktop notifications: ${about.name}`);
  print(`  program: ${about.program}`);
  print(
    savedPermission(dataDir) === 'granted'
      ? '  turned on in Settings > Account > Notifications'
      : '  not turned on yet: Settings > Account > Notifications > Allow notifications',
  );
  if (!test) return 0;
  const shown = await notifier.show({
    title: 'Forward Email',
    body: 'Notifications are working. New mail will appear like this.',
  });
  print(
    shown
      ? `Handed a test notification to ${about.name}.`
      : 'The test notification could not be shown.',
  );
  return shown ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        demo: { type: 'boolean' },
        api: { type: 'string' },
        'no-update-check': { type: 'boolean' },
        'data-dir': { type: 'string' },
        test: { type: 'boolean' },
        'no-hints': { type: 'boolean' },
        'no-notifications': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    print(`forwardemail: ${(error as Error).message}\n\n${help()}`, process.stderr);
    return 2;
  }
  const { values, positionals } = parsed;
  // Through the environment, so a restarted instance (a page load) and the
  // commands below use it too.
  if (values['data-dir']) process.env.FORWARDEMAIL_HOME = resolveUserPath(values['data-dir']);

  if (values.version) {
    print(VERSION);
    return 0;
  }
  if (values.help) {
    print(help());
    return 0;
  }

  const [command, ...rest] = positionals;
  if (command === 'update' || command === 'upgrade') return runUpdate();
  if (command === 'logout') return runLogout();
  if (command === 'notifications') {
    if (values['no-notifications']) process.env.FORWARDEMAIL_NOTIFICATIONS = '0';
    return runNotifications(Boolean(values.test));
  }
  if (values.test) {
    print(
      `forwardemail: --test only goes with the notifications command\n\n${help()}`,
      process.stderr,
    );
    return 2;
  }
  if (command === 'help') {
    print(help());
    return 0;
  }
  if (command || rest.length > 0) {
    print(`forwardemail: unknown command "${command}"\n\n${help()}`, process.stderr);
    return 2;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    print('forwardemail needs an interactive terminal.', process.stderr);
    return 1;
  }

  const api = values.api ?? process.env.FORWARDEMAIL_API_URL;
  if (api) {
    try {
      const url = new URL(api);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad protocol');
      (globalThis as Record<string, unknown>).__FORWARDEMAIL_API_URL__ = url.href.replace(
        /\/$/,
        '',
      );
    } catch {
      print(`forwardemail: --api must be an http(s) URL, got "${api}"`, process.stderr);
      return 2;
    }
  }

  const dataDir = getDataDir();
  cleanupPreviousBinary();
  const checkUpdates = !values['no-update-check'] && !process.env.FORWARDEMAIL_NO_UPDATE_CHECK;
  let notice: string | null = null;
  if (checkUpdates) {
    backgroundUpdate({ version: VERSION, stateFile: path.join(dataDir, 'update.json') }).then(
      (message) => {
        notice = message;
      },
      () => {},
    );
  }
  // Printed after the terminal has been handed back to the shell.
  process.on('exit', () => {
    if (notice) process.stderr.write(`\n${notice}\n`);
  });

  const { startApp } = await import('./app');
  await startApp({
    version: VERSION,
    dataDir,
    demo: Boolean(values.demo),
    hints: !values['no-hints'] && !process.env.FORWARDEMAIL_NO_HINTS,
    notifications: !values['no-notifications'],
  });
  return -1;
}

main(process.argv.slice(2)).then(
  (code) => {
    // -1: the app is running and exits on its own (Ctrl+C or sign-out).
    if (code >= 0) process.exitCode = code;
  },
  (error) => {
    // FORWARDEMAIL_DEBUG prints where it happened, for bug reports.
    const detail = process.env.FORWARDEMAIL_DEBUG ? (error as Error)?.stack : null;
    print(`forwardemail: ${detail ?? (error as Error)?.message ?? error}`, process.stderr);
    process.exitCode = 1;
  },
);
