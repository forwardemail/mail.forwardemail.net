/**
 * Desktop notifications for the terminal client.
 *
 * The webmail announces new mail (and calendar reminders, new folders, …)
 * through the browser's Notification API when its window is not the one in
 * use (utils/notification-manager.js, utils/notification-bridge.js). Here
 * that API is backed by the operating system's own notifications through
 * toasted-notifier: Notification Center on macOS (terminal-notifier), the
 * desktop's notification service on Linux and BSD (notify-send), and toasts
 * on Windows (ntfytoast). Whether the terminal is in use comes from focus.ts.
 *
 * Permission is given the browser's way, from the app: its "Turn on" offer
 * and Settings › Notifications. It is kept in notifications.json in the data
 * directory, and "Turn off notifications" in Settings gives it back.
 *
 * They are off over SSH (a notification would appear on the remote
 * computer's screen, if it has one) and on a Linux system with no desktop
 * session. FORWARDEMAIL_NOTIFICATIONS=0 or --no-notifications turns them off
 * everywhere; FORWARDEMAIL_NOTIFICATIONS=1 turns them on over SSH as well.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import NotificationCenter from 'toasted-notifier/notifiers/notificationcenter';
import NotifySend from 'toasted-notifier/notifiers/notifysend';
import WindowsToaster from 'toasted-notifier/notifiers/toaster';
import { isStandaloneBinary } from './update';
import type { AnyRecord } from './types';

export type Permission = 'default' | 'granted' | 'denied';

export interface DesktopNotification {
  title: string;
  body: string;
  tag?: string;
  /** Called when the notification is clicked, where the system reports it. */
  onClick?: () => void;
}

export interface Notifier {
  /** Resolves true when the system took the notification. */
  show(notification: DesktopNotification): Promise<boolean>;
  /** What shows them, for `forwardemail notifications`. */
  describe?(): { name: string; program: string | null };
}

// ── Where the notifier programs are ─────────────────────────────────────────

/**
 * The files scripts/build-cli.mjs copies next to forwardemail.cjs (npm and
 * source builds) and scripts/build-sea.mjs embeds in a standalone
 * executable, under these names.
 */
export const NOTIFIER_FILES = {
  darwin: 'mac.noindex/terminal-notifier.app/Contents/MacOS/terminal-notifier',
  win32: 'ntfytoast.exe',
  icon: 'icon.png',
};

const MANIFEST_ASSET = 'notifier/manifest.json';

interface ManifestEntry {
  path: string;
  mode: number;
}

/**
 * A standalone executable carries the notifier as assets; they are written
 * to the data directory once per version, since a program has to be a file
 * to run.
 */
function extractAssets(dataDir: string, version: string): string | null {
  let sea: { getAsset(key: string, encoding?: string): ArrayBuffer | string };
  let manifest: ManifestEntry[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sea = require('node:sea');
    manifest = JSON.parse(sea.getAsset(MANIFEST_ASSET, 'utf8') as string);
  } catch {
    return null;
  }
  const parent = path.join(dataDir, 'notifier');
  const target = path.join(parent, version);
  if (fs.existsSync(path.join(target, '.complete'))) return target;

  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.rmSync(temporary, { recursive: true, force: true });
    for (const entry of manifest) {
      const file = path.join(temporary, entry.path);
      if (!file.startsWith(temporary + path.sep)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(sea.getAsset(`notifier/${entry.path}`) as ArrayBuffer), {
        mode: entry.mode,
      });
    }
    fs.writeFileSync(path.join(temporary, '.complete'), '');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(temporary, target);
  } catch {
    fs.rmSync(temporary, { recursive: true, force: true });
    // Another instance may have finished first.
    return fs.existsSync(path.join(target, '.complete')) ? target : null;
  }
  // Earlier versions' copies, once a day has passed: another version may
  // still be running (a self-update leaves the old instance open), and
  // Windows cannot delete a program that is running. Best effort.
  try {
    for (const name of fs.readdirSync(parent)) {
      if (name === version || name.endsWith('.tmp')) continue;
      const dir = path.join(parent, name);
      if (Date.now() - fs.statSync(dir).mtimeMs < 24 * 60 * 60 * 1000) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // left for a later run
  }
  return target;
}

