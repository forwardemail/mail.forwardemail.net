/**
 * Message bodies in the terminal.
 *
 * The webmail renders each message into a sandboxed <iframe srcdoc>, which
 * TermDOM draws from the frame's own document. Here the sandbox also gets
 * allow-same-origin, so the client can read that document (link clicks below,
 * the selection in clipboard.ts) the way a browser lets a page read a
 * same-origin frame. That is safe because no script runs in the terminal, in
 * the app or in a frame. For the same reason the frame's runtime script never
 * runs, so the messages it would post back (ready, content height, link
 * clicks) are posted from here instead.
 */
import { convertStylesheet } from './px-to-cells.js';
import type { AnyRecord } from './types';

/**
 * What a document here may load or run, as TermDOM's csp option: nothing.
 * The terminal draws no picture, sound or font, so a request for one would
 * only tell its server that the message was opened, and where from. TermDOM
 * checks every load against this before it is made, the message frames'
 * included, whatever the frame's own policy allows (remote images turned on).
 * It runs no program for an <embed> and no handler attribute either way;
 * the last two directives say so for good.
 */
export const DOCUMENT_POLICY =
  "img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; script-src-attr 'none'";

const wiredDocuments = new WeakSet<object>();

function withSameOrigin(value: unknown) {
  const tokens = String(value ?? '')
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.includes('allow-same-origin')) tokens.push('allow-same-origin');
  return tokens.join(' ');
}

function postToApp(win: AnyRecord, iframe: AnyRecord, data: unknown) {
  const event = new win.MessageEvent('message', {
    data,
    origin: 'null',
    source: iframe.contentWindow,
  });
  win.dispatchEvent(event);
}

function render(iframe: AnyRecord) {
  const win = iframe.ownerDocument?.defaultView as AnyRecord | null;
  const doc = iframe.contentDocument as AnyRecord | null;
  if (!win || !doc) return;

  if (!wiredDocuments.has(doc)) {
    wiredDocuments.add(doc);
    for (const style of doc.querySelectorAll('style')) {
      try {
        style.textContent = convertStylesheet(style.textContent ?? '');
      } catch {
        style.textContent = '';
      }
    }
    // viewport.ts converts an inline style written through setAttribute.
    for (const el of doc.querySelectorAll('[style]')) {
      el.setAttribute('style', el.getAttribute('style') ?? '');
    }
    doc.addEventListener('click', (event: AnyRecord) => {
      const link = event.target?.closest?.('a[href]');
      if (!link) return;
      event.preventDefault();
      const url = link.getAttribute('href') ?? '';
      postToApp(win, iframe, {
        type: 'link',
        payload: { url, isMailto: url.toLowerCase().startsWith('mailto:') },
      });
    });
    win.dispatchEvent(new win.CustomEvent('fe-frame-document', { detail: { document: doc } }));
  }

  // The app treats a frame that never reports as broken.
  setTimeout(() => {
    const height = doc.documentElement?.getBoundingClientRect().height ?? 0;
    postToApp(win, iframe, { type: 'ready' });
    postToApp(win, iframe, { type: 'height', payload: { height } });
  }, 0);
}

const patched = new WeakSet<object>();

export function installFrames(win: AnyRecord) {
  // A frame's load event does not bubble, so it is caught on the way down.
  win.document.addEventListener(
    'load',
    (event: AnyRecord) => {
      if (event.target?.localName === 'iframe') render(event.target);
    },
    true,
  );

  const proto = win.HTMLIFrameElement?.prototype;
  if (!proto || patched.has(proto)) return;
  patched.add(proto);

  const sandbox = Object.getOwnPropertyDescriptor(proto, 'sandbox');
  if (sandbox?.set) {
    Object.defineProperty(proto, 'sandbox', {
      ...sandbox,
      set(this: AnyRecord, value: unknown) {
        sandbox.set!.call(this, withSameOrigin(value));
      },
    });
  }

  const setAttribute = win.Element.prototype.setAttribute;
  Object.defineProperty(win.Element.prototype, 'setAttribute', {
    configurable: true,
    writable: true,
    value(this: AnyRecord, name: string, value: unknown) {
      const sandboxed = this.localName === 'iframe' && String(name).toLowerCase() === 'sandbox';
      return setAttribute.call(this, name, sandboxed ? withSameOrigin(value) : value);
    },
  });
}
