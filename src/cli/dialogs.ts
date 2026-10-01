/**
 * window.confirm(), window.prompt() and window.alert() in the terminal.
 *
 * TermDOM answers confirm() with false and prompt() with null, without
 * showing anything, so a question such as Settings' "Delete label?" or
 * "Complete Reset" was cancelled before it was asked. These dialogs are
 * modal in a browser too: they stop the page until they are answered.
 * Here the question takes the bottom row and the keys are read straight
 * from the terminal until it is answered:
 *
 *   confirm  Delete label "Work"?   y Yes   n No
 *   prompt   Link URL: https://…_   Enter OK   Esc Cancel
 *   alert    Something happened.   Enter OK
 *
 * The page is drawn again afterwards.
 */
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { AnyRecord } from './types';

export interface DialogTerminal {
  /** Columns and rows of the terminal. */
  size(): { columns: number; rows: number };
  /** Writes to the terminal at once. */
  write(text: string): void;
  /**
   * What the terminal sends next: waits up to `wait` ms (forever by
   * default) and gives '' if nothing came.
   */
  readKeys(wait?: number): string;
  /** Hands the terminal's replies read during a dialog back to the app. */
  passOn(replies: string): void;
  /** Has the page drawn again over the row the dialog used. */
  redraw(): void;
}

const ESC = '\x1b';
const KEY = '\x1b[1m';
const RESET = '\x1b[0m';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// How long the rest of a sequence split between two reads is waited for.
const SPLIT_WAIT = 50;

// A message on one line.
const oneLine = (text: unknown) =>
  String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();

