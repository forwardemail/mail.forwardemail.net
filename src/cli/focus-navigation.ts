/**
 * Where the keyboard goes after a click, and around an open message.
 *
 * A click in TermDOM focuses the focusable element it lands on (or the one
 * around it), and a click on plain content blurs the focused element. A
 * browser does one thing more: the point clicked becomes the starting point
 * of sequential focus navigation, so the next Tab goes to the first
 * focusable element after it, and Shift+Tab to the last one before it.
 * Without that, Tab after a click on the text of a message, a compose window
 * or a settings page went back to the top of the screen. The same goes for a
 * focused element that leaves the page along with the part around it (a menu
 * item that closes its menu): a browser starts from where it was.
 *
 * So while nothing has the focus, Tab here moves from the last such point,
 * through the elements TermDOM's own Tab visits (the same selector, tabindex
 * 0 and up, laid out, not inert), in document order across the open shadow
 * trees that hold message bodies. With something focused, or no point, Tab
 * is TermDOM's.
 *
 * A click on a label focuses its control, as in a browser; TermDOM toggles a
 * checkbox or radio button from its label text but leaves the focus behind.
 *
 * Opening a message (a click on its row, Enter on the row, ↓ or ↑) moves the
 * keyboard into it: the row gives up the focus, and Tab goes through the
 * message's controls (‹ ☆ ⊟ ✖ …), not through the rows of a list that is no
 * longer on screen. Going back to the list (Esc, ‹) focuses the row of the
 * message that was open, so ↓ and ↑ go on from there (the mailbox counts
 * from the focused row when no message is open). A compose window that
 * closes hands the keyboard back to where it was before the window opened.
 */
import { isTextField } from './keys';
import type { AnyRecord } from './types';

interface Point {
  parent: AnyRecord;
  next: AnyRecord | null;
}

// Tab works the point out when it comes, since the page may change in between.
type LazyPoint = () => Point | null;

// What TermDOM's Tab visits (FOCUSABLE_SELECTOR in @b9g/termdom).
const FOCUSABLE =
  'a[href], input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), details > summary:first-of-type, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

const READER = '[data-testid="reader-pane"]';
// The ⋯ button of the message header, there whenever a message is open.
const MESSAGE_ACTIONS = `${READER} button[aria-label="Message actions"]`;
const ROW = '[data-conversation-row]';
const COMPOSE = '[data-testid="compose-modal"]';
// Layers that look after their own focus.
const LAYERS = `[role="dialog"], [role="alertdialog"], dialog[open], ${COMPOSE}, #fe-terminal-original`;

