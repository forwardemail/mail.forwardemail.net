/**
 * File paths as terminals hand them over.
 *
 * A terminal delivers no drag events. Dropping files on its window pastes
 * their paths as text, quoted in the terminal's own way:
 *
 *   macOS Terminal, iTerm2, Ghostty   /Users/me/My\ Report.pdf
 *   GNOME Terminal, WezTerm (Linux)   '/home/me/My Report.pdf'
 *   Konsole, kitty, some others       file:///home/me/My%20Report.pdf
 *   Windows Terminal, conhost         "C:\Users\me\My Report.pdf"
 *   mintty (Git Bash)                 /c/Users/me/My Report.pdf
 *
 * with several files separated by spaces or new lines. parseDroppedPaths
 * turns such text back into absolute paths, or says it is not a list of
 * paths. completePath does Tab completion for the typed path prompt.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PathContext {
  platform: NodeJS.Platform;
  home: string;
  /**
   * Under WSL: where Windows drives are mounted (/mnt/ unless
   * /etc/wsl.conf says otherwise) and this distribution's name, to turn
   * C:\… and \\wsl.localhost\<distro>\… into Linux paths.
   */
  wsl?: { mountRoot: string; distro?: string } | null;
}

function readWslMountRoot(): string {
  try {
    const conf = fs.readFileSync('/etc/wsl.conf', 'utf8');
    const automount = conf.split(/^\s*\[/m).find((section) => /^automount\]/i.test(section));
    const root = automount?.match(/^\s*root\s*=\s*(\S+)/m)?.[1];
    if (root) return root.endsWith('/') ? root : `${root}/`;
  } catch {
    // the default
  }
  return '/mnt/';
}

/** Whether this is Linux running under WSL. */
export function isWsl(platform = process.platform, env = process.env): boolean {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** The context of this process. */
export function currentPathContext(): PathContext {
  const wsl = isWsl();
  return {
    platform: process.platform,
    home: os.homedir(),
    wsl: wsl
      ? { mountRoot: readWslMountRoot(), distro: process.env.WSL_DISTRO_NAME || undefined }
      : null,
  };
}

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** A Windows path (C:\…, \\server\share\…) as a WSL path, or null. */
export function windowsToWsl(
  windowsPath: string,
  wsl: { mountRoot: string; distro?: string },
): string | null {
  const drive = windowsPath.match(/^([A-Za-z]):[\\/]?(.*)$/s);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/');
    return path.posix.normalize(`${wsl.mountRoot}${drive[1].toLowerCase()}/${rest}`);
  }
  // The Linux side of WSL, as Windows sees it.
  const unc = windowsPath.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(.*)$/is);
  if (unc && (!wsl.distro || unc[1].toLowerCase() === wsl.distro.toLowerCase())) {
    return path.posix.normalize(`/${unc[2].replace(/\\/g, '/')}`);
  }
  return null;
}

/**
 * One path as a terminal or a person wrote it (already unquoted), as an
 * absolute path, or null if it is not one. `relativeTo` allows paths
 * relative to that directory (the typed prompt); a paste takes only
 * absolute ones.
 */
export function normalizePath(
  value: string,
  context: PathContext,
  relativeTo?: string,
): string | null {
  let text = value;
  const windows = context.platform === 'win32';
  if (!text) return null;

  if (/^file:/i.test(text)) {
    let rest = text.slice(5);
    let host = '';
    if (rest.startsWith('//')) {
      const slash = rest.indexOf('/', 2);
      host = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
      rest = slash === -1 ? '/' : rest.slice(slash);
    }
    try {
      rest = decodeURIComponent(rest);
    } catch {
      return null;
    }
    // file:///C:/Users/… and the old file:///C|/Users/…
    const drive = rest.match(/^\/([A-Za-z])[:|](\/.*)?$/s);
    if (drive) text = `${drive[1]}:${drive[2] ?? '/'}`;
    else if (host && host.toLowerCase() !== 'localhost' && windows)
      text = `\\\\${host}${rest.replace(/\//g, '\\')}`;
    // A host on Linux and macOS is this computer's name (Konsole sends it).
    else text = rest;
    if (!text.startsWith('/') && !WINDOWS_PATH.test(text)) return null;
  }

  if (/^~(?=$|[\\/])/.test(text)) text = context.home + text.slice(1);

  if (WINDOWS_PATH.test(text)) {
    if (windows) return path.win32.normalize(text);
    if (context.wsl) return windowsToWsl(text, context.wsl);
    return null;
  }

  if (windows) {
    // mintty (Git Bash, Cygwin) writes C:\ as /c/ or /cygdrive/c/.
    const msys = text.match(/^\/(?:cygdrive\/)?([A-Za-z])(?:\/(.*))?$/s);
    if (msys) return path.win32.normalize(`${msys[1].toUpperCase()}:\\${msys[2] ?? ''}`);
    if (relativeTo !== undefined) return path.win32.resolve(relativeTo, text);
    return null;
  }

  if (text.startsWith('/')) return path.posix.normalize(text);
  if (relativeTo !== undefined) return path.posix.resolve(relativeTo, text);
  return null;
}