/** The process's own terminal, read synchronously. */
export function processTerminal(): DialogTerminal {
  const buffer = Buffer.alloc(4096);
  const decoder = new StringDecoder('utf8');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  return {
    size: () => ({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    write: (text) => {
      try {
        fs.writeSync(1, text);
      } catch {
        // the terminal is gone
      }
    },
    readKeys(wait = Infinity) {
      // A Windows console never says EAGAIN: a read waits for a key. Only a
      // read that may wait is made there.
      if (wait !== Infinity && process.platform === 'win32') return '';
      const until = Date.now() + wait;
      for (;;) {
        try {
          const read = fs.readSync(0, buffer, 0, buffer.length, null);
          if (read > 0) return decoder.write(buffer.subarray(0, read));
          if (read === 0) return ESC;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') return ESC;
          if (Date.now() >= until) return '';
          // A non-blocking terminal: wait a moment and look again.
          Atomics.wait(pause, 0, 0, Math.min(15, Math.max(1, until - Date.now())));
        }
      }
    },
    // After the dialog, so focus.ts and TermDOM hear them as if just sent.
    passOn: (replies) =>
      void setImmediate(() => process.stdin.emit('data', Buffer.from(replies, 'utf8'))),
    // TermDOM draws everything again after a resize.
    redraw: () => void (process as NodeJS.EventEmitter).emit('SIGWINCH'),
  };
}

type Input =
  | { key: string }
  // Pasted text, as one piece.
  | { paste: string }
  // A reply from the terminal (cursor position, focus, clipboard, …).
  | { reply: string };

// Replies the app or TermDOM asked for, which are handed back after the
// dialog: cursor position (R), focus in and out (I, O), device attributes
// (c), mode reports ($y) and window sizes (t).
const isReply = (csi: string) =>
  // eslint-disable-next-line no-control-regex -- terminal replies start with ESC
  /^\x1b\[(?:[0-9;]*[RIO]|[?>][0-9;]*c|[0-9;?]*\$y|[0-9;]*t)$/.test(csi);

/**
 * Splits what the terminal sent into keys, pastes and replies. Mouse reports
 * and other sequences are dropped. A sequence cut off at the end is left in
 * `rest` for the next read, or read as typed when `final`.
 */
export function inputsOf(input: string, final = false): { inputs: Input[]; rest: string } {
  const inputs: Input[] = [];
  let i = 0;
  const cutOff = () => ({ inputs, rest: input.slice(i) });
  while (i < input.length) {
    if (input.startsWith(PASTE_START, i)) {
      const end = input.indexOf(PASTE_END, i + PASTE_START.length);
      if (end === -1 && !final) return cutOff();
      const stop = end === -1 ? input.length : end;
      inputs.push({ paste: input.slice(i + PASTE_START.length, stop) });
      i = end === -1 ? stop : end + PASTE_END.length;
      continue;
    }
    if (input[i] !== ESC) {
      const char = String.fromCodePoint(input.codePointAt(i)!);
      inputs.push({ key: char });
      i += char.length;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) {
      if (!final) return cutOff();
      inputs.push({ key: ESC });
      i++;
    } else if (next === '[') {
      let end = i + 2;
      while (end < input.length && !/[@-~]/.test(input[end])) end++;
      if (end >= input.length && !final) return cutOff();
      const sequence = input.slice(i, end + 1);
      if (isReply(sequence)) inputs.push({ reply: sequence });
      i = end + 1;
    } else if (next === ']' || next === 'P' || next === '_') {
      // A string ended by BEL or ESC \: a clipboard (OSC 52) or other reply.
      const bel = input.indexOf('\x07', i + 2);
      const st = input.indexOf('\x1b\\', i + 2);
      const ends = [bel === -1 ? Infinity : bel + 1, st === -1 ? Infinity : st + 2];
      const end = Math.min(...ends);
      if (end === Infinity && !final) return cutOff();
      const stop = end === Infinity ? input.length : end;
      inputs.push({ reply: input.slice(i, stop) });
      i = stop;
    } else if (next === 'O') {
      // SS3: a function or arrow key, one more character.
      if (i + 2 >= input.length && !final) return cutOff();
      i += 3;
    } else if (next === ESC) {
      // Esc pressed twice.
      inputs.push({ key: ESC });
      i++;
    } else {
      // Alt with a key: not an answer to anything here.
      i += 1 + String.fromCodePoint(input.codePointAt(i + 1)!).length;
    }
  }
  return { inputs, rest: '' };
}

export function installNativeDialogs(win: AnyRecord, terminal: DialogTerminal = processTerminal()) {
  // Draws `text` and then `tail` (the keys) on the bottom row, the start of
  // a long text cut off, with the cursor at the end of the text.
  const show = (parts: { text: string; tail: string }) => {
    const { columns, rows } = terminal.size();
    // eslint-disable-next-line no-control-regex -- the keys are drawn bold
    const tailWidth = parts.tail.replace(/\x1b\[[0-9;]*m/g, '').length;
    // A space before, two between and the last column left empty, so the
    // row cannot wrap and scroll the screen.
    const room = Math.max(1, columns - tailWidth - 4);
    const text =
      parts.text.length > room ? `…${parts.text.slice(parts.text.length - room + 1)}` : parts.text;
    // Line wrapping is off while the row is written, for the same reason.
    terminal.write(
      `\x1b[?7l\x1b[?25h\x1b[${rows};1H\x1b[2K ${text}  ${parts.tail}\x1b[?7h\x1b[${rows};${text.length + 2}H`,
    );
  };
  // Replies from the terminal read while a dialog is open, and the part of
  // a sequence split between two reads.
  let replies = '';
  let rest = '';
  const keep = (inputs: Input[]) =>
    inputs.filter((input) => {
      if ('reply' in input) replies += input.reply;
      return !('reply' in input);
    });
  // What was typed before the question appeared (a second Enter, a key
  // repeat) is meant for the page, not for the question: it is dropped.
  const drain = () => {
    // A bounded look: a closed terminal answers every read at once.
    for (let reads = 0; reads < 64; reads++) {
      const text = terminal.readKeys(0);
      if (!text) break;
      rest += text;
    }
    keep(inputsOf(rest, true).inputs);
    rest = '';
  };
  // The next keys or paste, waiting for them.
  const next = (): Input[] => {
    for (;;) {
      const text = terminal.readKeys(rest ? SPLIT_WAIT : undefined);
      const read = inputsOf(rest + text, text === '');
      rest = read.rest;
      const inputs = keep(read.inputs);
      if (inputs.length) return inputs;
    }
  };
  const done = () => {
    terminal.write('\x1b[?25l');
    terminal.redraw();
    if (replies) terminal.passOn(replies);
    replies = '';
  };

  // Enter is not an answer: a destructive question (Delete label, Complete
  // Reset) takes a deliberate y, and pasted text answers nothing.
  const ask = (message: unknown): boolean => {
    drain();
    show({ text: oneLine(message), tail: `${KEY}y${RESET} Yes   ${KEY}n${RESET} No` });
    try {
      for (;;) {
        for (const input of next()) {
          if (!('key' in input)) continue;
          if (input.key === 'y' || input.key === 'Y') return true;
          if (['n', 'N', ESC, '\x03'].includes(input.key)) return false;
        }
      }
    } finally {
      done();
    }
  };

  const promptFor = (message: unknown, initial: unknown): string | null => {
    const label = oneLine(message);
    let value = initial === undefined || initial === null ? '' : String(initial);
    const tail = `${KEY}Enter${RESET} OK   ${KEY}Esc${RESET} Cancel`;
    drain();
    try {
      for (;;) {
        show({ text: `${label ? `${label} ` : ''}${value}`, tail });
        for (const input of next()) {
          // Pasted text is typed as it is, on one line.
          if ('paste' in input) {
            // eslint-disable-next-line no-control-regex
            value += input.paste.replace(/\r\n?|\n/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
            continue;
          }
          if (!('key' in input)) continue;
          const { key } = input;
          if (key === '\r' || key === '\n') return value;
          if (key === ESC || key === '\x03') return null;
          if (key === '\x7f' || key === '\b') value = [...value].slice(0, -1).join('');
          else if (key === '\x15') value = '';
          else if (key >= ' ') value += key;
        }
      }
    } finally {
      done();
    }
  };

  const tell = (message: unknown) => {
    drain();
    show({ text: oneLine(message), tail: `${KEY}Enter${RESET} OK` });
    try {
      for (;;) {
        const keys = next().flatMap((input) => ('key' in input ? [input.key] : []));
        if (keys.some((key) => key === '\r' || key === ' ' || key === ESC || key === '\x03'))
          return;
      }
    } finally {
      done();
    }
  };

  for (const [name, value] of [
    ['confirm', (message?: unknown) => ask(message)],
    ['prompt', (message?: unknown, initial?: unknown) => promptFor(message, initial)],
    ['alert', (message?: unknown) => tell(message)],
  ] as const) {
    Object.defineProperty(win, name, { configurable: true, writable: true, value });
  }
}
