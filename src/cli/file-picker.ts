/**
 * The system's file dialog, for "Attach" and other file fields.
 *
 *   macOS            osascript: choose file
 *   Linux, BSD       zenity or kdialog, when there is a display (KDE
 *                    desktops try kdialog first)
 *   Windows          PowerShell's OpenFileDialog
 *   WSL              PowerShell's OpenFileDialog through Windows interop,
 *                    then zenity or kdialog; Windows paths come back as
 *                    /mnt/c/… paths
 *
 * Over SSH a dialog would open on the remote computer, so none is used
 * there, except on Linux with a forwarded X display (ssh -X). Without a
 * dialog, the caller asks for a path in the terminal instead (see
 * attachments.ts). FORWARDEMAIL_FILE_PICKER=terminal always does that.
 *
 * Each program runs asynchronously, so the app keeps drawing while the
 * dialog is open, and takes its arguments as an array: no shell sees the
 * title or the paths.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { windowsToWsl, type PathContext } from './file-paths';

export type PickerProgram = 'osascript' | 'zenity' | 'kdialog' | 'powershell';

export interface PickerEnvironment extends PathContext {
  env: NodeJS.ProcessEnv;
}

/** The dialogs to try, in order, or none when the terminal must ask. */
export function nativePickers({ platform, env, wsl }: PickerEnvironment): PickerProgram[] {
  if ((env.FORWARDEMAIL_FILE_PICKER ?? '').toLowerCase() === 'terminal') return [];
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
  if (platform === 'darwin') return remote ? [] : ['osascript'];
  if (platform === 'win32') return remote ? [] : ['powershell'];
  const display = Boolean(env.DISPLAY || (!remote && env.WAYLAND_DISPLAY));
  const kde = /kde/i.test(env.XDG_CURRENT_DESKTOP ?? '') || Boolean(env.KDE_FULL_SESSION);
  const unix: PickerProgram[] = display
    ? kde
      ? ['kdialog', 'zenity']
      : ['zenity', 'kdialog']
    : [];
  return wsl && !remote ? ['powershell', ...unix] : unix;
}

export interface PickerRequest {
  title: string;
  multiple: boolean;
}

interface Command {
  file: string;
  args: string[];
}

// A PowerShell string literal: single quotes, with any inside doubled.
const psString = (text: string) => `'${text.replace(/'/g, "''")}'`;

export function pickerCommand(program: PickerProgram, request: PickerRequest): Command {
  const { title, multiple } = request;
  switch (program) {
    case 'osascript': {
      // The title arrives as an argument (argv), not in the script text.
      const choose = `choose file with prompt (item 1 of argv)${multiple ? ' with multiple selections allowed' : ''}`;
      const lines = [
        'on run argv',
        'activate',
        `set picked to ${multiple ? choose : `{${choose}}`}`,
        'set out to ""',
        'repeat with f in picked',
        'set out to out & POSIX path of f & linefeed',
        'end repeat',
        'return out',
        'end run',
      ];
      return { file: 'osascript', args: [...lines.flatMap((line) => ['-e', line]), title] };
    }
    case 'zenity':
      return {
        file: 'zenity',
        args: [
          '--file-selection',
          `--title=${title}`,
          ...(multiple ? ['--multiple', '--separator=\n'] : []),
        ],
      };
    case 'kdialog':
      return {
        file: 'kdialog',
        args: [
          '--title',
          title,
          '--getopenfilename',
          '.',
          ...(multiple ? ['--multiple', '--separate-output'] : []),
        ],
      };
    case 'powershell': {
      // -EncodedCommand (UTF-16LE base64) keeps the script away from the
      // command-line quoting of Windows and of WSL interop. The title is
      // the app's own text, written as a literal.
      const script = [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.Windows.Forms',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
        '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
        `$dialog.Title = ${psString(title)}`,
        `$dialog.Multiselect = $${multiple ? 'true' : 'false'}`,
        'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  [Console]::Out.Write(($dialog.FileNames -join "`n"))',
        '}',
        '$owner.Dispose()',
      ].join('\n');
      return {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
      };
    }
  }
}