/**
 * Splits a line into words as a shell would: whitespace separates them,
 * quotes group them and (outside Windows paths) a backslash escapes the
 * next character. Null for an unclosed quote.
 */
export function splitWords(line: string, windows: boolean): string[] | null {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (!windows && char === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]))
        word += line[++i];
      else word += char;
      continue;
    }
    if (char === '\\' && !windows) {
      if (i + 1 < line.length) word += line[++i];
      inWord = true;
      continue;
    }
    if (char === '"' || (char === "'" && !windows)) {
      quote = char;
      inWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    word += char;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
}

// Text longer than this, or with more lines, is not a drop.
const MAX_TEXT = 64 * 1024;
const MAX_LINES = 200;

export interface ParseOptions {
  /** Whether a path exists, to choose between two readings of a line. */
  exists?: (path: string) => boolean;
  /** Allow relative paths, resolved against this directory. */
  relativeTo?: string;
}

/**
 * The absolute paths in pasted text, or null when the text is anything
 * else. Each line is read as shell words first; a line whose words are not
 * all existing paths, but which is itself one (an unquoted path with
 * spaces, as Alacritty pastes it), is taken whole.
 */
export function parseDroppedPaths(
  text: string,
  context: PathContext,
  options: ParseOptions = {},
): string[] | null {
  if (!text || text.length > MAX_TEXT) return null;
  // eslint-disable-next-line no-control-regex -- control characters other than tab and new line
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  const lines = text
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_LINES) return null;

  const found: string[] = [];
  for (const line of lines) {
    const windows =
      context.platform === 'win32' || (Boolean(context.wsl) && /^"?(?:[A-Za-z]:|\\\\)/.test(line));
    const words = splitWords(line, windows);
    const paths = words?.map((word) => normalizePath(word, context, options.relativeTo)) ?? null;
    const valid = paths && paths.length > 0 && paths.every((p) => p !== null);
    const whole = normalizePath(line, context, options.relativeTo);
    const { exists } = options;
    if (valid && (!exists || (paths as string[]).every(exists))) found.push(...(paths as string[]));
    else if (whole && exists?.(whole)) found.push(whole);
    else if (valid) found.push(...(paths as string[]));
    else if (whole) found.push(whole);
    else return null;
  }
  return [...new Set(found)];
}

export interface Completion {
  /** The text with the completion applied. */
  value: string;
  /** Every name that matched, when there was more than one. */
  matches: string[];
}

type ReadDir = (dir: string) => Promise<fs.Dirent[]>;
type IsDirectory = (file: string) => Promise<boolean>;

const readDir: ReadDir = (dir) => fs.promises.readdir(dir, { withFileTypes: true });
const isDirectory: IsDirectory = (file) =>
  fs.promises.stat(file).then(
    (stat) => stat.isDirectory(),
    () => false,
  );

/**
 * Tab completion of a typed path, as a shell does it: one match is filled
 * in (with a trailing separator for a folder), several are filled in as
 * far as they agree and listed.
 */
export async function completePath(
  value: string,
  context: PathContext & { cwd: string },
  io: { readDir?: ReadDir; isDirectory?: IsDirectory } = {},
): Promise<Completion> {
  const windows = context.platform === 'win32';
  const separator = windows ? '\\' : '/';
  const cut = Math.max(value.lastIndexOf('/'), windows ? value.lastIndexOf('\\') : -1);
  const typedDir = value.slice(0, cut + 1);
  const prefix = value.slice(cut + 1);
  const dir =
    typedDir === ''
      ? context.cwd
      : (normalizePath(typedDir, context, context.cwd) ?? path.resolve(context.cwd, typedDir));

  let entries: fs.Dirent[];
  try {
    entries = await (io.readDir ?? readDir)(dir);
  } catch {
    return { value, matches: [] };
  }
  const visible = entries.filter((entry) => prefix.startsWith('.') || !entry.name.startsWith('.'));
  let names = visible.filter((entry) => entry.name.startsWith(prefix));
  // macOS and Windows file names ignore case.
  if (names.length === 0) {
    const lower = prefix.toLowerCase();
    names = visible.filter((entry) => entry.name.toLowerCase().startsWith(lower));
  }
  if (names.length === 0) return { value, matches: [] };

  const folder = async (entry: fs.Dirent) =>
    entry.isDirectory() ||
    (entry.isSymbolicLink() && (await (io.isDirectory ?? isDirectory)(path.join(dir, entry.name))));
  const labels = await Promise.all(
    names.map(async (entry) => `${entry.name}${(await folder(entry)) ? separator : ''}`),
  );
  if (labels.length === 1) return { value: typedDir + labels[0], matches: [] };

  let common = labels[0];
  for (const label of labels) {
    while (!label.startsWith(common)) common = common.slice(0, -1);
  }
  return {
    value: typedDir + (common.length > prefix.length ? common : prefix),
    matches: labels.sort((a, b) => a.localeCompare(b)),
  };
}