function notifierDir(dataDir: string, version: string): string | null {
  if (isStandaloneBinary()) return extractAssets(dataDir, version);
  const beside = path.join(__dirname, 'notifier');
  return fs.existsSync(beside) ? beside : null;
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, command)));
}

// ── The system notifier ─────────────────────────────────────────────────────

const ROSETTA = '/Library/Apple/usr/libexec/oah/libRosettaRuntime';

// Text for one line. notify-send would also read a leading "-" as an option.
const oneLine = (text: string) =>
  text
    .replace(/\s*\n\s*/g, ' · ')
    .trim()
    .replace(/^-/, '‑');

/**
 * Why notifications are off on this computer, or null when they can be
 * shown. `setting` is FORWARDEMAIL_NOTIFICATIONS (or "0" for
 * --no-notifications).
 */
export function unavailableReason(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = platform === process.platform ? process.arch : 'x64',
): string | null {
  const setting = (env.FORWARDEMAIL_NOTIFICATIONS ?? '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(setting)) return 'turned off';
  const forced = ['1', 'on', 'true', 'yes'].includes(setting);
  if (!forced && (env.SSH_CONNECTION || env.SSH_TTY)) return 'remote session';
  // terminal-notifier is an Intel program: on Apple Silicon it runs under
  // Rosetta 2, and without Rosetta macOS would offer to install it instead.
  if (platform === 'darwin' && arch === 'arm64' && !fs.existsSync(ROSETTA)) {
    return 'Rosetta 2 is not installed (softwareupdate --install-rosetta)';
  }
  if (platform === 'darwin' || platform === 'win32') return null;
  if (!forced && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.DBUS_SESSION_BUS_ADDRESS) {
    return 'no desktop session';
  }
  return onPath('notify-send', env) ? null : 'notify-send is not installed';
}

/** The operating system's notifier, or null when it has none here. */
export function createSystemNotifier(options: {
  dataDir: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Where the notifier programs are; found by the client otherwise. */
  programs?: string;
}): Notifier | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (unavailableReason(env, platform) !== null) return null;

  // Found, and for a standalone executable written out, on first use.
  let dir: string | null | undefined;
  const file = (name: string, executable = false) => {
    if (dir === undefined) dir = options.programs ?? notifierDir(options.dataDir, options.version);
    const full = dir ? path.join(dir, name) : null;
    if (!full || !fs.existsSync(full)) return null;
    if (executable && platform !== 'win32') {
      try {
        fs.accessSync(full, fs.constants.X_OK);
      } catch {
        try {
          fs.chmodSync(full, 0o755);
        } catch {
          return null;
        }
      }
    }
    return full;
  };

  const run = (
    notifier: { notify(options: AnyRecord, callback: (...args: unknown[]) => void): unknown },
    args: AnyRecord,
    onClick?: () => void,
  ) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (!settled) resolve(value);
        settled = true;
      };
      try {
        notifier.notify(args, (error: unknown, response: unknown) => {
          if (response === 'activate') onClick?.();
          settle(!error);
        });
      } catch {
        settle(false);
      }
      // Windows waits for the toast to be dismissed before answering.
      if (platform === 'win32') setTimeout(() => settle(true), 1000).unref?.();
    });

  if (platform === 'darwin') {
    return {
      describe: () => ({
        name: 'Notification Center (terminal-notifier)',
        program: file(NOTIFIER_FILES.darwin, true),
      }),
      async show({ title, body, tag, onClick }) {
        const customPath = file(NOTIFIER_FILES.darwin, true);
        if (!customPath) return false;
        // Clicking brings the terminal the client runs in to the front, and
        // the app opens what the notification is about. terminal-notifier
        // waits for the click only when given a timeout, and reports it as
        // JSON. The program is started here rather than through
        // toasted-notifier so that it can be ended when the client quits.
        const bundle = env.__CFBundleIdentifier;
        if (onClick) {
          return showWithAction(env, {
            command: customPath,
            args: [
              '-title',
              oneLine(title) || 'Forward Email',
              '-message',
              oneLine(body) || ' ',
              ...(tag ? ['-group', tag] : []),
              ...(bundle && /^[\w.-]+$/.test(bundle) ? ['-activate', bundle] : []),
              '-sound',
              'default',
              '-json',
              '-timeout',
              String(CLICK_WAIT_SECONDS),
            ],
            group: tag,
            clicked: (output) =>
              /"activationType"\s*:\s*"(?:contentsClicked|actionClicked)"/.test(output),
            onClick,
          });
        }
        return run(new NotificationCenter({ customPath, withFallback: false }), {
          title: oneLine(title) || 'Forward Email',
          message: oneLine(body) || ' ',
          // A later notification for the same message replaces this one.
          ...(tag ? { group: tag } : {}),
          ...(bundle && /^[\w.-]+$/.test(bundle) ? { activate: bundle } : {}),
          sound: 'default',
          timeout: false,
        });
      },
    };
  }

  if (platform === 'win32') {
    return {
      describe: () => ({
        name: 'Windows notifications (ntfytoast)',
        program: file(NOTIFIER_FILES.win32),
      }),
      async show({ title, body, onClick }) {
        const customPath = file(NOTIFIER_FILES.win32);
        if (!customPath) return false;
        const icon = file(NOTIFIER_FILES.icon);
        return run(
          new WindowsToaster({ customPath, withFallback: false }),
          {
            title: oneLine(title) || 'Forward Email',
            message: body.trim() || ' ',
            ...(icon ? { icon } : {}),
          },
          onClick,
        );
      },
    };
  }

  return {
    describe: () => ({
      name: 'the desktop notification service (notify-send)',
      program: 'notify-send',
    }),
    async show({ title, body, onClick }) {
      const icon = file(NOTIFIER_FILES.icon);
      if (onClick && notifySendHasActions(env)) {
        return showWithAction(env, {
          command: 'notify-send',
          args: [
            '--app-name=Forward Email',
            '--action=default=Open',
            '--wait',
            ...(icon ? [`--icon=${icon}`] : []),
            '--',
            oneLine(title) || 'Forward Email',
            oneLine(body) || ' ',
          ],
          // notify-send prints the name of the action taken.
          clicked: (output) => output.split('\n').some((line) => line.trim() === 'default'),
          onClick,
        });
      }
      return run(new NotifySend(), {
        title: oneLine(title) || 'Forward Email',
        message: oneLine(body) || ' ',
        'app-name': 'Forward Email',
        ...(icon ? { icon } : {}),
      });
    },
  };
}

