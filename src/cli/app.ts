import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { installEnvironment } from './environment';
import { installDevHooks } from './dev';
import { redirectConsole } from './logging';
import { installFocus } from './focus';
import { installHints } from './hints';
import { createSystemNotifier } from './notifications';
import { getPageMarkup, injectStyles } from './page';
import { isStandaloneBinary } from './update';

export interface StartOptions {
  version: string;
  dataDir: string;
  demo?: boolean;
  /** The key hint bar on the bottom row (hints.ts). */
  hints?: boolean;
  /** Desktop notifications (notifications.ts), where the system has them. */
  notifications?: boolean;
}

// Switching to the alternate screen saves the cursor; switching back
// restores the shell's screen and puts the cursor back.
const ALTERNATE_SCREEN = '\x1b[?1049h';
const MAIN_SCREEN = '\x1b[?1049l';
const CLEAR_SCREEN = '\x1b[H\x1b[2J';
// The switch back that TermDOM writes when it lets the terminal go.
const MAIN_SCREEN_KEEP_CURSOR = '\x1b[?1047l';

/**
 * Runs the app on the alternate screen, as vim and less do: the wheel
 * scrolls the app rather than the shell's scrollback, and quitting brings
 * the shell's screen back as it was.
 *
 * TermDOM lets the terminal go with ?1047l, which leaves the alternate
 * screen, and then draws its last frame, which would land over the shell's
 * lines. While the app runs, that switch is dropped from what TermDOM
 * writes, and the app leaves the alternate screen itself at exit, before
 * anything else is printed there (the update notice). An instance started
 * by restart() takes over the screen its parent left it on.
 */
function useAlternateScreen(restarted: boolean) {
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout) as (...args: unknown[]) => boolean;
  stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    write(
      typeof chunk === 'string' && chunk.includes(MAIN_SCREEN_KEEP_CURSOR)
        ? chunk.replaceAll(MAIN_SCREEN_KEEP_CURSOR, '')
        : chunk,
      ...rest,
    )) as typeof stdout.write;
  write(`${restarted ? '' : ALTERNATE_SCREEN}${CLEAR_SCREEN}`);
  process.prependListener('exit', () => {
    try {
      fs.writeSync(1, MAIN_SCREEN);
    } catch {
      // The terminal is gone.
    }
  });
}

// Handed from an instance to the one that replaces it (see restart()).
const RESUME_VARIABLE = 'FORWARDEMAIL_RESUME';
const ORIGIN = 'https://mail.forwardemail.net';

interface Resume {
  url: string;
  session: string | null;
}

function readResume(dataDir: string): { url?: string; sessionState?: Record<string, string> } {
  const raw = process.env[RESUME_VARIABLE];
  delete process.env[RESUME_VARIABLE];
  if (!raw) return {};
  try {
    const resume = JSON.parse(raw) as Resume;
    const url = new URL(resume.url);
    let sessionState: Record<string, string> | undefined;
    // Only a session file restart() wrote, never another path.
    const session =
      typeof resume.session === 'string' &&
      path.dirname(path.resolve(resume.session)) === path.resolve(dataDir) &&
      /^session-\d+\.json$/.test(path.basename(resume.session))
        ? resume.session
        : null;
    if (session) {
      try {
        sessionState = JSON.parse(fs.readFileSync(session, 'utf8'));
      } finally {
        fs.rmSync(session, { force: true });
      }
    }
    return { url: url.origin === ORIGIN ? url.href : undefined, sessionState };
  } catch {
    return {};
  }
}

// The sign-in screen's "Try Demo" button, pressed for --demo.
function pressWhenReady(document: Document, selector: string, timeout = 30_000) {
  const started = Date.now();
  const timer = setInterval(() => {
    const button = document.querySelector<HTMLElement>(selector);
    if (button) {
      clearInterval(timer);
      button.click();
    } else if (Date.now() - started > timeout) {
      clearInterval(timer);
    }
  }, 100);
  timer.unref?.();
}

/**
 * Boots the webmail inside the terminal: the same index.html body, the same
 * stylesheets plus the terminal theme, and the same main.ts.
 */
export async function startApp({
  version,
  dataDir,
  demo = false,
  hints = true,
  notifications = true,
}: StartOptions) {
  const logFile = redirectConsole(dataDir, Boolean(process.env.FORWARDEMAIL_DEBUG));
  // Set for an instance started by restart(), which takes over its screen.
  const restarted = Boolean(process.env[RESUME_VARIABLE]);
  const resume = readResume(dataDir);

  let restarting = false;
  // A page load: the app starts over at `url` in a fresh process, keeping
  // localStorage (on disk) and sessionStorage (handed over in a file), as a
  // browser tab keeps both across a reload.
  const restart = async (url: string) => {
    if (restarting) return;
    restarting = true;
    const state: Record<string, string> = {};
    for (let i = 0; i < env.sessionStorage.length; i++) {
      const key = env.sessionStorage.key(i);
      if (key !== null) state[key] = env.sessionStorage.getItem(key) ?? '';
    }
    const session = path.join(dataDir, `session-${process.pid}.json`);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(session, JSON.stringify(state), { mode: 0o600 });
    env.localStorage.flush();
    await env.term.dispose();

    const args = (isStandaloneBinary() ? process.argv.slice(2) : process.argv.slice(1)).filter(
      (arg) => arg !== '--demo',
    );
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, [RESUME_VARIABLE]: JSON.stringify({ url, session }) },
    });
    // The new instance owns the terminal; this one only waits for it.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {});
    child.on('exit', (code) => process.exit(code ?? 0));
  };

  const env = installEnvironment({
    dataDir,
    logFile,
    html: getPageMarkup(),
    url: resume.url,
    sessionState: resume.sessionState,
    version,
    reload: (url) => void restart(url),
    notifier: notifications ? createSystemNotifier({ dataDir, version }) : null,
  });
  injectStyles(env.document, dataDir);
  // A closed terminal window: the next screen write fails with EIO (or
  // EPIPE). Leave quietly, as a hung-up terminal program does, instead of
  // dying on an unhandled stream error.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EIO' || error.code === 'EPIPE') process.exit(0);
      throw error;
    });
  }
  process.on('SIGHUP', () => process.exit(0));
  useAlternateScreen(restarted);
  await env.term.attach();
  // Plain text by default for reading and writing (stores/settingsRegistry.ts).
  (globalThis as Record<string, unknown>).__FORWARDEMAIL_TERMINAL__ = true;
  installFocus(env.window);
  __forwardemailLoadApp();
  if (hints) installHints(env.window, { columns: () => process.stdout.columns || 80 });
  if (demo && !resume.url) pressWhenReady(env.document, '[data-testid="try-demo-btn"]');
  installDevHooks(env);
  return env;
}
