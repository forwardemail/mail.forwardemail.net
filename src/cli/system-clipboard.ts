/**
 * Copying to the system clipboard from the terminal client.
 *
 * In a browser, navigator.clipboard.writeText puts the text on the clipboard
 * or fails. TermDOM's version writes the terminal's clipboard sequence
 * (OSC 52) and reports success, but many terminals ignore that sequence:
 * Terminal.app, GNOME Terminal and the other VTE terminals, the Windows
 * console, iTerm2 until "Applications in terminal may access clipboard" is
 * on, and tmux without `set-clipboard on`. The app then said "Copied to
 * clipboard" for text that never got there.
 *
 * A copy here takes two routes:
 *
 * - OSC 52, which reaches the clipboard of the computer in front of the user
 *   even over SSH. Inside tmux or GNU screen the sequence goes out a second
 *   time, wrapped so the multiplexer passes it to the terminal around it
 *   unchanged (tmux does that with `allow-passthrough on`, screen always).
 *   The client counts as inside one when TMUX or STY is set and TERM names
 *   it: a terminal window opened from a tmux shell inherits TMUX, and the
 *   wrapped copy would reach that terminal as a second, broken copy.
 *   The plain sequence still goes out: tmux with `set-clipboard on` takes
 *   it, fills its own paste buffer and forwards it, which the wrapped copy
 *   does not cover. A terminal that gets both sets the same text twice.
 * - On the computer the client runs on (no SSH), the system's clipboard
 *   program: pbcopy on macOS; PowerShell's Set-Clipboard, then clip.exe, on
 *   Windows and in WSL; wl-copy under Wayland and xclip or xsel under X11 on
 *   Linux and the BSDs.
 *
 * A terminal never says whether it took an OSC 52 sequence, so a copy counts
 * as done when a clipboard program succeeded, or when OSC 52 is the one route
 * there is: over SSH, or with no clipboard program here. When a program ran
 * and failed, the copy fails, and the app says so instead of "Copied". It
 * fails as well when no program is installed and the terminal is one known
 * to ignore OSC 52 (Terminal.app, the VTE terminals, the Linux console), with
 * the programs to install in the message.
 *
 * On Windows, clip.exe decodes its input with the console's code page, which
 * turns UTF-8 into mojibake, and keeps a byte order mark as an invisible
 * first character of the copy (U+FEFF). Set-Clipboard gets the text as raw
 * bytes that the script decodes as UTF-8, so every character arrives as it
 * was. clip.exe is the fallback where PowerShell cannot start, fed UTF-16LE
 * with no byte order mark.
 *
 * Programs start with argument lists and read the text on their input, so
 * the text never reaches a shell.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export type Env = Record<string, string | undefined>;

export interface CopyProgram {
  /** The name messages and the debug log use. */
  name: string;
  command: string;
  args: string[];
  /** The encoding of the text on the program's input. */
  encoding: 'utf8' | 'utf16le';
  /** Variables the program gets on top of the session's own. */
  env?: Env;
  /** How long it may take, when that is longer than the usual. */
  timeoutMs?: number;
}

/** 'missing': the program could not start (not installed, not runnable). */
export type ProgramResult = 'copied' | 'missing' | 'failed';

interface ChildLike {
  stdin: {
    end(data: Buffer): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
  } | null;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: {
    env: Env;
    stdio: ['pipe', 'ignore', 'ignore'];
    windowsHide: boolean;
    detached: boolean;
  },
) => ChildLike;

export interface ClipboardOptions {
  /** Where the OSC 52 sequence goes (the terminal). */
  output?: { write(text: string): unknown };
  platform?: NodeJS.Platform;
  env?: Env;
  /** Whether this Linux is WSL; worked out from the system when left out. */
  wsl?: boolean;
  spawn?: SpawnLike;
  /** How long a clipboard program may take before it counts as failed. */
  timeoutMs?: number;
}

export interface CopyResult {
  /** The program that took the text, or null when OSC 52 was the one route. */
  program: string | null;
}

