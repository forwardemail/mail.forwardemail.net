/**
 * Scroll bars.
 *
 * TermDOM scrolls a box with overflow: auto but draws no scroll bar, so
 * nothing on screen said that the message list, a message, the compose body
 * or a settings page had more below. Each box that can scroll gets a bar one
 * column wide over its right edge: the track (│) is the box's whole length
 * and the thumb (█) is the part on screen.
 *
 *   Clicking the track scrolls a page toward the click.
 *   Dragging the thumb scrolls with it.
 *   The wheel over the bar scrolls the box.
 *
 * The bars are drawn from what the engine lays out, in cells. Element sizes
 * reach scripts in virtual pixels (viewport.ts), so they are divided back
 * here, and the inline lengths written are virtual pixels that viewport.ts
 * converts back to whole cells. Scroll offsets are in cells throughout.
 */
import { PX_PER_COLUMN as X, PX_PER_ROW as Y } from './px-to-cells.js';
import type { AnyRecord } from './types';

const TRACK = '│';
const THUMB = '█';
// Rows the wheel scrolls per notch, as the engine scrolls a box.
const WHEEL_ROWS = 3;

interface Placement {
  col: number;
  top: number;
  rows: number;
  thumbTop: number;
  thumbRows: number;
}

/** Where the thumb sits in a track of `rows`, for a box scrolled `scrollTop` of `total`. */
export function thumbPlacement(rows: number, view: number, total: number, scrollTop: number) {
  const thumbRows = Math.min(rows, Math.max(1, Math.round((rows * view) / total)));
  const range = total - view;
  const fraction = range > 0 ? Math.min(1, Math.max(0, scrollTop / range)) : 0;
  // A box scrolled at all shows its thumb off the top, and one not at the
  // end shows it off the bottom, so the bar never claims an end too early.
  let thumbTop = Math.round(fraction * (rows - thumbRows));
  if (scrollTop > 0 && thumbTop === 0 && rows > thumbRows) thumbTop = 1;
  if (fraction < 1 && thumbTop === rows - thumbRows && thumbTop > 0) thumbTop -= 1;
  return { thumbTop, thumbRows };
}

