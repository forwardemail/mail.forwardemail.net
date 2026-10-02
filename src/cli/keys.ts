/**
 * Keyboard behavior a terminal needs on top of the webmail's own.
 *
 * Esc as "back", the way terminal programs use it.
 *
 * The webmail closes dialogs and menus on Esc, but an open message, the
 * settings page or a contact is left with the mouse (the ‹ button). Here an
 * Esc that nothing else used, pressed outside a text field with no dialog or
 * menu open, first clicks empty space (closing the mailbox's own menus,
 * which close on an outside click) and, if that closed nothing, presses the
 * innermost visible back button.
 */
import type { AnyRecord } from './types';

// Innermost first: a message before its mailbox, a contact before the list.
const BACK_BUTTONS = [
  'button[aria-label="Back to list"]',
  'button[aria-label="Back to contacts"]',
  'button[aria-label="Back"]',
  'button[aria-label="Back to mailbox"]',
  'button[aria-label="Back to Mailbox"]',
];

// Open layers that Esc belongs to. Menus and listboxes count only when they
// float: the message list itself is a listbox.
const OVERLAYS =
  '[role="dialog"], [role="alertdialog"], dialog[open], [data-testid="compose-modal"]';
const POPUPS = '[role="menu"], [role="listbox"]';

// What an Esc can close: floating menus, the mailbox's own dropdowns and the
// empty full-screen backdrops some menus are drawn over.
const MENU_LIKE =
  '[role="menu"], [role="listbox"], .fe-dropdown-fixed, [data-sort-dropdown], [data-labels-dropdown], [data-filters-dropdown], .fixed.inset-0, [data-bits-floating-content-wrapper]';

function isFloating(el: AnyRecord): boolean {
  if (el.closest?.('[data-bits-floating-content-wrapper]')) return true;
  const position = el.ownerDocument.defaultView.getComputedStyle(el).position;
  return position === 'fixed' || position === 'absolute';
}

function isShown(el: AnyRecord): boolean {
  const rect = el.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

// Inputs that are not typed into; Esc on a focused radio or checkbox still
// goes back.
const NON_TEXT_INPUTS = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
  'hidden',
]);

export function isTextField(el: AnyRecord | null): boolean {
  if (!el) return false;
  const tag = String(el.localName ?? '');
  if (tag === 'input') return !NON_TEXT_INPUTS.has(String(el.type ?? 'text').toLowerCase());
  return tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

const COMPOSE = '[data-testid="compose-modal"]';

// How long after a compose window appears typed characters wait for its
// first field. The app focuses it once the editor is set up, which takes a
// moment longer in a terminal than in a browser.
const COMPOSE_TYPE_AHEAD_MS = 3000;

// Keys that act on the selected message in the mailbox and carry no text.
const HELD_BACK = new Set(['Enter', 'Backspace', 'Delete']);

// The shortcut actions that open a compose window.
const COMPOSE_ACTIONS = new Set(['new-message', 'reply', 'reply-all', 'reply-list', 'forward']);

interface ShortcutManager {
  getShortcutsList(): Array<{ originalKey: string; action: string; sequence?: boolean }>;
  captureInProgress?: boolean;
}

// A key press written the way the shortcut manager stores it: ctrl+n,
// shift+r, f.
function comboOf(event: AnyRecord): string {
  const key = String(event.key);
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey && key.length === 1 && key !== key.toLowerCase()) parts.push('shift');
  parts.push(key.toLowerCase());
  return parts.join('+');
}

// Whether this key press is bound (as the user has it now) to a shortcut
// that opens a compose window.
function opensCompose(event: AnyRecord): boolean {
  if (event.metaKey) return false;
  const manager = (globalThis as Record<string, unknown>).__forwardemailShortcuts as
    | ShortcutManager
    | undefined;
  if (!manager) return false;
  const combo = comboOf(event);
  return manager
    .getShortcutsList()
    .some(
      (shortcut) =>
        !shortcut.sequence &&
        COMPOSE_ACTIONS.has(shortcut.action) &&
        shortcut.originalKey.replace(/\s+/g, '') === combo,
    );
}

function rebinding(): boolean {
  const manager = (globalThis as Record<string, unknown>).__forwardemailShortcuts as
    | ShortcutManager
    | undefined;
  return Boolean(manager?.captureInProgress);
}

// How long a compose shortcut waits for its window before the keys typed
// meanwhile are given back to the mailbox (the shortcut did not apply).
const COMPOSE_APPEAR_MS = 1000;

// What a terminal sends for the keys that are held, or given back.
const KEY_BYTES: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
};

/**
 * Type-ahead for a compose window that is opening. Keys typed between a
 * compose shortcut (or the window appearing) and the window's first field
 * taking focus would reach the mailbox's one-key shortcuts (e archives,
 * Delete deletes) instead of the message. They are held and then typed
 * again, through the terminal input like any key press: the characters into
 * the window's first field once it has focus (the To field, or the editor of
 * a reply), with Enter, Backspace and Delete dropped. If no compose window
 * appears after the shortcut, all held keys are typed again as they were,
 * so nothing is lost when the shortcut did not apply.
 */