/**
 * The longest text OSC 52 carries, in bytes. A longer copy (the raw source of
 * a message with attachments) would push megabytes of base64 through the
 * terminal and an SSH connection, which stalls both, and tmux drops a
 * sequence over 1 MiB; it goes to the clipboard program alone.
 */
export const MAX_TERMINAL_COPY = 512 * 1024;

const TIMEOUT_MS = 5000;

// GNU screen cuts a passed-through string longer than 256 bytes (768 since
// version 4.2.1), so the wrapped sequence goes out in pieces of this size.
const SCREEN_PIECE = 252;

/** Whether the client runs on another computer than the user's screen. */
export function isRemoteSession(env: Env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

/**
 * Whether the terminal is one known to ignore OSC 52: Terminal.app, GNOME
 * Terminal and the other VTE terminals, and the Linux console. Their
 * variables reach the client on the same computer (and inside tmux there).
 */
export function ignoresTerminalCopy(env: Env): boolean {
  return Boolean(env.VTE_VERSION) || env.TERM_PROGRAM === 'Apple_Terminal' || env.TERM === 'linux';
}

/** Whether this Linux runs in WSL, where the Windows programs are at hand. */
export function isWsl(env: Env = process.env, release: string = os.release()): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft/i.test(release);
}

/**
 * The sequences that put `text` on the clipboard through the terminal: OSC 52,
 * and inside tmux or screen the same again, wrapped for the multiplexer to
 * pass through.
 */