export function installScrollbars(win: AnyRecord) {
  const document = win.document as AnyRecord;
  const layer = document.createElement('div');
  layer.id = 'fe-terminal-scrollbars';
  const bars = new Map<AnyRecord, { bar: AnyRecord; thumb: AnyRecord; key: string }>();
  let drag: { scroller: AnyRecord; startRow: number; startTop: number; perRow: number } | null =
    null;

  const style = (el: AnyRecord) => win.getComputedStyle(el);
  const scrolls = (value: string) => value === 'auto' || value === 'scroll';

  // Whether the box, and not something over it, shows at a row. The cell
  // tested is the one left of the bar; a bar found there is an inner box's,
  // which sits inside this one.
  const showsAt = (el: AnyRecord, col: number, row: number) => {
    const hit = document.elementFromPoint((col - 0.5) * X, (row + 0.5) * Y);
    return Boolean(hit) && (hit === el || el.contains(hit) || layer.contains(hit));
  };

  // The rows of `el` left on screen inside the boxes that clip it, or null
  // when they clip its last column.
  const visibleRows = (el: AnyRecord, col: number, top: number, bottom: number) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      const computed = style(node);
      if (computed.overflowY === 'visible' && computed.overflowX === 'visible') continue;
      const rect = node.getBoundingClientRect();
      const left = rect.left / X + node.clientLeft / X;
      if (col < left || col >= left + node.clientWidth / X) return null;
      const nodeTop = rect.top / Y + node.clientTop / Y;
      top = Math.max(top, nodeTop);
      bottom = Math.min(bottom, nodeTop + node.clientHeight / Y);
    }
    return [Math.max(0, top), Math.min(Number(win.innerHeight), bottom)];
  };

  const measure = (el: AnyRecord): Placement | null => {
    const view = Math.round(el.clientHeight / Y);
    const total = Math.round(el.scrollHeight / Y);
    if (view < 2 || total <= view) return null;
    if (!scrolls(style(el).overflowY)) return null;
    const rect = el.getBoundingClientRect();
    const width = el.clientWidth / X;
    if (width < 2) return null;
    const col = Math.round(rect.left / X + el.clientLeft / X + width) - 1;
    const boxTop = Math.round(rect.top / Y + el.clientTop / Y);
    if (col < 1 || col >= Number(win.innerWidth)) return null;
    const visible = visibleRows(el, col, boxTop, boxTop + view);
    if (!visible) return null;
    const [top, bottom] = visible;
    if (bottom - top < 2) return null;
    // A menu, dialog or compose window over the box hides its bar: the bar
    // keeps to the longest run of rows where the box is what shows. Rows
    // are tested from the ends and the middle in, and between two rows
    // that agree the rows are taken to agree, as overlays are rectangles.
    const first = Math.round(top);
    const last = Math.round(bottom) - 1;
    const shown = new Map<number, boolean>();
    const test = (row: number) => {
      if (!shown.has(row)) shown.set(row, showsAt(el, col, row));
      return shown.get(row)!;
    };
    const fill = (from: number, to: number) => {
      if (to - from < 2) return;
      if (test(from) === test(to) && to - from <= 8) {
        for (let row = from + 1; row < to; row++) shown.set(row, shown.get(from)!);
        return;
      }
      const middle = Math.floor((from + to) / 2);
      test(middle);
      fill(from, middle);
      fill(middle, to);
    };
    fill(first, last);
    test(first);
    test(last);
    let run = { top: 0, rows: 0 };
    let start = -1;
    for (let row = first; row <= last + 1; row++) {
      if (row <= last && test(row)) {
        if (start === -1) start = row;
      } else if (start !== -1) {
        if (row - start > run.rows) run = { top: start, rows: row - start };
        start = -1;
      }
    }
    if (run.rows < 2) return null;
    return {
      col,
      top: run.top,
      rows: run.rows,
      ...thumbPlacement(run.rows, view, total, Number(el.scrollTop)),
    };
  };

  const create = (scroller: AnyRecord) => {
    const bar = document.createElement('div');
    bar.className = 'fe-scrollbar';
    bar.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('div');
    thumb.className = 'fe-scrollbar-thumb';
    bar.append(thumb);
    // A press must not move the focus or start a text selection.
    bar.addEventListener('mousedown', (event: AnyRecord) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== 0) return;
      const row = Math.floor(Number(event.clientY) / Y);
      const thumbRect = thumb.getBoundingClientRect();
      const thumbTop = Math.round(thumbRect.top / Y);
      const thumbRows = Math.round(thumbRect.height / Y);
      if (row >= thumbTop && row < thumbTop + thumbRows) {
        const barRows = Math.round(bar.getBoundingClientRect().height / Y);
        const range = scroller.scrollHeight / Y - scroller.clientHeight / Y;
        const travel = Math.max(1, barRows - thumbRows);
        drag = {
          scroller,
          startRow: row,
          startTop: Number(scroller.scrollTop),
          perRow: range / travel,
        };
      } else {
        const page = Math.max(1, Math.round(scroller.clientHeight / Y) - 1);
        scroller.scrollTop = Number(scroller.scrollTop) + (row < thumbTop ? -page : page);
      }
    });
    bar.addEventListener('wheel', (event: AnyRecord) => {
      event.preventDefault();
      const delta = Number(event.deltaY);
      if (delta) scroller.scrollTop = Number(scroller.scrollTop) + Math.sign(delta) * WHEEL_ROWS;
    });
    return { bar, thumb, key: '' };
  };

  // Boxes whose overflow lets them scroll, found as elements are added or
  // restyled; whether one has more than it shows is checked on each update.
  const candidates = new Set<AnyRecord>();
  const consider = (el: AnyRecord) => {
    if (layer.contains(el)) return;
    if (scrolls(style(el).overflowY)) candidates.add(el);
    else candidates.delete(el);
  };
  const discover = (root: AnyRecord) => {
    if (root.nodeType !== 1) return;
    consider(root);
    for (const el of root.querySelectorAll('*')) consider(el);
  };

  const update = () => {
    const found = new Map<AnyRecord, Placement>();
    for (const el of candidates) {
      if (!el.isConnected) {
        candidates.delete(el);
        continue;
      }
      if (el.scrollHeight <= el.clientHeight) continue;
      const placement = measure(el);
      if (placement) found.set(el, placement);
    }
    for (const [scroller, entry] of bars) {
      if (!found.has(scroller)) {
        entry.bar.remove();
        bars.delete(scroller);
      }
    }
    for (const [scroller, place] of found) {
      let entry = bars.get(scroller);
      if (!entry) {
        entry = create(scroller);
        bars.set(scroller, entry);
        layer.append(entry.bar);
      }
      const key = JSON.stringify(place);
      if (key === entry.key) continue;
      entry.key = key;
      const { bar, thumb } = entry;
      bar.style.left = `${place.col * X}px`;
      bar.style.top = `${place.top * Y}px`;
      bar.style.height = `${place.rows * Y}px`;
      bar.textContent = '';
      bar.append(TRACK.repeat(place.rows).split('').join('\n'), thumb);
      thumb.style.top = `${place.thumbTop * Y}px`;
      thumb.style.height = `${place.thumbRows * Y}px`;
      thumb.textContent = THUMB.repeat(place.thumbRows).split('').join('\n');
    }
  };

  // A scroll redraws its bar on the next frame. Typing and other changes
  // redraw them once things have been quiet for a moment, and at least
  // once a second while they go on, so the bars cost nothing per key.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let urgent = false;
  let waitingSince = 0;
  const schedule = (delay: number, now: boolean) => {
    const time = Date.now();
    // An update for the next frame is already coming.
    if (timer && urgent) return;
    if (!timer) waitingSince = time;
    const at = now ? time + delay : Math.min(time + delay, waitingSince + 1000);
    if (timer) clearTimeout(timer);
    urgent = now;
    timer = setTimeout(
      () => {
        timer = null;
        urgent = false;
        update();
      },
      Math.max(0, at - time),
    );
  };
  const soon = () => schedule(16, true);
  const settled = () => schedule(150, false);

  win.addEventListener(
    'mousemove',
    (event: AnyRecord) => {
      if (!drag) return;
      // A release the terminal never reported ends the drag.
      if (!(Number(event.buttons) & 1)) {
        drag = null;
        return;
      }
      const row = Math.floor(Number(event.clientY) / Y);
      drag.scroller.scrollTop = Math.round(drag.startTop + (row - drag.startRow) * drag.perRow);
    },
    true,
  );
  win.addEventListener('mouseup', () => (drag = null), true);
  document.addEventListener('scroll', soon, true);
  // Media queries can make other boxes scroll at the new size.
  win.addEventListener(
    'resize',
    () => {
      discover(document.documentElement);
      soon();
    },
    true,
  );
  for (const type of ['input', 'keyup', 'focusin']) win.addEventListener(type, settled, true);
  new win.MutationObserver((records: AnyRecord[]) => {
    let changed = false;
    for (const record of records) {
      if (layer.contains(record.target)) continue;
      changed = true;
      // A class on an ancestor can make the boxes inside it scroll.
      if (record.type === 'attributes') discover(record.target);
      else for (const node of record.addedNodes) discover(node);
    }
    if (changed) settled();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  document.documentElement.append(layer);
  discover(document.documentElement);
  soon();
  return { update };
}
