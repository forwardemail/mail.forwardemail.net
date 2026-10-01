/**
 * Centers overlays that the webmail centers with a transform.
 *
 * Dialogs sit at top: 50%; left: 50% and pull themselves back by half their
 * size with translate(-50%, -50%). TermDOM has no transforms (the build drops
 * them), so such a dialog would start at the middle of the screen and run off
 * its edges. Here each one is given the top and left that the transform would
 * have produced, measured from its laid-out size, so what is drawn and what
 * receives clicks stay in the same place.
 */
import { PX_PER_COLUMN, PX_PER_ROW } from './px-to-cells.js';
import type { AnyRecord } from './types';

interface Rule {
  selector: string;
  x: boolean;
  y: boolean;
}

const RULES: Rule[] = [
  // Every shadcn dialog (keyboard shortcuts, confirmations, settings dialogs).
  { selector: '[data-slot="dialog-content"]', x: true, y: true },
  // Bottom-anchored prompts centered horizontally (the mailto handler
  // prompt); the toast list shares the class but sits in the corner.
  { selector: '.fe-bottom-overlay[class~="-translate-x-1/2"]', x: true, y: false },
];

export function installCentering(win: AnyRecord) {
  const document = win.document as AnyRecord;
  let scheduled = false;

  const place = () => {
    scheduled = false;
    const width = Number(win.innerWidth) * PX_PER_COLUMN;
    const height = Number(win.innerHeight) * PX_PER_ROW;
    if (!(width > 0 && height > 0)) return;
    for (const { selector, x, y } of RULES) {
      for (const el of document.querySelectorAll(selector) as Iterable<AnyRecord>) {
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) continue;
        // Whole cells, so the result does not drift by rounding.
        if (x) {
          const left = Math.max(
            0,
            Math.floor((width - rect.width) / 2 / PX_PER_COLUMN) * PX_PER_COLUMN,
          );
          if (el.style.left !== `${left}px`) el.style.left = `${left}px`;
        }
        if (y) {
          const top = Math.max(0, Math.floor((height - rect.height) / 2 / PX_PER_ROW) * PX_PER_ROW);
          if (el.style.top !== `${top}px`) el.style.top = `${top}px`;
        }
      }
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // After the app's update has been laid out.
    setTimeout(place, 0);
  };

  // Svelte rewrites a dialog's style attribute when its props change, which
  // drops the position set here, so style changes are watched too. Writing
  // the same values again is skipped, which ends the cycle.
  new win.MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
  win.addEventListener('resize', schedule);
}
