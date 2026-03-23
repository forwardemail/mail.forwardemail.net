import { writable } from 'svelte/store';
import { mount, unmount } from 'svelte';
import Toasts from './components/Toasts.svelte';

export function createToastHost(target) {
  if (!target) {
    console.warn('[toastsHost] No target element provided');
    return {
      show: () => {},
      dismiss: () => {},
      destroy: () => {},
      items: {
        subscribe: (run) => {
          run([]);
          return () => {};
        },
      },
    };
  }

  const items = writable([]);
  const timeouts = new Map();
  let nextId = 1;

  const dismiss = (id) => {
    if (id == null) {
      timeouts.forEach((timer) => clearTimeout(timer));
      timeouts.clear();
      items.set([]);
      return;
    }
    const timer = timeouts.get(id);
    if (timer) clearTimeout(timer);
    timeouts.delete(id);
    items.update((list) => list.filter((toast) => toast.id !== id));
  };

  const show = (message, type = 'info', timeoutOrOptions = 5000, action = null) => {
    if (!message) return null;
    let timeout = 5000;
    let resolvedAction = action;
    if (typeof timeoutOrOptions === 'number') {
      timeout = timeoutOrOptions;
    } else if (timeoutOrOptions && typeof timeoutOrOptions === 'object') {
      if (typeof timeoutOrOptions.duration === 'number') {
        timeout = timeoutOrOptions.duration;
      } else if (typeof timeoutOrOptions.timeout === 'number') {
        timeout = timeoutOrOptions.timeout;
      }
      if (!resolvedAction && timeoutOrOptions.action) {
        resolvedAction = timeoutOrOptions.action;
      }
    }
    // Always show a single toast at a time.
    dismiss();
    const id = (nextId += 1);
    items.set([{ id, message, type, action: resolvedAction }]);
    // duration 0 = persistent (no auto-dismiss)
    const duration = timeout === 0 ? 0 : Math.max(5000, Number(timeout) || 5000);
    if (duration > 0) {
      const timer = setTimeout(() => dismiss(id), duration);
      timeouts.set(id, timer);
    }
    return id;
  };

  // Use Svelte 5 mount API
  const component = mount(Toasts, {
    target,
    props: { items, dismiss },
  });

  const destroy = () => {
    timeouts.forEach((timer) => clearTimeout(timer));
    timeouts.clear();
    unmount(component);
  };

  return { show, dismiss, destroy, items };
}
