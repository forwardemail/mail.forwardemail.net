/**
 * "View original" in the terminal.
 *
 * In a browser the webmail opens the original message (its headers and raw
 * source) in a new tab. A terminal has no tab to open, so the app hands the
 * original over (the fe:view-original event, from viewOriginal in
 * stores/mailboxActions.ts) and it is shown here, over the page:
 *
 *   Subject                          Save .eml   Copy raw   Close
 *   HEADERS
 *   …
 *   RAW SOURCE
 *   …
 *
 * Esc or Close goes back to the message. The arrow keys, Page Up, Page Down,
 * Home and End scroll; Tab moves between the buttons. While it is open the
 * app's own shortcuts are held back, so a key meant for the viewer does not
 * reply to or delete the message behind it.
 */
import { saveToDownloads } from './links';
import { PX_PER_ROW } from './px-to-cells.js';
import type { AnyRecord } from './types';

export interface OriginalMessage {
  raw: string;
  headers: string;
  decrypted: string;
  subject: string;
}

/** How much of the raw source the viewer shows. */
export const MAX_SHOWN = 256 * 1024;

const SCROLL_KEYS: Record<string, (view: number) => number | 'top' | 'end'> = {
  ArrowDown: () => 1,
  ArrowUp: () => -1,
  PageDown: (view) => Math.max(1, view - 1),
  PageUp: (view) => -Math.max(1, view - 1),
  ' ': (view) => Math.max(1, view - 1),
  Home: () => 'top',
  End: () => 'end',
};

/** The headers: given, or the part of the raw source before the first blank line. */
export function headersOf(original: Pick<OriginalMessage, 'raw' | 'headers'>): string {
  if (original.headers) return original.headers;
  const raw = original.raw.replace(/\r\n/g, '\n');
  const divider = raw.indexOf('\n\n');
  return divider > 0 ? raw.slice(0, divider).trim() : '';
}

export function installOriginalViewer(win: AnyRecord) {
  const document = win.document as AnyRecord;
  let open: { overlay: AnyRecord; body: AnyRecord; returnFocus: AnyRecord } | null = null;

  const close = () => {
    if (!open) return;
    const { overlay, returnFocus } = open;
    open = null;
    overlay.remove();
    if (returnFocus?.isConnected) returnFocus.focus?.();
  };

  const asText = (html: string) => {
    if (!/<[a-z][\s\S]*>/i.test(html)) return html;
    const parsed = new win.DOMParser().parseFromString(html, 'text/html');
    return String(parsed.body?.textContent ?? '').trim();
  };

  const show = (original: OriginalMessage) => {
    close();
    const overlay = document.createElement('div');
    overlay.id = 'fe-terminal-original';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Original message');

    const bar = document.createElement('div');
    bar.className = 'fe-original-bar';
    const title = document.createElement('span');
    title.className = 'fe-original-title';
    title.textContent = original.subject || 'Original message';
    bar.append(title);
    const button = (label: string, action: () => void) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = label;
      el.addEventListener('click', action);
      bar.append(el);
      return el;
    };
    const raw = original.raw || '';
    button('Save .eml', () => {
      const name = `${(original.subject || 'message').slice(0, 100)}.eml`;
      void saveToDownloads(win, async () => new TextEncoder().encode(raw), name);
    });
    button('Copy raw', () => {
      Promise.resolve(win.navigator.clipboard.writeText(raw)).then(
        () => win.dispatchEvent(new win.CustomEvent('fe-terminal-notice', { detail: 'Copied' })),
        () =>
          win.dispatchEvent(
            new win.CustomEvent('fe-terminal-notice', { detail: 'Could not copy' }),
          ),
      );
    });
    const closeButton = button('Close', close);

    const body = document.createElement('div');
    body.className = 'fe-original-body';
    const section = (label: string, text: string) => {
      const heading = document.createElement('div');
      heading.className = 'fe-original-label';
      heading.textContent = label;
      const pre = document.createElement('pre');
      pre.textContent = text;
      body.append(heading, pre);
    };
    section('Headers', headersOf(original) || 'No headers available');
    // A message with large attachments is megabytes of base64, which takes
    // seconds to lay out; the start is shown and Save .eml has the rest.
    section(
      'Raw source',
      raw.length > MAX_SHOWN
        ? `${raw.slice(0, MAX_SHOWN)}\n\n… ${Math.round(raw.length / 1024)} KB in all. Save .eml for the full message.`
        : raw || 'No original content available',
    );
    if (original.decrypted) section('Decrypted body', asText(original.decrypted));

    overlay.append(bar, body);
    open = { overlay, body, returnFocus: document.activeElement };
    document.body.append(overlay);
    closeButton.focus();
  };

  win.addEventListener('fe:view-original', (event: AnyRecord) => {
    const detail = event.detail ?? {};
    show({
      raw: String(detail.raw ?? ''),
      headers: String(detail.headers ?? ''),
      decrypted: String(detail.decrypted ?? ''),
      subject: String(detail.subject ?? ''),
    });
  });

  win.addEventListener(
    'keydown',
    (event: AnyRecord) => {
      if (!open) return;
      // Ahead of the app's shortcuts.
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      const buttons = [...open.overlay.querySelectorAll('button')] as AnyRecord[];
      // Focus stays on the viewer's buttons: Tab cycles through them, and a
      // key aimed at anything behind the viewer does nothing there.
      if (event.key === 'Tab') {
        event.preventDefault();
        const at = buttons.indexOf(document.activeElement);
        const step = event.shiftKey ? -1 : 1;
        const next = at === -1 ? 0 : (at + step + buttons.length) % buttons.length;
        buttons[next]?.focus();
        return;
      }
      if (!open.overlay.contains(event.target)) {
        event.preventDefault();
        buttons.at(-1)?.focus();
        if (!SCROLL_KEYS[event.key] || event.key === ' ') return;
      }
      const scroll = SCROLL_KEYS[event.key];
      // Space on a button presses it.
      if (!scroll || (event.key === ' ' && event.target?.localName === 'button')) return;
      event.preventDefault();
      const body = open.body;
      const view = Math.max(1, Math.round(Number(body.clientHeight) / PX_PER_ROW));
      const by = scroll(view);
      if (by === 'top') body.scrollTop = 0;
      else if (by === 'end') body.scrollTop = Number(body.scrollHeight);
      else body.scrollTop = Number(body.scrollTop) + by;
    },
    true,
  );

  return { show, close, isOpen: () => open !== null };
}
