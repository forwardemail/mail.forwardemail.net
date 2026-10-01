/**
 * Text areas that grow with their text.
 *
 * The app's text areas use field-sizing: content: in a browser the compose
 * body grows as lines are added, and the compose window scrolls around it.
 * TermDOM keeps a text area at its first height and draws the rest of the
 * text past its border, where it cannot be scrolled to. Here each text area
 * with field-sizing: content is given a minimum height that fits its text,
 * and the box that scrolls around it is scrolled to keep the caret in view,
 * as a browser does while typing. The text's rows are counted by wrapping
 * it the way the engine wraps a text area, which is much cheaper than
 * laying out a copy of it on every key.
 *
 * Lengths read from computed styles are in cells. Element sizes reach
 * scripts in virtual pixels (viewport.ts) and are divided back; the inline
 * minimum height is written in virtual pixels, which viewport.ts converts.
 */
import { PX_PER_COLUMN as X, PX_PER_ROW as Y } from './px-to-cells.js';
import type { AnyRecord } from './types';

const cells = (value: string) => Number.parseFloat(value) || 0;

// Columns a character takes: two for wide East Asian characters and emoji,
// none for combining marks and joiners.
function charWidth(code: number) {
  if (code < 0x300) return 1;
  if ((code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f))
    return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2;
  return 1;
}

const TAB_SIZE = 8;

/**
 * Rows `text` takes in a column `width` cells wide, wrapped as white-space:
 * pre-wrap with overflow-wrap: break-word wraps it. A line breaks at a
 * space, which may hang past the edge, at a tab, which moves to the next
 * stop of eight, and between wide characters, which are words of their
 * own; a word longer than the line breaks inside it.
 */
export function wrappedRows(text: string, width: number) {
  if (width < 1) return 1;
  let rows = 0;
  for (const line of text.split('\n')) {
    rows++;
    let column = 0;
    let word = 0;
    const place = () => {
      if (word === 0) return;
      if (column > 0 && column + word > width) {
        rows++;
        column = 0;
      }
      if (word > width) {
        const extra = Math.ceil(word / width) - 1;
        rows += extra;
        column = word - extra * width;
      } else column += word;
      word = 0;
    };
    for (const char of line) {
      if (char === ' ') {
        place();
        column++;
      } else if (char === '\t') {
        place();
        let stop = TAB_SIZE - (column % TAB_SIZE);
        if (column > 0 && column + stop > width) {
          rows++;
          column = 0;
          stop = TAB_SIZE;
        }
        column += stop;
      } else {
        const charColumns = charWidth(char.codePointAt(0)!);
        if (charColumns === 2) {
          place();
          word = 2;
          place();
        } else word += charColumns;
      }
    }
    place();
  }
  return Math.max(1, rows);
}

export function installTextareaSizing(win: AnyRecord) {
  const document = win.document as AnyRecord;
  // The minimum height each text area had before one was set here.
  const baseline = new WeakMap<AnyRecord, number>();
  const sized = new WeakMap<AnyRecord, string>();

  // The build drops field-sizing from the stylesheet, so the app's utility
  // class is read as well as the property.
  const grows = (el: AnyRecord) =>
    el.classList.contains('field-sizing-content') ||
    win.getComputedStyle(el).getPropertyValue('field-sizing').trim() === 'content';

  const contentWidth = (el: AnyRecord, computed: AnyRecord) =>
    Math.round(el.clientWidth / X - cells(computed.paddingLeft) - cells(computed.paddingRight));

  const size = (el: AnyRecord) => {
    if (!el.isConnected || !grows(el)) return;
    const computed = win.getComputedStyle(el);
    const width = contentWidth(el, computed);
    if (width < 1) return;
    const key = `${width}\u0000${el.value}`;
    if (sized.get(el) === key) return;
    sized.set(el, key);
    if (!baseline.has(el)) baseline.set(el, cells(computed.minHeight));
    const chrome =
      (el.offsetHeight - el.clientHeight) / Y +
      cells(computed.paddingTop) +
      cells(computed.paddingBottom);
    const rows = Math.max(baseline.get(el)!, wrappedRows(String(el.value ?? ''), width) + chrome);
    const minHeight = `${Math.round(rows) * Y}px`;
    if (el.style.minHeight !== minHeight) el.style.minHeight = minHeight;
  };

  const scroller = (el: AnyRecord) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflow = win.getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight)
        return node;
    }
    return null;
  };

  // Scrolls the box around a focused text area so the caret's row shows.
  const reveal = (el: AnyRecord) => {
    if (document.activeElement !== el || !grows(el)) return;
    const box = scroller(el);
    if (!box) return;
    const computed = win.getComputedStyle(el);
    const width = contentWidth(el, computed);
    if (width < 1) return;
    const caret = Number(el.selectionEnd ?? String(el.value ?? '').length);
    const caretRow = wrappedRows(String(el.value ?? '').slice(0, caret), width) - 1;
    const top =
      (el.getBoundingClientRect().top - box.getBoundingClientRect().top) / Y -
      box.clientTop / Y +
      Number(box.scrollTop) +
      el.clientTop / Y +
      cells(computed.paddingTop);
    const row = Math.round(top + caretRow);
    const view = Math.round(box.clientHeight / Y);
    const scrollTop = Number(box.scrollTop);
    if (row < scrollTop) box.scrollTop = row;
    else if (row > scrollTop + view - 1) box.scrollTop = row - view + 1;
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    for (const el of document.querySelectorAll('textarea')) size(el);
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(run, 50);
  };
  const isTextarea = (target: AnyRecord) => target?.localName === 'textarea';
  // Once more after the engine's frame, for a paste the engine applies
  // and draws in one go.
  const settle = (target: AnyRecord) => setTimeout(() => reveal(target), 0);

  // Typing sizes the text area and scrolls to the caret before the engine
  // draws the frame, so the frame shows the caret.
  win.addEventListener(
    'input',
    (event: AnyRecord) => {
      const target = event.target;
      if (!isTextarea(target)) return;
      queueMicrotask(() => {
        size(target);
        reveal(target);
      });
      settle(target);
    },
    true,
  );
  // Keys that move the caret without typing, after their default action.
  const MOVES = /^(Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End)$/;
  win.addEventListener(
    'keydown',
    (event: AnyRecord) => {
      const target = event.target;
      if (!isTextarea(target) || !MOVES.test(event.key)) return;
      queueMicrotask(() => reveal(target));
      settle(target);
    },
    true,
  );
  win.addEventListener(
    'focusin',
    (event: AnyRecord) => {
      const target = event.target;
      if (!isTextarea(target)) return;
      size(target);
      settle(target);
    },
    true,
  );
  // A text area the app fills in (a reply's quote) or that changes width.
  win.addEventListener('resize', schedule, true);
  new win.MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  schedule();
  return { run };
}
