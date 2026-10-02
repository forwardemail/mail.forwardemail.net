/**
 * Copying the selection with the keyboard.
 *
 * The client takes the mouse for clicks and scrolling, so the terminal's own
 * selection needs a modifier (Option in iTerm2, Fn in Terminal.app, Shift in
 * most others). Dragging over text selects it in the app instead. A drag no
 * longer copies on its own: while anything is selected the hint bar shows
 * "Ctrl+C Copy", and Ctrl+C copies the selection to the system clipboard
 * through the terminal's clipboard sequence (OSC 52), which reaches it even
 * over SSH, the way tmux does. With nothing selected, Ctrl+C quits, but asks
 * first ("Quit Forward Email?"), so a mistaken press does not drop the
 * session.
 *
 * Ctrl+C arrives as data in raw mode, where the engine asks the window to
 * close. That close is cancelable through `beforeunload`, so a selection turns
 * the key press into a copy, and a quit is held until it is confirmed; both
 * keep the app open. Everything else (an external SIGINT, the pipe ending)
 * bypasses the window and still exits. The
 * OSC 52 is written straight to the output, as the pointer shape is in
 * pointer.ts, because the close is not dispatched as a key press and so
 * navigator.clipboard's user-gesture gate would reject it.
 */
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

/** The OSC 52 sequence that puts `text` on the system clipboard. */
export function clipboardSequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

export function installClipboard(
  win: AnyRecord,
  options: {
    output?: { write(text: string): unknown };
    // Asked before Ctrl+C quits with nothing selected; false keeps the app
    // open. Left out where there is nothing to ask with (a passed transport),
    // so Ctrl+C quits at once there, as it always has.
    confirmQuit?: () => boolean;
  } = {},
) {
  const document = win.document as AnyRecord;
  const output = options.output ?? process.stdout;
  const notice = (detail: string) =>
    win.dispatchEvent(new win.CustomEvent('fe-terminal-notice', { detail }));

  // The hint bar flips "Ctrl+C Quit" to "Ctrl+C Copy" from this.
  let active = false;
  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    win.dispatchEvent(new win.CustomEvent('fe-terminal-selection', { detail: { active } }));
  };
  const refresh = () => setActive(Boolean(selectedText(win).trim()));

  // Writing the clipboard sequence straight to the terminal, not through
  // navigator.clipboard: this runs outside a dispatched key press, which that
  // API requires. Returns whether the terminal took it.
  const copy = (): boolean => {
    const text = selectedText(win);
    if (!text.trim()) return false;
    try {
      output.write(clipboardSequence(text));
    } catch {
      notice('Could not copy: the terminal is not reachable');
      return false;
    }
    // Clearing the selection both confirms the copy and returns Ctrl+C to
    // quitting, so a second press leaves.
    try {
      win.getSelection?.()?.removeAllRanges?.();
    } catch {
      // no selection to clear
    }
    setActive(false);
    notice('Copied');
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
