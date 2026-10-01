/**
 * Copying text with the mouse.
 *
 * The client takes the mouse for clicks and scrolling, so the terminal's own
 * selection needs a modifier (Option in iTerm2, Fn in Terminal.app, Shift in
 * most others). Dragging over text selects it in the app instead, and
 * releasing the button copies it to the clipboard, the way terminal
 * programs such as tmux do: through the terminal's clipboard sequence
 * (OSC 52), which reaches the system clipboard even over SSH. The hint bar
 * says when it did.
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

export function installClipboard(win: AnyRecord) {
  let last = '';
  const notice = (detail: string) =>
    win.dispatchEvent(new win.CustomEvent('fe-terminal-notice', { detail }));
  // Written while the release is being handled: the terminal's clipboard is
  // only reachable from a user action, as in a browser.
  win.addEventListener(
    'mouseup',
    () => {
      const text = selectedText(win);
      if (!text.trim()) {
        last = '';
        return;
      }
      if (text === last) return;
      last = text;
      let written: Promise<unknown>;
      try {
        written = Promise.resolve(win.navigator.clipboard.writeText(text));
      } catch (error) {
        written = Promise.reject(error);
      }
      written.then(
        () => notice('Copied'),
        () => notice('Could not copy: the terminal is not reachable'),
      );
    },
    true,
  );
}