export type PickResult =
  | { status: 'picked'; paths: string[] }
  | { status: 'cancelled' }
  // The program is missing or could not show a dialog (no display).
  | { status: 'unavailable'; reason: string };

// What zenity and kdialog say when they cannot reach the display.
const NO_DISPLAY = /cannot open display|could not connect to display|failed to open display/i;

function classify(
  program: PickerProgram,
  error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null,
  stdout: string,
  stderr: string,
): PickResult {
  if (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') {
      return { status: 'unavailable', reason: `${program} not found` };
    }
    if (error.killed || error.signal) return { status: 'cancelled' };
    // Pressing Cancel: osascript reports error -128; zenity and kdialog
    // exit with 1. The PowerShell script exits cleanly on Cancel, so any
    // failure there means no dialog (no desktop session, blocked .NET).
    if (program === 'powershell') {
      return { status: 'unavailable', reason: stderr.trim() || error.message };
    }
    if (program === 'osascript') {
      return /-128/.test(stderr)
        ? { status: 'cancelled' }
        : { status: 'unavailable', reason: stderr.trim() || error.message };
    }
    if (error.code === 1 && !NO_DISPLAY.test(stderr)) return { status: 'cancelled' };
    return { status: 'unavailable', reason: stderr.trim() || error.message };
  }
  const paths = stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, ''))
    .filter((line) => line.trim() !== '');
  return paths.length ? { status: 'picked', paths } : { status: 'cancelled' };
}

export interface RunningPick {
  /** Whether a dialog is being tried; false when the terminal must ask. */
  dialog: boolean;
  result: Promise<PickResult>;
  /** Closes the dialog, as Cancel would. */
  cancel(): void;
}

/** Shows one program's dialog. */
export function runPicker(
  program: PickerProgram,
  request: PickerRequest,
  context: PathContext,
): RunningPick {
  const { file, args } = pickerCommand(program, request);
  let child: ChildProcess | null = null;
  const result = new Promise<PickResult>((resolve) => {
    try {
      child = execFile(
        file,
        args,
        { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: false },
        (error, stdout, stderr) => {
          const picked = classify(program, error, String(stdout ?? ''), String(stderr ?? ''));
          // PowerShell under WSL answers with Windows paths.
          if (picked.status === 'picked' && program === 'powershell' && context.wsl) {
            const wsl = context.wsl;
            picked.paths = picked.paths.map((p) => windowsToWsl(p.trim(), wsl) ?? p.trim());
          }
          resolve(picked);
        },
      );
      child.stdin?.end();
    } catch (error) {
      resolve({ status: 'unavailable', reason: (error as Error).message });
    }
  });
  return {
    dialog: true,
    result,
    cancel: () => {
      try {
        (child as ChildProcess | null)?.kill();
      } catch {
        // already gone
      }
    },
  };
}

/**
 * Tries each dialog in turn until one shows. Resolves to the chosen paths,
 * to 'cancelled', or to 'unavailable' when none could be shown.
 */
export function pickWithSystemDialog(
  request: PickerRequest,
  environment: PickerEnvironment,
): RunningPick {
  let current: RunningPick | null = null;
  let cancelled = false;
  const programs = nativePickers(environment);
  const result = (async (): Promise<PickResult> => {
    let last: PickResult = { status: 'unavailable', reason: 'no file dialog here' };
    for (const program of programs) {
      if (cancelled) return { status: 'cancelled' };
      current = runPicker(program, request, environment);
      last = await current.result;
      if (last.status !== 'unavailable') return last;
    }
    return cancelled ? { status: 'cancelled' } : last;
  })();
  return {
    dialog: programs.length > 0,
    result,
    cancel: () => {
      cancelled = true;
      (current as RunningPick | null)?.cancel();
    },
  };
}
