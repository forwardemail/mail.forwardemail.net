/**
 * Svelte action that moves an element to document.body.
 *
 * A `position: fixed` element inside the app shell is still subject to its
 * ancestors' stacking contexts and overflow clipping. The mailbox columns each
 * create one (the sidebar sits above the reader column), so a fixed bar owned
 * by the reader painted underneath the sidebar at the bottom-left of the
 * window. Hoisting the node to body takes it out of every ancestor context.
 * Scoped component styles still apply: the class hash is on the element.
 */
export function portal(node: HTMLElement, target: HTMLElement | null = null) {
  const host = target ?? (typeof document !== 'undefined' ? document.body : null);
  if (!host) return {};
  host.appendChild(node);
  return {
    destroy() {
      if (node.parentNode === host) host.removeChild(node);
    },
  };
}