// ── Clicks on Linux ─────────────────────────────────────────────────────────

// notify-send learned --action and --wait in libnotify 0.7.10; older ones
// would show the option names as text.
const actionsSupported = new Map<string, boolean>();
function notifySendHasActions(env: NodeJS.ProcessEnv): boolean {
  const key = env.PATH ?? '';
  if (!actionsSupported.has(key)) {
    const help = spawnSync('notify-send', ['--help'], { env, encoding: 'utf8', timeout: 2000 });
    const text = `${help.stdout ?? ''}`;
    actionsSupported.set(key, /--action\b/.test(text) && /--wait\b/.test(text));
  }
  return actionsSupported.get(key)!;
}

// How long terminal-notifier waits for a click on macOS; the notification
// is taken down after that.
const CLICK_WAIT_SECONDS = 4 * 60 * 60;

// Programs waiting for a click, ended when the client quits, and the one
// showing each group (a later notification for a message replaces it).
const waiting = new Set<ChildProcess>();
const byGroup = new Map<string, ChildProcess>();
let cleanupInstalled = false;

/**
 * A notification whose click opens what it is about: the program shows it,
 * keeps running until it is clicked or closed, and prints what happened.
 */
function showWithAction(
  env: NodeJS.ProcessEnv,
  options: {
    command: string;
    args: string[];
    group?: string;
    clicked: (output: string) => boolean;
    onClick: () => void;
  },
): Promise<boolean> {
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    process.on('exit', () => {
      for (const child of waiting) child.kill();
    });
  }
  if (options.group) byGroup.get(options.group)?.kill();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, options.args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    waiting.add(child);
    if (options.group) byGroup.set(options.group, child);
    const forget = () => {
      waiting.delete(child);
      if (options.group && byGroup.get(options.group) === child) byGroup.delete(options.group);
    };
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (options.clicked(output)) {
        output = '';
        options.onClick();
      }
    });
    child.on('error', () => {
      forget();
      resolve(false);
    });
    child.on('exit', forget);
    // Shown once the program is running; it keeps running until the
    // notification is clicked or closed.
    child.on('spawn', () => resolve(true));
  });
}