export function clipboardSequences(text: string, env: Env = process.env): string[] {
  const osc = `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
  const term = env.TERM ?? '';
  // tmux sets TERM to tmux-* or screen-*, screen to screen*.
  if (env.TMUX && /^(tmux|screen)/.test(term)) {
    // tmux passes on what follows "tmux;", with each ESC in it written twice.
    return [osc, `\x1bPtmux;${osc.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`];
  }
  if (env.STY && term.startsWith('screen')) {
    let wrapped = '';
    for (let at = 0; at < osc.length; at += SCREEN_PIECE) {
      wrapped += `\x1bP${osc.slice(at, at + SCREEN_PIECE)}\x1b\\`;
    }
    return [osc, wrapped];
  }
  return [osc];
}

// Reads the input as bytes and decodes them as UTF-8, whatever the console's
// code page is, then sets the clipboard. Fixed text: the copy is on the
// input, never in the command.
const SET_CLIPBOARD = [
  "$ErrorActionPreference='Stop'",
  '$in=[Console]::OpenStandardInput()',
  '$bytes=New-Object System.IO.MemoryStream',
  '$in.CopyTo($bytes)',
  'Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString($bytes.ToArray()))',
].join(';');

function windowsPrograms(powershell: string, clip: string): CopyProgram[] {
  return [
    {
      name: 'PowerShell',
      command: powershell,
      args: ['-NoProfile', '-NonInteractive', '-Sta', '-Command', SET_CLIPBOARD],
      encoding: 'utf8',
      // PowerShell can take seconds to start, more so through WSL.
      timeoutMs: 15_000,
    },
    { name: 'clip.exe', command: clip, args: [], encoding: 'utf16le' },
  ];
}

/** The clipboard programs to try, in order, on the computer the client runs on. */
export function copyPrograms(platform: NodeJS.Platform, env: Env, wsl = false): CopyProgram[] {
  if (platform === 'darwin') {
    // pbcopy decodes its input by the locale, and reads UTF-8 in this one.
    return [
      {
        name: 'pbcopy',
        command: '/usr/bin/pbcopy',
        args: [],
        encoding: 'utf8',
        env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      },
    ];
  }
  if (platform === 'win32') {
    // Full paths: a bare name would also match a program in the current
    // directory.
    const system32 = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32');
    return windowsPrograms(
      path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      path.win32.join(system32, 'clip.exe'),
    );
  }
  const programs: CopyProgram[] = [];
  if (wsl) {
    // Through WSL's Windows interop: on the PATH, or at the default mount.
    const system32 = '/mnt/c/Windows/System32';
    programs.push(
      ...windowsPrograms('powershell.exe', 'clip.exe'),
      ...windowsPrograms(
        `${system32}/WindowsPowerShell/v1.0/powershell.exe`,
        `${system32}/clip.exe`,
      ),
    );
  }
  if (env.WAYLAND_DISPLAY) {
    programs.push({
      name: 'wl-copy',
      command: 'wl-copy',
      args: ['--type', 'text/plain;charset=utf-8'],
      encoding: 'utf8',
    });
  }
  if (env.DISPLAY) {
    programs.push(
      { name: 'xclip', command: 'xclip', args: ['-selection', 'clipboard'], encoding: 'utf8' },
      { name: 'xsel', command: 'xsel', args: ['--clipboard', '--input'], encoding: 'utf8' },
    );
  }
  return programs;
}

/**
 * Runs a clipboard program with the text on its input. xclip, xsel and
 * wl-copy fork a process that keeps serving the copy after the program
 * exits, so the exit of the program this runs is what counts: nothing reads
 * its output (the fork would hold the pipes open), and outside Windows it
 * starts in a session of its own, so the copy outlives a closed terminal
 * window.
 */
export function runCopyProgram(
  program: CopyProgram,
  text: string,
  options: { spawn?: SpawnLike; env?: Env; timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<ProgramResult> {
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const platform = options.platform ?? process.platform;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: ProgramResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ChildLike;
    try {
      child = spawn(program.command, program.args, {
        env: { ...(options.env ?? process.env), ...program.env },
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        detached: platform !== 'win32',
      });
    } catch {
      settle('missing');
      return;
    }
    let started = false;
    child.on('spawn', () => {
      started = true;
    });
    child.on('error', () => settle(started ? 'failed' : 'missing'));
    child.on('exit', (code) => settle(code === 0 ? 'copied' : 'failed'));
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle('failed');
    }, options.timeoutMs ?? TIMEOUT_MS);
    timer.unref?.();
    // A program that quits before reading everything closes its input.
    child.stdin?.on('error', () => {});
    child.stdin?.end(Buffer.from(text, program.encoding));
  });
}

/**
 * The copy behind navigator.clipboard and Ctrl+C. Resolves with the route the
 * text took, and rejects with the reason when it reached no clipboard.
 */
export function createClipboardWriter(options: ClipboardOptions = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const wsl = options.wsl ?? (platform === 'linux' && isWsl(env));
  const output = options.output ?? process.stdout;

  return async function copy(text: string): Promise<CopyResult> {
    let sent = false;
    let reason = 'the text is too long to copy through the terminal';
    if (Buffer.byteLength(text, 'utf8') <= MAX_TERMINAL_COPY) {
      try {
        output.write(clipboardSequences(text, env).join(''));
        sent = true;
      } catch {
        reason = 'the terminal is not reachable';
      }
    }
    // Over SSH a program would fill the clipboard of the remote computer.
    const programs = isRemoteSession(env) ? [] : copyPrograms(platform, env, wsl);
    const failed: string[] = [];
    for (const program of programs) {
      // WSL lists each Windows program twice (on the PATH and at its full
      // path); a program that ran and failed does not run again.
      if (failed.includes(program.name)) continue;
      const result = await runCopyProgram(program, text, {
        spawn: options.spawn,
        env,
        platform,
        timeoutMs: options.timeoutMs ?? program.timeoutMs,
      });
      if (result === 'copied') return { program: program.name };
      if (result === 'failed') failed.push(program.name);
    }
    if (failed.length > 0) throw new Error(`${failed.join(' and ')} failed`);
    if (!sent) throw new Error(reason);
    if (!isRemoteSession(env) && ignoresTerminalCopy(env)) {
      // (by package: wl-copy comes with wl-clipboard)
      const install = [
        ...new Set(programs.map(({ name }) => (name === 'wl-copy' ? 'wl-clipboard' : name))),
      ];
      throw new Error(
        install.length > 0
          ? `this terminal does not take copies; install ${install.join(' or ')}`
          : 'this terminal does not take copies',
      );
    }
    return { program: null };
  };
}
