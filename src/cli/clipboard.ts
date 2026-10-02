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

const TEXT_NODE = 3;

function textNodesIn(root: AnyRecord, out: AnyRecord[] = []): AnyRecord[] {
  for (const child of Array.from((root.shadowRoot ?? root).childNodes as AnyRecord[])) {
    if (child.nodeType === TEXT_NODE) out.push(child);
    else textNodesIn(child, out);
  }
  return out;
}

/**
 * The selected text. Selection.toString() leaves out text in shadow trees,
 * where message bodies are drawn (frames.ts), so that is read here.
 */
export function selectedText(win: AnyRecord): string {
  const selection = win.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
  try {
    const text = String(selection.toString());
    if (text) return text;
  } catch {
    // read below
  }
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!anchorNode || !focusNode) return '';
  if (anchorNode === focusNode && anchorNode.nodeType === TEXT_NODE) {
    const [start, end] = [anchorOffset, focusOffset].sort((a, b) => a - b);
    return String(anchorNode.nodeValue ?? '').slice(start, end);
  }
  const root = anchorNode.getRootNode?.();
  if (!root || root !== focusNode.getRootNode?.()) return '';
  const nodes = textNodesIn(root);
  let from = nodes.indexOf(anchorNode);
  let to = nodes.indexOf(focusNode);
  let fromOffset = anchorOffset;
  let toOffset = focusOffset;
  if (from === -1 || to === -1) return '';
  if (from > to) {
    [from, to] = [to, from];
    [fromOffset, toOffset] = [toOffset, fromOffset];
  }
  let text = '';
  for (let i = from; i <= to; i++) {
    const value = String(nodes[i].nodeValue ?? '');
    text += value.slice(i === from ? fromOffset : 0, i === to ? toOffset : value.length);
  }
  return text;
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
    const text = selectedText(win);
    if (!text.trim()) return false;
    if (copying) return true;
    copying = true;
    copyText(text)
      .finally(() => {
        copying = false;
      })
      .then(
        () => {
          if (selectedText(win) === text) {
            try {
              win.getSelection?.()?.removeAllRanges?.();
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

  // Keep the hint in step with what is selected.
  document.addEventListener('selectionchange', refresh);
  win.addEventListener('mouseup', refresh, true);
  win.addEventListener('keyup', refresh, true);
}
