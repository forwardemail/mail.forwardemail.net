/**
 * window.confirm(), prompt() and alert() in the terminal: drawn on the
 * bottom row and answered from the keys typed, through a stand-in for the
 * terminal that records what was written and replays what was typed.
 */
import { TermDOM } from '@b9g/termdom';
import { describe, expect, it } from 'vitest';
import { installNativeDialogs } from '../../src/cli/dialogs';

// `typed` arrives one read at a time once the question is up; `before` was
// typed before it appeared and is already waiting.
function fakeTerminal(typed, { size = { columns: 60, rows: 10 }, before = [] } = {}) {
  const queue = [...typed];
  const waiting = [...before];
  const written = [];
  const passedOn = [];
  let redraws = 0;
  return {
    written,
    passedOn,
    redraws: () => redraws,
    terminal: {
      size: () => size,
      write: (text) => written.push(text),
      readKeys: (wait = Infinity) => {
        // Looking without waiting sees only what is already there.
        if (wait === 0) return waiting.shift() ?? '';
        if (queue.length) return queue.shift();
        if (wait !== Infinity) return '';
        throw new Error('read past what was typed');
      },
      passOn: (replies) => passedOn.push(replies),
      redraw: () => redraws++,
    },
  };
}

function windowWith(terminal) {
  const win = new TermDOM({ html: '<body></body>' }).window;
  installNativeDialogs(win, terminal);
  return win;
}

// The bottom row as drawn: the last text written, without escapes.
const row = (written) =>
  written
    .at(-1)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .trimEnd();

describe('confirm()', () => {
  it('asks on the bottom row and answers y as yes, n and Esc as no', () => {
    for (const [keys, answer] of [
      [['y'], true],
      [['\r', 'n'], false],
      [['n'], false],
      [['\x1b'], false],
    ]) {
      const fake = fakeTerminal(keys);
      const win = windowWith(fake.terminal);
      expect(win.confirm('Delete label "Work"?')).toBe(answer);
      expect(row(fake.written.slice(0, 1))).toBe(' Delete label "Work"?  y Yes   n No');
      // The page is drawn again over the row.
      expect(fake.redraws()).toBe(1);
    }
  });

  it('ignores mouse reports and other keys until it is answered', () => {
    const fake = fakeTerminal(['\x1b[<0;5;5M\x1b[<0;5;5m', 'x', '\x1b[A', 'n']);
    expect(windowWith(fake.terminal).confirm('Sure?')).toBe(false);
  });

  it('takes no answer from keys typed before it was asked, or from a paste', () => {
    // A second Enter and a y meant for the page behind it.
    const early = fakeTerminal(['n'], { before: ['\r', 'y'] });
    expect(windowWith(early.terminal).confirm('Complete Reset?')).toBe(false);
    const pasted = fakeTerminal(['\x1b[200~yes\r\x1b[201~', 'n']);
    expect(windowWith(pasted.terminal).confirm('Delete?')).toBe(false);
  });

  it('hands the terminal its replies back instead of reading them as keys', () => {
    // Focus in, a cursor position and a clipboard reply (OSC 52), which starts
    // with Esc but is not the Esc key.
    const replies = '\x1b[I\x1b[12;5R\x1b]52;c;aGk=\x07';
    const fake = fakeTerminal([replies, 'y']);
    expect(windowWith(fake.terminal).confirm('Sure?')).toBe(true);
    expect(fake.passedOn).toEqual([replies]);
  });

  it('keeps a long question to one row, showing its end', () => {
    const fake = fakeTerminal(['n']);
    windowWith(fake.terminal).confirm(`Delete ${'very '.repeat(30)}long name?`);
    const drawn = row(fake.written.slice(0, 1));
    // The last column stays empty, so the row cannot wrap and scroll.
    expect(drawn.length).toBeLessThan(60);
    expect(drawn).toContain('long name?  y Yes   n No');
    expect(drawn.trimStart().startsWith('…')).toBe(true);
  });
});

describe('prompt()', () => {
  it('edits a line from the default and returns it on Enter', () => {
    const fake = fakeTerminal(['/a', '\x7f\x7f\x7f', 'example', '\r']);
    expect(windowWith(fake.terminal).prompt('Link URL', 'https://x')).toBe('https://example');
    expect(row(fake.written.slice(0, 1))).toBe(' Link URL https://x  Enter OK   Esc Cancel');
  });

  it('returns null on Esc and takes pasted text as typed', () => {
    const cancelled = fakeTerminal(['abc', '\x1b']);
    expect(windowWith(cancelled.terminal).prompt('Name')).toBeNull();
    const pasted = fakeTerminal(['\x1b[200~hello\nworld\x1b[201~', '\r']);
    expect(windowWith(pasted.terminal).prompt('Name')).toBe('hello world');
  });

  it('reads a sequence split between two reads as one', () => {
    // A paste and a mouse report, each cut in two.
    const fake = fakeTerminal(['a\x1b[20', '0~b\r\x1b[2', '01~\x1b[<35;1', '2;5Mc', '\r']);
    expect(windowWith(fake.terminal).prompt('Name')).toBe('ab c');
    // An Esc at the end of a read with nothing after it is the Esc key.
    expect(windowWith(fakeTerminal(['abc\x1b']).terminal).prompt('Name')).toBeNull();
  });
});

describe('alert()', () => {
  it('shows the message until Enter', () => {
    const fake = fakeTerminal(['x', '\r']);
    expect(windowWith(fake.terminal).alert('Saved.')).toBeUndefined();
    expect(row(fake.written.slice(0, 1))).toBe(' Saved.  Enter OK');
  });
});
