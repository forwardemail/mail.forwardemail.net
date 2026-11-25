/**
 * The clipboard: the app's copy buttons, and copying the selection with the
 * keyboard.
 *
 * navigator.clipboard.writeText and write, which the app's "Click to copy"
 * addresses, Diagnostics and "Copy raw" use, go through system-clipboard.ts:
 * the terminal's clipboard sequence (OSC 52) plus the system's clipboard
 * program, and they reject when the text reached no clipboard, so the app
 * shows "Failed to copy" instead of a false "Copied". As in a browser, they
 * need a click or a key press in the last few seconds.
 *
 * The client takes the mouse for clicks and scrolling, so the terminal's own
 * selection needs a modifier (Option in iTerm2, Fn in Terminal.app, Shift in
 * most others). Dragging over text selects it in the app instead. A drag no
 * longer copies on its own: while anything is selected the hint bar shows
 * "Ctrl+C Copy", and Ctrl+C copies the selection the same way. With nothing
 * selected, Ctrl+C quits, but asks first ("Quit Forward Email?"), so a
 * mistaken press does not drop the session.
 *
 * Ctrl+C arrives as data in raw mode, where the engine asks the window to
 * close. That close is cancelable through `beforeunload`, so a selection turns
 * the key press into a copy, and a quit is held until it is confirmed; both
 * keep the app open. Everything else (an external SIGINT, the pipe ending)
 * bypasses the window and still exits. The close is not a dispatched key
 * press, so the copy calls the writer itself rather than navigator.clipboard,
 * whose user-gesture check would turn it down.
 */
import { createClipboardWriter, type ClipboardOptions } from './system-clipboard';
import type { AnyRecord } from './types';

