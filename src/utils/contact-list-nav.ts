// Keyboard and pointer helpers for the contact list.

/**
 * The contact above (step -1) or below (step 1) the selected one. With nothing
 * selected, or the selection filtered out of the list, the first or last
 * contact. At either end, null: the selection stays put rather than wrapping.
 */
export function adjacentContact<T extends { id?: unknown }>(
  list: readonly T[],
  selectedId: unknown,
  step: 1 | -1,
): T | null {
  if (!list.length) return null;
  const idx = selectedId == null ? -1 : list.findIndex((c) => c.id === selectedId);
  if (idx < 0) return step > 0 ? list[0] : list[list.length - 1];
  const next = idx + step;
  return next >= 0 && next < list.length ? list[next] : null;
}

type KeyLike = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
};

const isTyping = (target: EventTarget | null | undefined) => {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null | undefined;
  if (!el || typeof el !== 'object') return false;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(el.isContentEditable);
};

/** Which way a key press moves the selection, or null when it is not ours. */
export function listArrowStep(event: KeyLike): 1 | -1 | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (isTyping(event.target)) return null;
  if (event.key === 'ArrowDown') return 1;
  if (event.key === 'ArrowUp') return -1;
  return null;
}

/**
 * A click that opens the contact's menu instead of selecting it: Command-click
 * on a Mac. Control-click is left alone; macOS already turns it into a
 * right-click, which opens the menu through the contextmenu event.
 */
export function opensContactMenu(event: { metaKey?: boolean; button?: number }) {
  return Boolean(event.metaKey) && (event.button ?? 0) === 0;
}
