/**
 * Toast surface opacity.
 *
 * Toasts float over arbitrary mailbox content, so their surface must be
 * opaque. They once used bg-state-*\/10 - a 90%-transparent wash that was
 * unreadable over content, worst in light mode on mobile. The tint now
 * layers over an opaque bg-popover base via a flat gradient; these tests
 * pin that the base is present and the translucent-background pattern
 * cannot quietly return.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import Toasts from '../../src/svelte/components/Toasts.svelte';

// jsdom has no Web Animations API, which Svelte's fade transition drives.
// The stub never fires onfinish; the element simply stays mid-intro, which is
// fine - these tests assert classes, not animation completion.
if (!Element.prototype.animate) {
  Element.prototype.animate = (() => ({
    onfinish: null,
    oncancel: null,
    cancel() {},
    finish() {},
    finished: Promise.resolve(),
  })) as unknown as typeof Element.prototype.animate;
}

afterEach(cleanup);

const renderToasts = (types: (string | undefined)[]) =>
  render(Toasts, {
    props: {
      items: readable(
        types.map((type, index) => ({ id: `t${index}`, message: `msg ${index}`, type })),
      ),
    },
  });

describe('<Toasts />', () => {
  it('gives every variant an opaque elevated base', () => {
    renderToasts(['success', 'error', 'warning', 'info', undefined]);

    const toasts = screen.getAllByTestId('toast');
    expect(toasts).toHaveLength(5);
    for (const toast of toasts) {
      expect(toast.className).toContain('bg-popover');
      // The old translucent pattern: a bg-* utility carrying /10 alpha as the
      // ONLY background. With the opaque base, tints live on the gradient
      // (from-*/to-*), never on bg-*.
      expect(toast.className).not.toMatch(/(?:^|\s)bg-[a-z-]+\/\d+/);
    }
  });

  it('keeps the per-type tint and text color', () => {
    renderToasts(['success']);
    const toast = screen.getByTestId('toast');

    expect(toast.className).toContain('from-state-success/10');
    expect(toast.className).toContain('text-state-success');
  });
});
