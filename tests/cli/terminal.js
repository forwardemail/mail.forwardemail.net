/**
 * Runs the built terminal client in a real pseudo-terminal and reads its
 * screen through a headless xterm.js, the way a user's terminal would.
 *
 * The pseudo-terminal comes from util-linux `script`, so interactive tests
 * run on Linux; `canRunInteractive` says whether this machine can.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = path.join(root, 'cli', 'dist', 'forwardemail.cjs');

export const canRunInteractive =
  process.platform === 'linux' &&
  spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout.includes('util-linux');

export function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-test-'));
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Starts `forwardemail <args>` at the given size. Returns helpers to type,
 * read the screen and wait for text, and a stop() that must be awaited.
 */
export function startTerminal({ args = [], home, cols = 120, rows = 36, env = {} } = {}) {
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  const command = [process.execPath, CLI, ...args].map(quote).join(' ');
  const child = spawn(
    'script',
    ['-qfec', `stty cols ${cols} rows ${rows}; exec ${command}`, '/dev/null'],
    {
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORWARDEMAIL_HOME: home,
        FORWARDEMAIL_NO_UPDATE_CHECK: '1',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let exited = null;
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });
  child.stdout.on('data', (data) => term.write(data));
  // What the client put on the clipboard (OSC 52) and the pointer shapes it
  // asked for (OSC 22), as a terminal would receive them.
  const clipboard = [];
  const pointerShapes = [];
  term.parser.registerOscHandler(52, (data) => {
    clipboard.push(Buffer.from(data.split(';').pop(), 'base64').toString('utf8'));
    return true;
  });
  term.parser.registerOscHandler(22, (data) => {
    pointerShapes.push(data);
    return true;
  });
  // The terminal answers the client's queries (cursor position, colors).
  term.onData((data) => {
    if (!exited) child.stdin.write(data);
  });

  const screen = () => {
    const buffer = term.buffer.active;
    const lines = [];
    for (let i = 0; i < rows; i++) {
      lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  };

  const waitFor = async (predicate, { timeout = 60_000, label } = {}) => {
    const test = typeof predicate === 'string' ? (text) => text.includes(predicate) : predicate;
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (test(screen())) return screen();
      if (exited) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Timed out waiting for ${label ?? JSON.stringify(String(predicate))}${exited ? ` (exited ${JSON.stringify(exited)})` : ''}\n--- screen ---\n${screen()}`,
    );
  };

  // A left click on the first cell of the first occurrence of `text`.
  // `onRow` picks the occurrence on that screen row instead.
  const click = (text, onRow) => {
    const lines = screen().split('\n');
    const row =
      onRow === undefined
        ? lines.findIndex((line) => line.includes(text))
        : lines[onRow]?.includes(text)
          ? onRow
          : -1;
    if (row === -1) throw new Error(`"${text}" is not on screen\n${screen()}`);
    const col = lines[row].indexOf(text) + 1;
    child.stdin.write(`\u001b[<0;${col};${row + 1}M\u001b[<0;${col};${row + 1}m`);
  };

  // Where `text` is: 1-based column and row of its first cell.
  const locate = (text, onRow) => {
    const lines = screen().split('\n');
    const row =
      onRow === undefined
        ? lines.findIndex((line) => line.includes(text))
        : lines[onRow]?.includes(text)
          ? onRow
          : -1;
    if (row === -1) throw new Error(`"${text}" is not on screen\n${screen()}`);
    return { col: lines[row].indexOf(text) + 1, row: row + 1 };
  };
  // A left click on a cell, by its 1-based column and row.
  const clickAt = (col, row) =>
    child.stdin.write(`\u001b[<0;${col};${row}M\u001b[<0;${col};${row}m`);
  // The pointer moved over a cell, with no button held.
  const hover = (col, row) => child.stdin.write(`\u001b[<35;${col};${row}M`);
  // A left-button drag from one cell to another.
  const drag = async (from, to) => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
    child.stdin.write(`\u001b[<0;${from.col};${from.row}M`);
    await pause();
    child.stdin.write(`\u001b[<32;${to.col};${to.row}M`);
    await pause();
    child.stdin.write(`\u001b[<0;${to.col};${to.row}m`);
  };

  // The colors of the first cell of the first occurrence of `text`, as
  // 0xRRGGBB numbers, or null for the terminal's default color.
  const colorsAt = (text) => {
    const lines = screen().split('\n');
    const row = lines.findIndex((line) => line.includes(text));
    if (row === -1) throw new Error(`"${text}" is not on screen\n${screen()}`);
    const buffer = term.buffer.active;
    const cell = buffer.getLine(buffer.viewportY + row).getCell(lines[row].indexOf(text));
    return {
      fg: cell.isFgRGB() ? cell.getFgColor() : null,
      bg: cell.isBgRGB() ? cell.getBgColor() : null,
    };
  };

  return {
    screen,
    waitFor,
    exit,
    click,
    clickAt,
    colorsAt,
    locate,
    hover,
    drag,
    clipboard,
    pointerShapes,
    // The terminal modes the client turned on (focus reports, mouse, …).
    modes: () => term.modes,
    type: (keys) => child.stdin.write(keys),
    async stop() {
      if (!exited) {
        child.kill('SIGKILL');
        await exit;
      }
      term.dispose();
    },
  };
}

export const KEYS = {
  down: '\u001b[B',
  up: '\u001b[A',
  enter: '\r',
  tab: '\t',
  escape: '\u001b',
  ctrlC: '\u0003',
  ctrlN: '\u000e',
};

export function runCli(args, { home, env = {}, input } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, FORWARDEMAIL_HOME: home, FORWARDEMAIL_NO_UPDATE_CHECK: '1', ...env },
  });
}