// ── The Notification API ────────────────────────────────────────────────────

/** The answer kept in the data directory: 'granted' or 'default'. */
export function savedPermission(dataDir: string): Permission {
  return permissionStore(path.join(dataDir, PERMISSION_FILE)).get();
}

export const PERMISSION_FILE = 'notifications.json';

function permissionStore(file: string) {
  let permission: Permission = 'default';
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')).permission;
    if (saved === 'granted' || saved === 'denied') permission = saved;
  } catch {
    // not asked yet
  }
  return {
    get: () => permission,
    set(next: Permission) {
      permission = next;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, `${JSON.stringify({ permission: next })}\n`, { mode: 0o600 });
      } catch {
        // kept for this session
      }
    },
  };
}

/**
 * Installs window.Notification backed by `notifier`. Without a notifier
 * nothing is installed, and the app reports notifications as unavailable,
 * as in a browser without them.
 */
export function installNotifications(
  win: AnyRecord,
  options: { dataDir: string; notifier: Notifier | null },
) {
  const { notifier } = options;
  if (!notifier) return null;
  const store = permissionStore(path.join(options.dataDir, PERMISSION_FILE));
  const EventTargetBase = win.EventTarget as { new (): AnyRecord };

  // True while a click is being handled (the code the app runs for a
  // button; Enter or Space on a focused button is a click too), until the
  // next turn of the event loop.
  let inGesture = false;
  for (const type of ['click']) {
    win.addEventListener(
      type,
      (event: AnyRecord) => {
        if (event.isTrusted === false) return;
        inGesture = true;
        setImmediate(() => {
          inGesture = false;
        });
      },
      true,
    );
  }

  class TerminalNotification extends EventTargetBase {
    static get permission(): Permission {
      return store.get();
    }

    /**
     * There is no system prompt to show: the app asks from a button the
     * user just pressed ("Allow notifications", "Turn on"), which is the
     * answer. A request made outside a click or key press is ignored, as
     * browsers ignore it: calendar reminders ask on their own when they
     * load, which is no answer.
     */
    static requestPermission(callback?: (permission: Permission) => void): Promise<Permission> {
      if (store.get() === 'default' && inGesture) store.set('granted');
      const permission = store.get();
      callback?.(permission);
      return Promise.resolve(permission);
    }

    /** Settings' "Turn off notifications" (not in browsers). */
    static revokePermission(): Promise<void> {
      store.set('default');
      return Promise.resolve();
    }

    static get maxActions() {
      return 0;
    }

    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly data: unknown;
    readonly icon: string;
    onclick: ((event: AnyRecord) => void) | null = null;
    onshow: ((event: AnyRecord) => void) | null = null;
    onerror: ((event: AnyRecord) => void) | null = null;
    onclose: ((event: AnyRecord) => void) | null = null;

    constructor(title: string, init: AnyRecord = {}) {
      super();
      this.title = String(title ?? '');
      this.body = String(init.body ?? '');
      this.tag = String(init.tag ?? '');
      this.data = init.data ?? null;
      this.icon = String(init.icon ?? '');
      const fire = (type: string) => {
        const event = new win.Event(type);
        const handler = (this as AnyRecord)[`on${type}`];
        if (typeof handler === 'function') handler.call(this, event);
        this.dispatchEvent(event);
      };
      if (store.get() !== 'granted') {
        setImmediate(() => fire('error'));
        return;
      }
      notifier!
        .show({
          title: this.title,
          body: this.body,
          tag: this.tag,
          onClick: () => fire('click'),
        })
        .then(
          (shown) => fire(shown ? 'show' : 'error'),
          () => fire('error'),
        );
    }

    close() {}
  }

  Object.defineProperty(win, 'Notification', {
    configurable: true,
    writable: true,
    value: TerminalNotification,
  });
  return TerminalNotification;
}
