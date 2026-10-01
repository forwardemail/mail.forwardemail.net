/**
 * Session history and location for the terminal document.
 *
 * The webmail routes on location.pathname and moves with pushState and
 * replaceState, so the URL has to follow them (TermDOM's history keeps the
 * document URL fixed). Hash changes fire hashchange, back/forward fire
 * popstate, and the navigations a browser would turn into a page load (a
 * new path through location.href or location.replace(), or reload()) start
 * the app afresh at that URL, which is what the app expects after signing
 * out or switching accounts. Other sites open in the system browser.
 */
import { openInBrowser } from './open-url';
import type { AnyRecord } from './types';

export interface HistoryOptions {
  /** Start the app over at this URL, as a page load would. */
  reload: (url: string) => void;
}

export function installHistory(win: AnyRecord, { reload }: HistoryOptions) {
  let url = new URL(String(win.location.href));
  const entries: Array<{ url: string; state: unknown }> = [{ url: url.href, state: null }];
  let index = 0;

  const resolve = (value: unknown) => new URL(String(value ?? ''), url);

  const fire = (type: string, init: Record<string, unknown>) => {
    const Event = type === 'hashchange' && win.HashChangeEvent ? win.HashChangeEvent : win.Event;
    const event = new Event(type, init);
    if (type === 'popstate') {
      Object.defineProperty(event, 'state', { value: init.state ?? null, configurable: true });
    }
    win.dispatchEvent(event);
  };

  const setURL = (next: URL) => {
    url = next;
  };

  const traverse = (delta: number) => {
    const target = index + delta;
    if (delta === 0 || target < 0 || target >= entries.length) return;
    setTimeout(() => {
      const oldURL = url.href;
      index = target;
      setURL(new URL(entries[index].url));
      fire('popstate', { state: entries[index].state });
      if (url.hash !== new URL(oldURL).hash) fire('hashchange', { oldURL, newURL: url.href });
    }, 0);
  };

  const sameDocument = (next: URL) =>
    next.origin === url.origin && next.pathname === url.pathname && next.search === url.search;

  // A navigation as a link or location.href would make it.
  const navigate = (value: unknown, replace: boolean) => {
    const next = resolve(value);
    if (next.origin !== url.origin) {
      if (next.protocol === 'http:' || next.protocol === 'https:') openInBrowser(next.href);
      return;
    }
    if (sameDocument(next) && next.hash !== url.hash) {
      const oldURL = url.href;
      if (replace) entries[index] = { url: next.href, state: null };
      else {
        entries.splice(index + 1);
        entries.push({ url: next.href, state: null });
        index++;
      }
      setURL(next);
      fire('hashchange', { oldURL, newURL: next.href });
      return;
    }
    reload(next.href);
  };

  const history = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[index].state;
    },
    scrollRestoration: 'auto',
    pushState(state: unknown, _title: string, value?: string | URL | null) {
      const next = value == null ? url : resolve(value);
      if (next.origin !== url.origin) {
        throw new win.DOMException('pushState to another origin', 'SecurityError');
      }
      entries.splice(index + 1);
      entries.push({ url: next.href, state: structuredClone(state ?? null) });
      index++;
      setURL(next);
    },
    replaceState(state: unknown, _title: string, value?: string | URL | null) {
      const next = value == null ? url : resolve(value);
      if (next.origin !== url.origin) {
        throw new win.DOMException('replaceState to another origin', 'SecurityError');
      }
      entries[index] = { url: next.href, state: structuredClone(state ?? null) };
      setURL(next);
    },
    back: () => traverse(-1),
    forward: () => traverse(1),
    go: (delta = 0) => (delta === 0 ? reload(url.href) : traverse(delta)),
  };

  const location: AnyRecord = {
    get href() {
      return url.href;
    },
    set href(value) {
      navigate(value, false);
    },
    get origin() {
      return url.origin;
    },
    get protocol() {
      return url.protocol;
    },
    get host() {
      return url.host;
    },
    get hostname() {
      return url.hostname;
    },
    get port() {
      return url.port;
    },
    get pathname() {
      return url.pathname;
    },
    set pathname(value) {
      const next = new URL(url.href);
      next.pathname = String(value);
      navigate(next.href, false);
    },
    get search() {
      return url.search;
    },
    set search(value) {
      const next = new URL(url.href);
      next.search = String(value);
      navigate(next.href, false);
    },
    get hash() {
      return url.hash;
    },
    set hash(value) {
      const next = new URL(url.href);
      next.hash = String(value);
      navigate(next.href, false);
    },
    ancestorOrigins: { length: 0, item: () => null, contains: () => false },
    assign: (value: unknown) => navigate(value, false),
    replace: (value: unknown) => navigate(value, true),
    reload: () => reload(url.href),
    toString: () => url.href,
  };

  for (const [name, value] of [
    ['history', history],
    ['location', location],
  ] as const) {
    Object.defineProperty(win, name, { configurable: true, get: () => value, set: undefined });
  }
  const document = win.document as AnyRecord;
  Object.defineProperty(document, 'location', { configurable: true, get: () => location });
  Object.defineProperty(document, 'URL', { configurable: true, get: () => url.href });
  Object.defineProperty(document, 'documentURI', { configurable: true, get: () => url.href });

  return { history, location };
}
