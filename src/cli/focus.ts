/**
 * Whether the terminal is the window in use, for document.hasFocus().
 *
 * The webmail shows new mail as a toast while its window has the focus and
 * as a system notification otherwise (utils/notification-manager.js). A
 * terminal says when its window gains and loses the focus once asked to
 * (focus reporting, CSI ? 1004 h): it sends ESC [ I and ESC [ O. Those are
 * taken out of the input here, before TermDOM reads it as keys.
 *
 * Terminals that do not report focus (and tmux without `focus-events on`)
 * count as away after IDLE_MS without a key press or mouse event.
 */
import fs from 'node:fs';
import type { AnyRecord } from './types';

export const IDLE_MS = 2 * 60 * 1000;

const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';
// eslint-disable-next-line no-control-regex -- terminal reports start with ESC
const REPORTS = /\x1b\[[IO]/g;

export interface FocusOptions {
  /** Where focus reporting is turned on and off (the terminal). */
  output?: { write(text: string): unknown; fd?: number };
  input?: NodeJS.ReadStream;
  now?: () => number;
}

export function installFocus(win: AnyRecord, options: FocusOptions = {}) {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const now = options.now ?? Date.now;

  // null until the terminal has sent a report.
  let reported: boolean | null = null;
  let lastInput = now();
  let wasFocused = true;

  const focused = () => (reported === null ? now() - lastInput < IDLE_MS : reported);

  const announce = () => {
    const next = focused();
    if (next === wasFocused) return;
    wasFocused = next;
    win.dispatchEvent(new win.Event(next ? 'focus' : 'blur'));
  };

  // The reports are removed from what TermDOM (and keys.ts) receive.
  const emit = input.emit;
  input.emit = function (this: NodeJS.ReadStream, event: string | symbol, ...args: unknown[]) {
    if (event !== 'data') return emit.call(this, event, ...args);
    const chunk = args[0];
    let text = typeof chunk === 'string' ? chunk : null;
    if (text === null && Buffer.isBuffer(chunk) && chunk.includes('\x1b[')) {
      text = chunk.toString('utf8');
    }
    // Pasted text (bracketed paste) is left as it is, whatever it contains.
    const isPaste = text !== null && text.includes('\x1b[200~');
    if (text !== null && !isPaste && (text.includes(FOCUS_IN) || text.includes(FOCUS_OUT))) {
      for (const match of text.matchAll(REPORTS)) reported = match[0] === FOCUS_IN;
      const rest = text.replace(REPORTS, '');
      // A report that came alone is not input from the user.
      if (rest) lastInput = now();
      setImmediate(announce);
      return rest ? emit.call(this, event, rest, ...args.slice(1)) : true;
    }
    // Back from being idle: the app hears it, as from a focus report.
    if (reported === null && wasFocused && !focused()) wasFocused = false;
    lastInput = now();
    if (!wasFocused) setImmediate(announce);
    return emit.call(this, event, ...args);
  } as typeof input.emit;

  // Without reports, going idle is noticed here.
  const timer = setInterval(announce, 10_000);
  timer.unref?.();

  Object.defineProperty(win.document, 'hasFocus', {
    configurable: true,
    writable: true,
    value: focused,
  });

  output.write('\x1b[?1004h');
  process.on('exit', () => {
    try {
      if (typeof output.fd === 'number') fs.writeSync(output.fd, '\x1b[?1004l');
      else output.write('\x1b[?1004l');
    } catch {
      // the terminal is gone
    }
  });

  return { focused };
}
