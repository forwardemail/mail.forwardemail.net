/**
 * Page loads for the terminal document.
 *
 * TermDOM keeps the session history for pushState, replaceState and fragment
 * links itself. A navigation a browser would turn into a page load (a new
 * path through location.href, assign() or replace(), or reload()) reaches
 * the window's navigation as a navigate event, and is answered here by
 * starting the app afresh at that URL, which is what the app expects after
 * signing out or switching accounts. Other sites open in the system browser.
 */
import { openInBrowser } from './open-url';
import type { AnyRecord } from './types';

export interface HistoryOptions {
  /** Start the app over at this URL, as a page load would. */
  reload: (url: string) => void;
}

export function installHistory(win: AnyRecord, { reload }: HistoryOptions) {
  const location = win.location as Location;
  (win.navigation as EventTarget).addEventListener('navigate', (event: AnyRecord) => {
    const { navigationType, destination } = event;
    if (navigationType !== 'reload' && destination.sameDocument) return;
    if (!event.cancelable) return;
    event.preventDefault();
    const next = new URL(destination.url);
    if (next.origin === new URL(location.href).origin) {
      reload(next.href);
    } else if (next.protocol === 'http:' || next.protocol === 'https:') {
      openInBrowser(next.href);
    }
  });
}