// The control characters a terminal acts on, all but tab and line feed.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * The selected text, without control characters. TermDOM never draws them,
 * so a message can hold ones the reader does not see, and a copy that kept
 * them could end the bracketed paste of the terminal it is pasted into
 * (ESC [ 201 ~) and have the rest run as typed.
 */
function textOf(selection: AnyRecord | null | undefined): string {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
  try {
    return String(selection.toString()).replace(CONTROLS, '');
  } catch {
    return '';
  }
}

/**
 * The window's selection and those of the same-origin frames in it, where a
 * message body is selected (frames.ts). Each document has its own, as in a
 * browser.
 */
function selections(win: AnyRecord, out: AnyRecord[] = []): AnyRecord[] {
  const selection = win.getSelection?.();
  if (selection) out.push(selection);
  for (const frame of Array.from(
    (win.document?.querySelectorAll?.('iframe') ?? []) as AnyRecord[],
  )) {
    try {
      const child = frame.contentWindow;
      if (child?.document) selections(child, out);
    } catch {
      // a cross-origin frame
    }
  }
  return out;
}

function findSelection(win: AnyRecord): { selection: AnyRecord; text: string } | null {
  for (const selection of selections(win)) {
    const text = textOf(selection);
    if (text.trim()) return { selection, text };
  }
  return null;
}

/** The selected text, in the app or in a message frame. */
export function selectedText(win: AnyRecord): string {
  return findSelection(win)?.text ?? '';
}

/**
 * navigator.clipboard.writeText and write, through `copy`. A browser lets a
 * page write the clipboard within a few seconds of a click or a key press
 * (transient activation), which TermDOM tracks as navigator.userActivation.
 */
export function installClipboardApi(win: AnyRecord, copy: (text: string) => Promise<unknown>) {
  const clipboard = win.navigator?.clipboard;
  if (!clipboard) return;
  const denied = (message: string) =>
    win.DOMException
      ? new win.DOMException(message, 'NotAllowedError')
      : Object.assign(new Error(message), { name: 'NotAllowedError' });
  const allowed = () => {
    const activation = win.navigator.userActivation;
    return activation ? Boolean(activation.isActive) : true;
  };
  const write = (text: string) =>
    copy(text).then(
      () => undefined,
      (error: unknown) => {
        throw denied(`Could not copy: ${(error as Error)?.message ?? error}`);
      },
    );
  const define = (name: string, value: unknown) =>
    Object.defineProperty(clipboard, name, { value, configurable: true, writable: true });

  define('writeText', (text: unknown) =>
    allowed()
      ? write(String(text))
      : Promise.reject(denied('Copying needs a click or a key press first')),
  );
  define('write', async (items: Iterable<AnyRecord>) => {
    if (!allowed()) throw denied('Copying needs a click or a key press first');
    for (const item of items ?? []) {
      if (!Array.from((item?.types ?? []) as string[]).includes('text/plain')) continue;
      const data = await item.getType('text/plain');
      return write(typeof data === 'string' ? data : String(await data.text()));
    }
    throw denied('A clipboard write needs a text/plain entry');
  });
}

export function installClipboard(
  win: AnyRecord,
  options: {
    output?: { write(text: string): unknown };
    // Asked before Ctrl+C quits with nothing selected; false keeps the app
    // open. Left out where there is nothing to ask with (a passed transport),
    // so Ctrl+C quits at once there, as it always has.
    confirmQuit?: () => boolean;
    // The platform, environment and process runner the copy uses (tests).
    clipboard?: Omit<ClipboardOptions, 'output'>;
  } = {},
) {
  const document = win.document as AnyRecord;
  const copyText = createClipboardWriter({ ...options.clipboard, output: options.output });
  installClipboardApi(win, copyText);
  // A notice in place of the hints for a moment (hints.ts), marked as a
  // failure when it reports one.
  const notice = (text: string, failed = false) =>
    win.dispatchEvent(
      new win.CustomEvent('fe-terminal-notice', { detail: failed ? { text, failed } : text }),
    );

  // The hint bar flips "Ctrl+C Quit" to "Ctrl+C Copy" from this.
  let active = false;
  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    win.dispatchEvent(new win.CustomEvent('fe-terminal-selection', { detail: { active } }));
  };
  const refresh = () => setActive(Boolean(selectedText(win).trim()));

  // A copy under way; a Ctrl+C meanwhile starts no second one.
  let copying = false;
  // Copies the selection; returns false with nothing selected. Clearing the
  // selection once the copy succeeds both confirms it and returns Ctrl+C to
  // quitting, so a second press leaves. A failed copy keeps the selection for
  // another try.
  const copy = (): boolean => {
    const found = findSelection(win);
    if (!found) return false;
    const { selection, text } = found;
    if (copying) return true;
    copying = true;
    copyText(text)
      .finally(() => {
        copying = false;
      })
      .then(
        () => {
          if (textOf(selection) === text) {
            try {
              selection.removeAllRanges?.();
            } catch {
              // no selection to clear
            }
            setActive(false);
          }
          notice('Copied');
        },
        (error: unknown) => notice(`Could not copy: ${(error as Error)?.message ?? error}`, true),
      );
    return true;
  };

  // Ctrl+C asks the window to close. A selection cancels that and copies
  // instead; otherwise the quit is confirmed, so a stray press does not drop
  // the session, and goes through only on "Yes".
  win.addEventListener('beforeunload', (event: AnyRecord) => {
    if (selectedText(win).trim()) {
      event.preventDefault();
      copy();
      return;
    }
    if (options.confirmQuit && !options.confirmQuit()) {
      event.preventDefault();
    }
  });

  // The clickable "Ctrl+C Copy" hint (hints.ts) asks for the copy here.
  win.addEventListener('fe-terminal-copy', () => void copy());

  // Keep the hint in step with what is selected, here and in message frames,
  // whose documents send their own events (frames.ts).
  const watch = (target: AnyRecord) => {
    target.addEventListener('selectionchange', refresh);
    target.addEventListener('mouseup', refresh, true);
    target.addEventListener('keyup', refresh, true);
  };
  watch(document);
  win.addEventListener('fe-frame-document', (event: AnyRecord) => {
    if (event.detail?.document) watch(event.detail.document);
  });
}