function installComposeTypeAhead(win: AnyRecord) {
  const document = win.document as AnyRecord;
  // 'waiting': a compose shortcut was pressed; 'open': the window is there
  // but has no focus yet.
  let state: 'off' | 'waiting' | 'open' = 'off';
  let held: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wasOpen = false;
  // Key presses still to come from a retype, which are let through.
  let retyping = 0;

  const reset = () => {
    state = 'off';
    held = [];
    clearTimeout(timer);
  };
  // Types keys again through the terminal input, as if pressed now.
  const retype = (keys: string[]) => {
    if (keys.length === 0) return;
    retyping += keys.length;
    process.stdin.emit('data', Buffer.from(keys.map((key) => KEY_BYTES[key] ?? key).join('')));
    // The terminal input decodes and dispatches a chunk within the current
    // task; whatever did not come back as a key press is not waited for.
    setImmediate(() => {
      retyping = 0;
    });
  };
  // No compose window came: the keys go to whatever they were meant for.
  const giveBack = () => {
    const keys = held;
    reset();
    retype(keys);
  };
  const enter = (next: 'waiting' | 'open') => {
    state = next;
    clearTimeout(timer);
    timer = setTimeout(
      next === 'waiting' ? giveBack : reset,
      next === 'waiting' ? COMPOSE_APPEAR_MS : COMPOSE_TYPE_AHEAD_MS,
    );
    timer.unref?.();
  };

  new win.MutationObserver(() => {
    const open = document.querySelector(COMPOSE) !== null;
    if (open && !wasOpen) enter('open');
    if (!open && wasOpen) reset();
    wasOpen = open;
  }).observe(document.documentElement, { childList: true, subtree: true });

  win.addEventListener(
    'keydown',
    (event: AnyRecord) => {
      if (retyping > 0) {
        retyping--;
        return;
      }
      const key = String(event.key);
      if (state === 'off') {
        const dialogOpen = [
          ...document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
        ].some(isShown);
        if (
          opensCompose(event) &&
          !isTextField(event.target) &&
          !document.querySelector(COMPOSE) &&
          !dialogOpen &&
          !rebinding()
        ) {
          enter('waiting');
        }
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const compose = document.querySelector(COMPOSE);
      if (compose?.contains(document.activeElement)) return;
      if (state === 'waiting') {
        // Typing into a field of the page (the shortcut did nothing), or a
        // key that is not typing (an arrow, Tab, Esc): the user has moved
        // on, so everything goes back now, this key last, in order.
        if (isTextField(document.activeElement) || (key.length !== 1 && !HELD_BACK.has(key))) {
          if (key.length === 1 || KEY_BYTES[key]) {
            held.push(key);
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          giveBack();
          return;
        }
      } else if (key.length !== 1 && !HELD_BACK.has(key)) {
        return;
      }
      held.push(key);
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  document.addEventListener('focusin', (event: AnyRecord) => {
    const compose = document.querySelector(COMPOSE);
    const field = event.target;
    if (state === 'off' || !compose?.contains(field)) return;
    // Characters only: Enter, Delete and the like are dropped here.
    const text = held.filter((key) => key.length === 1);
    reset();
    // Once the focus has settled in the field.
    if (isTextField(field)) setTimeout(() => retype(text), 0);
  });
}

export function installKeys(win: AnyRecord) {
  const document = win.document as AnyRecord;
  installComposeTypeAhead(win);

  // Every key press, to tell whether another one followed an Esc.
  let presses = 0;
  win.addEventListener('keydown', () => presses++, true);

  // Capture phase on the window runs before any of the app's handlers, so it
  // sees what was open when the key was pressed.
  win.addEventListener(
    'keydown',
    (event: AnyRecord) => {
      if (event.key !== 'Escape' || event.ctrlKey || event.altKey || event.metaKey) return;
      if (isTextField(event.target)) return;
      // Dialogs close on Esc themselves; a compose window is not closed by it.
      if ([...document.querySelectorAll(OVERLAYS)].some(isShown)) return;
      const popupOpen = [...document.querySelectorAll(POPUPS)].some(
        (el) => isShown(el) && isFloating(el),
      );
      // Keys read in one burst are dispatched one after the other before
      // this runs; if another followed the Esc (Esc, then Ctrl+N), what it
      // started is not undone by closing or going back.
      const press = presses;
      // After the app's own handlers have had the event.
      queueMicrotask(() => {
        if (event.defaultPrevented || presses !== press) return;
        // Menus that close on a click elsewhere: the mailbox's dropdowns
        // (sort, labels, the message's actions) and those drawn over an
        // empty full-screen backdrop (the account menu). That click comes
        // first; only when nothing was open does Esc go back.
        const backdrop = [...document.querySelectorAll('.fixed.inset-0')]
          .filter((el) => el.childElementCount === 0 && isShown(el))
          .pop();
        const openMenus = () =>
          [...document.querySelectorAll(MENU_LIKE)].filter((el) => {
            if (!isShown(el)) return false;
            const role = el.getAttribute('role');
            if (role === 'menu' || role === 'listbox') return isFloating(el);
            if (el.matches('.fixed.inset-0')) return el.childElementCount === 0;
            return true;
          }).length;
        const goBack = () => {
          for (const selector of BACK_BUTTONS) {
            const button = [...document.querySelectorAll(selector)].find(isShown);
            if (button) {
              button.click();
              return;
            }
          }
        };
        const before = openMenus();
        // Nothing open to close: straight back.
        if (before === 0 && !popupOpen) {
          goBack();
          return;
        }
        // The whole sequence a real click makes: some menus close on
        // pointerdown (a backdrop), others on click (a document listener).
        const target = backdrop ?? document.body;
        const Pointer = win.PointerEvent ?? win.MouseEvent;
        const init = { bubbles: true, cancelable: true, button: 0 };
        target.dispatchEvent(new Pointer('pointerdown', init));
        target.dispatchEvent(new win.MouseEvent('mousedown', init));
        target.dispatchEvent(new Pointer('pointerup', init));
        target.dispatchEvent(new win.MouseEvent('mouseup', init));
        target.dispatchEvent(new win.MouseEvent('click', init));
        setTimeout(() => {
          if (openMenus() < before || popupOpen || presses !== press) return;
          goBack();
        }, 0);
      });
    },
    true,
  );
}
