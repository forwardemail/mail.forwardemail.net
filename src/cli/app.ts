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