function isShown(el: AnyRecord | null): boolean {
  const rect = el?.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function tabIndexOf(el: AnyRecord): number {
  const value = parseInt(el.getAttribute('tabindex') || '0', 10);
  return Number.isNaN(value) ? 0 : value;
}

// The point at the start of an element, or before one with nothing in it.
function pointAtStart(el: AnyRecord): Point | null {
  if (el.firstChild && !el.closest?.('svg')) return { parent: el, next: el.firstChild };
  return el.parentNode ? { parent: el.parentNode, next: el } : null;
}

// Where a node taken out of `parent` was, between `before` and `after`, as a
// browser's range keeps it: content put in at that place later comes after
// the point.
function pointWhere(parent: AnyRecord | null, before: AnyRecord | null, after: AnyRecord | null) {
  return (): Point | null => {
    if (!parent?.isConnected) return null;
    if (!before) return { parent, next: parent.firstChild };
    if (before.parentNode === parent) return { parent, next: before.nextSibling };
    return { parent, next: after?.parentNode === parent ? after : null };
  };
}

/**
 * The element Tab (or Shift+Tab, `back`) moves to from a point, following
 * TermDOM's order: positive tabindex values first, then the rest in document
 * order, the contents of an open shadow tree in place of its host's
 * children. Like TermDOM, a move from a point passes over positive tabindex
 * values going forward, and wraps around at either end.
 */
export function focusableFrom(document: AnyRecord, point: Point, back = false): AnyRecord | null {
  const before: AnyRecord[] = [];
  const after: AnyRecord[] = [];
  let passed = false;
  const visitAll = (parent: AnyRecord, nodes: Iterable<AnyRecord>) => {
    for (const node of nodes) {
      if (parent === point.parent && node === point.next) passed = true;
      visit(node);
    }
    if (parent === point.parent && point.next === null) passed = true;
  };
  const visit = (node: AnyRecord) => {
    if (node.nodeType !== 1 || node.hasAttribute('inert')) return;
    const shadow = node.shadowRoot;
    if (node.matches(FOCUSABLE) && tabIndexOf(node) >= 0 && node.getClientRects().length > 0) {
      (passed ? after : before).push(node);
    }
    if (shadow) {
      // A host with a negative tabindex keeps Tab out of its tree.
      if (tabIndexOf(node) >= 0) visitAll(shadow, Array.from(shadow.childNodes));
      return;
    }
    if (node.localName === 'slot') {
      const assigned = node.assignedNodes?.() ?? [];
      visitAll(node, assigned.length > 0 ? assigned : Array.from(node.childNodes));
      return;
    }
    visitAll(node, Array.from(node.childNodes));
  };
  if (document.documentElement) visit(document.documentElement);

  const positive = (el: AnyRecord) => tabIndexOf(el) > 0;
  const order = [...before, ...after];
  const ranked = [
    ...order.filter(positive).sort((a, b) => tabIndexOf(a) - tabIndexOf(b)),
    ...order.filter((el) => !positive(el)),
  ];
  if (back) {
    return (
      before.filter((el) => !positive(el)).at(-1) ??
      ranked.filter(positive).at(-1) ??
      ranked.at(-1) ??
      null
    );
  }
  return after.find((el) => !positive(el)) ?? ranked[0] ?? null;
}

export function installFocusNavigation(win: AnyRecord) {
  const document = win.document as AnyRecord;

  // ── The starting point ─────────────────────────────────────────────────

  let startingPoint: LazyPoint | null = null;
  // The element with the focus, kept to tell when it leaves the page.
  let holder: AnyRecord | null = null;

  const focused = (): AnyRecord | null => {
    const active = document.activeElement;
    return active && active !== document.body && active !== document.documentElement
      ? active
      : null;
  };

  win.addEventListener(
    'focusin',
    (event: AnyRecord) => {
      // Tab moves on from the element with the focus.
      startingPoint = null;
      holder = event.target;
    },
    true,
  );
  win.addEventListener('focusout', () => (holder = null), true);

  win.addEventListener(
    'mousedown',
    (event: AnyRecord) => {
      if (event.button !== 0) return;
      // The innermost element, inside a message body's shadow tree too.
      let target = event.composedPath?.()[0] ?? event.target;
      if (target?.nodeType !== 1) target = target?.parentElement ?? event.target;
      if (!target || target.nodeType !== 1) return;
      // An SVG drawing is one piece.
      for (let svg = target.closest?.('svg'); svg; svg = svg.parentElement?.closest?.('svg')) {
        target = svg;
      }
      const gone = pointWhere(target.parentNode, target.previousSibling, target.nextSibling);
      const previous = startingPoint;
      startingPoint = () => {
        // A press the page turned down (the scroll bars, the hint bar) leaves
        // the point where it was.
        if (event.defaultPrevented) return previous?.() ?? null;
        // A target gone with the click (a menu's backdrop): where it was.
        return target.isConnected ? pointAtStart(target) : gone();
      };
    },
    true,
  );

  win.addEventListener(
    'keydown',
    (event: AnyRecord) => {
      if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
      if (focused() || !startingPoint) return;
      const point = startingPoint();
      startingPoint = null;
      // A modal <dialog> limits Tab to itself; TermDOM looks after that.
      if (!point || document.querySelector('dialog[open]')) return;
      if (point.next && point.next.parentNode !== point.parent) point.next = null;
      const target = focusableFrom(document, point, Boolean(event.shiftKey));
      if (!target) return;
      event.preventDefault();
      target.focus();
      target.scrollIntoView?.({ block: 'nearest' });
    },
    true,
  );

  // A label's text focuses its control, unless the click focused something
  // itself (a dialog it opened).
  win.addEventListener('click', (event: AnyRecord) => {
    if (event.defaultPrevented || event.button !== 0 || focused()) return;
    const target = event.target;
    const label = target?.closest?.('label');
    const control = label?.control;
    if (!control || control.disabled) return;
    // A link or a control inside the label takes its own click.
    const own = target.closest('a[href], button, input, select, textarea, [tabindex]');
    if (own && own !== label && label.contains(own)) return;
    control.focus();
  });

  // The focused element left the page, with its parent or on its own: Tab
  // starts from where it was. Removals come in order, so one that takes the
  // remembered place along moves the point out to its own place.
  const followRemovals = (records: AnyRecord[]) => {
    if (!holder || holder.isConnected || focused()) return;
    let inside: AnyRecord = holder;
    let place: LazyPoint | null = null;
    for (const record of records) {
      for (const node of record.removedNodes ?? []) {
        if (node === inside || node.contains?.(inside)) {
          place = pointWhere(record.target, record.previousSibling, record.nextSibling);
          inside = record.target;
        }
      }
    }
    holder = null;
    if (place) startingPoint = place;
  };

  // ── The open message ───────────────────────────────────────────────────

  let open = false;
  // The list row of the message on screen.
  let openRow: string | null = null;

  const selectedRow = (): string | null => {
    const rows = [...document.querySelectorAll(`${ROW}[aria-selected="true"]`)];
    return rows.length === 1 ? rows[0].getAttribute('data-message-id') : null;
  };

  // The keyboard goes into the message, unless it is somewhere of its own:
  // in the message already, in a text field, a dialog or a compose window.
  const enterMessage = () => {
    const active = focused();
    if (active) {
      if (active.closest?.(READER) || isTextField(active) || active.closest?.(LAYERS)) return;
      active.blur();
    }
    startingPoint = () => {
      const reader = document.querySelector(READER);
      return reader ? pointAtStart(reader) : null;
    };
  };

  // Back in the list: the row of the message that was open, unless the
  // focus went somewhere else on purpose (a folder, the search box).
  const returnToRow = (id: string | null) => {
    if (focused() || id === null) return;
    const row = [...document.querySelectorAll(ROW)].find(
      (el: AnyRecord) => el.getAttribute('data-message-id') === id,
    );
    if (!row || !isShown(row)) return;
    row.focus();
    row.scrollIntoView?.({ block: 'nearest' });
  };

  const followMessage = () => {
    const actions = document.querySelector(MESSAGE_ACTIONS);
    if (!actions && !open) return;
    const now = isShown(actions);
    if (now) {
      const row = selectedRow();
      if (!open || (row !== null && row !== openRow)) enterMessage();
      if (row !== null) openRow = row;
    } else if (open) {
      const row = openRow;
      openRow = null;
      returnToRow(row);
    }
    open = now;
  };

  // ── Compose windows ────────────────────────────────────────────────────

  // What had the keyboard when the window opened.
  let beforeCompose: { element: AnyRecord | null; point: LazyPoint | null } | null = null;

  const followCompose = () => {
    const compose = document.querySelector(COMPOSE);
    if (compose && !beforeCompose) {
      const active = focused();
      beforeCompose = {
        element: active && !compose.contains(active) ? active : null,
        point: startingPoint,
      };
    } else if (!compose && beforeCompose) {
      const { element, point } = beforeCompose;
      beforeCompose = null;
      if (focused()) return;
      if (element?.isConnected && isShown(element)) element.focus();
      else if (point) startingPoint = point;
    }
  };

  new win.MutationObserver((records: AnyRecord[]) => {
    // The hint bar redraws on its own; that changes nothing here.
    const bar = document.getElementById('fe-terminal-hints');
    if (bar && records.every((record) => bar.contains(record.target))) return;
    followRemovals(records);
    followMessage();
    followCompose();
  }).observe(document.documentElement, { childList: true, subtree: true });
}
