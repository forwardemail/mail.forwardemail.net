/**
 * Message bodies in the terminal.
 *
 * The webmail renders each message into a sandboxed <iframe srcdoc>. A
 * terminal has no nested browsing context to paint, but TermDOM does lay out
 * an iframe's child nodes like any other box. So whenever an iframe's srcdoc
 * changes, its document is copied into a shadow tree inside the iframe
 * element, where its stylesheet stays scoped to the message, and the
 * messages the iframe's runtime script would post back (content height,
 * link clicks) are posted from here instead. Nothing runs from the message
 * itself: scripts are dropped with the rest of the head.
 */
import { convertDeclarations, convertStylesheet } from './px-to-cells.js';
import type { AnyRecord } from './types';

const VIEW_CLASS = 'fe-frame-view';
const kPending = Symbol('forwardemail.frame.pending');

// The message stylesheet targets html and body, which a shadow tree has not
// got; they become the wrapper that stands in for both.
function scopeToWrapper(css: string) {
  return css
    .replace(/(^|[\s,>+~}(])html\b/g, '$1.fe-frame-root')
    .replace(/(^|[\s,>+~}(])body\b/g, '$1.fe-frame-root');
}

function postToApp(win: AnyRecord, iframe: AnyRecord, data: unknown) {
  const event = new win.MessageEvent('message', {
    data,
    origin: 'null',
    source: iframe.contentWindow,
  });
  win.dispatchEvent(event);
}

function render(win: AnyRecord, iframe: AnyRecord) {
  iframe[kPending] = false;
  const doc = iframe.contentDocument as AnyRecord | null;
  const document = iframe.ownerDocument as AnyRecord;
  if (!doc || !document) return;

  let view = [...iframe.children].find((child: AnyRecord) => child.classList?.contains(VIEW_CLASS));
  if (!view) {
    view = document.createElement('div');
    view.className = VIEW_CLASS;
    view.attachShadow({ mode: 'open' });
    iframe.append(view);
  }

  const styles = [...doc.querySelectorAll('style')]
    .map((style: AnyRecord) => style.textContent ?? '')
    .join('\n');
  let css = '';
  try {
    css = convertStylesheet(scopeToWrapper(styles));
  } catch {
    css = '';
  }

  const rootClasses = [doc.documentElement?.className, doc.body?.className]
    .filter(Boolean)
    .join(' ');
  const root = document.createElement('div');
  root.className = `fe-frame-root ${rootClasses}`.trim();
  for (const node of [...(doc.body?.childNodes ?? [])]) {
    if (node.nodeName === 'SCRIPT') continue;
    root.append(document.importNode(node, true));
  }
  for (const el of root.querySelectorAll('script, iframe, object, embed, link, meta')) el.remove();
  for (const el of root.querySelectorAll('[style]')) {
    el.setAttribute('style', convertDeclarations(el.getAttribute('style') ?? ''));
  }

  const style = document.createElement('style');
  style.textContent = css;
  view.shadowRoot.replaceChildren(style, root);

  // Links go through the app, as the iframe runtime would send them.
  root.addEventListener('click', (event: AnyRecord) => {
    const link = event.target?.closest?.('a[href]');
    if (!link) return;
    event.preventDefault();
    const url = link.getAttribute('href') ?? '';
    postToApp(win, iframe, {
      type: 'link',
      payload: { url, isMailto: url.toLowerCase().startsWith('mailto:') },
    });
  });

  // The app sizes the frame from reported heights and treats a frame that
  // never reports as broken; the content here sizes itself.
  setTimeout(() => {
    const height = Math.max(view.getBoundingClientRect().height, 51);
    postToApp(win, iframe, { type: 'ready' });
    postToApp(win, iframe, { type: 'height', payload: { height } });
  }, 0);
}

function schedule(win: AnyRecord, iframe: AnyRecord) {
  if (iframe[kPending]) return;
  iframe[kPending] = true;
  queueMicrotask(() => render(win, iframe));
}

export function installFrames(win: AnyRecord) {
  const proto = win.HTMLIFrameElement?.prototype;
  if (!proto) return;

  const srcdoc = Object.getOwnPropertyDescriptor(proto, 'srcdoc');
  if (srcdoc?.set) {
    Object.defineProperty(proto, 'srcdoc', {
      ...srcdoc,
      set(this: AnyRecord, value: unknown) {
        srcdoc.set!.call(this, value);
        schedule(win, this);
      },
    });
  }

  const setAttribute = win.Element.prototype.setAttribute;
  Object.defineProperty(win.Element.prototype, 'setAttribute', {
    configurable: true,
    writable: true,
    value(this: AnyRecord, name: string, value: unknown) {
      const result = setAttribute.call(this, name, value);
      if (this.localName === 'iframe' && String(name).toLowerCase() === 'srcdoc') {
        schedule(win, this);
      }
      return result;
    },
  });
}
