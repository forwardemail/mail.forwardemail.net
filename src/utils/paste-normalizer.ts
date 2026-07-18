/**
 * WebKit paste normalizer.
 *
 * When a copy is written to the clipboard from JavaScript (ProseMirror does
 * this in the compose editor), WebKit inspects the plain text and, if it looks
 * like a "scheme:value" URI (any text with a colon and no whitespace before
 * it, e.g. "foo: bar"), synthesizes an extra text/uri-list clipboard entry
 * with spaces percent-encoded ("foo:%20bar"). Pasting into a plain input then
 * inserts the percent-encoded form instead of the text the user copied.
 *
 * Same bug as VSCode Web on Safari (microsoft/vscode#235666). Same fix: when
 * the uri-list entry decodes to exactly the plain-text entry, it is a
 * synthesized duplicate, so paste the plain text instead. Real URL pastes are
 * unaffected because their uri-list and plain-text entries agree before
 * decoding.
 */

/**
 * Returns the plain-text clipboard entry when the paste also carries a
 * WebKit-synthesized uri-list duplicate of it, otherwise null.
 */
export function getSpuriousUriListPlainText(data: DataTransfer | null): string | null {
  if (!data) return null;
  let uriList = '';
  let plain = '';
  try {
    uriList = data.getData('text/uri-list');
    plain = data.getData('text/plain');
  } catch {
    return null;
  }
  if (!uriList || !plain) return null;
  if (uriList === plain) return null;
  try {
    if (decodeURIComponent(uriList) === plain) return plain;
  } catch {
    // Malformed percent sequence, so this is not a synthesized duplicate.
  }
  return null;
}

function isTextEntryElement(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return ['text', 'search', 'url', 'tel', 'password', 'email'].includes(target.type);
  }
  return false;
}

function insertAtSelection(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  try {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, 'end');
  } catch {
    // Some input types (email) do not support the selection API. Append.
    el.value += text;
  }
  // Svelte bind:value listens for input events on the element.
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Installs a capture-phase paste listener that undoes the synthesized
 * uri-list encoding for pastes into inputs and textareas. Contenteditable
 * targets are left alone since editors read text/html or text/plain
 * themselves. Returns a function that removes the listener.
 */
export function installPasteNormalizer(doc: Document = document): () => void {
  const onPaste = (event: ClipboardEvent) => {
    const target = event.target;
    if (!isTextEntryElement(target)) return;
    if (target.readOnly || target.disabled) return;
    const text = getSpuriousUriListPlainText(event.clipboardData);
    if (text === null) return;
    event.preventDefault();
    insertAtSelection(target, text);
  };
  doc.addEventListener('paste', onPaste, true);
  return () => doc.removeEventListener('paste', onPaste, true);
}
