import path from 'node:path';
import { TermDOM, type TerminalTransport } from '@b9g/termdom';
import * as fakeIndexedDB from 'fake-indexeddb';
import { createStorage } from './storage';
import { installCentering } from './center';
import { installAnimations, installDomFixes, installEditingFixes } from './dom-fixes';
import { installFrames } from './frames';
import { installHistory } from './history';
import { installKeys } from './keys';
import { installClipboard } from './clipboard';
import { installLinks } from './links';
import { canConnect, installNetwork } from './network';
import { installPointer } from './pointer';
import { installScrollbars } from './scrollbars';
import { installTextareaSizing } from './textareas';
import { installNotifications, type Notifier } from './notifications';
import { openInBrowser } from './open-url';
import { createAppWindow, installGeometry } from './viewport';
import { ThreadWorker, configureWorkers } from './worker';

export interface EnvironmentOptions {
  dataDir: string;
  logFile: string | null;
  html: string;
  url?: string;
  transport?: TerminalTransport;
  version: string;
  /** sessionStorage carried over from the instance this one replaces. */
  sessionState?: Record<string, string>;
  /** Called for a navigation that a browser would handle with a page load. */
  reload: (url: string) => void;
  /** Backs window.Notification (notifications.ts); none leaves it out. */
  notifier?: Notifier | null;
}

// Node globals that stay Node's own. fetch, streams, MessagePort, crypto and
// timers are what the rest of Node produces and consumes, so swapping them
// for the document's versions would mix two incompatible implementations.
const KEEP_NODE_GLOBALS = new Set([
  'AbortController',
  'AbortSignal',
  'Blob',
  'BroadcastChannel',
  'CompressionStream',
  'DecompressionStream',
  'File',
  'FormData',
  'Headers',
  'MessageChannel',
  'MessagePort',
  'ReadableStream',
  'Request',
  'Response',
  'TextDecoder',
  'TextEncoder',
  'TransformStream',
  'URL',
  'URLSearchParams',
  'WebSocket',
  'WritableStream',
  'atob',
  'btoa',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'fetch',
  'performance',
  'queueMicrotask',
  'setInterval',
  'setTimeout',
  'structuredClone',
  'globalThis',
  'window',
  'self',
  'constructor',
]);

function define(target: object, name: string, value: unknown) {
  Object.defineProperty(target, name, { value, configurable: true, writable: true });
}

/**
 * A canvas has no pixels to draw on in a terminal. Decorative canvases (the
 * starfield) get a 2D context that accepts every call and draws nothing,
 * instead of the null a browser returns for an unknown context type.
 */
function createNullCanvasContext(canvas: unknown) {
  const gradient = { addColorStop() {} };
  const special: Record<string, unknown> = {
    canvas,
    measureText: (text: string) => ({ width: String(text).length }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => ({}),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(Math.max(0, w * h * 4)),
    }),
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(Math.max(0, w * h * 4)),
    }),
    getLineDash: () => [],
    isPointInPath: () => false,
    isPointInStroke: () => false,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  const store: Record<string | symbol, unknown> = {};
  return new Proxy(store, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in special) return special[prop];
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function collectNames(win: object): Set<string> {
  const names = new Set<string>();
  let proto: object | null = win;
  while (proto && proto !== Object.prototype && proto !== EventTarget.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    proto = Object.getPrototypeOf(proto);
  }
  names.add('addEventListener');
  names.add('removeEventListener');
  names.add('dispatchEvent');
  return names;
}

/**
 * Makes the Node process look like the browser tab the webmail expects.
 *
 * `window` and `self` are the TermDOM window, and every global the window
 * has (document, location, history, HTMLElement, matchMedia, ...) is
 * forwarded from globalThis, so bare `document` and `window.document` agree.
 * On top of that the window gets what a terminal lacks: persistent
 * localStorage, IndexedDB and inline Web Workers.
 */
export function installEnvironment(options: EnvironmentOptions) {
  const term = new TermDOM({
    html: options.html,
    url: options.url ?? 'https://mail.forwardemail.net/',
    transport: options.transport,
  });
  const win = term.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  configureWorkers({
    href: () => String((win.location as Location).href),
    log: options.logFile,
  });

  const platform =
    process.platform === 'darwin' ? 'MacIntel' : process.platform === 'win32' ? 'Win32' : 'Linux';
  const language = (process.env.LC_ALL || process.env.LANG || 'en_US').split('.')[0];

  const navigator = win.navigator as Record<string, unknown>;
  const navigatorExtras: Record<string, unknown> = {
    userAgent: `Mozilla/5.0 (${platform}) ForwardEmailCLI/${options.version}`,
    platform,
    language: /^[a-z]{2}(_[A-Z]{2})?$/.test(language) ? language.replace('_', '-') : 'en-US',
    hardwareConcurrency: 1,
    maxTouchPoints: 0,
    cookieEnabled: false,
    storage: {
      persist: async () => true,
      persisted: async () => true,
      estimate: async () => ({ quota: 2 ** 31, usage: 0 }),
    },
  };
  for (const [name, value] of Object.entries(navigatorExtras)) {
    try {
      define(navigator, name, value);
    } catch {
      // keep the engine's value
    }
  }

  // What the terminal document lacks, set on the window itself so it shadows
  // the engine's stubs ("A terminal has no indexed database").
  const localStorage = createStorage(path.join(options.dataDir, 'local-storage.json'));
  const sessionStorage = createStorage(null);
  for (const [key, value] of Object.entries(options.sessionState ?? {})) {
    sessionStorage.setItem(key, value);
  }
  const windowExtras: Record<string, unknown> = {
    localStorage,
    sessionStorage,
    caches: undefined,
    Worker: ThreadWorker,
    // Links leave the terminal for the system browser; there is no window
    // object to hand back.
    open: (url?: string | URL) => {
      openInBrowser(url);
      return null;
    },
    ...fakeIndexedDB,
  };
  delete windowExtras.default;
  for (const [name, value] of Object.entries(windowExtras)) define(win, name, value);

  const canvasProto = (win.HTMLCanvasElement as { prototype: Record<string, unknown> }).prototype;
  const contexts = new WeakMap<object, unknown>();
  define(canvasProto, 'getContext', function (this: object, type: string) {
    if (type !== '2d') return null;
    if (!contexts.has(this)) contexts.set(this, createNullCanvasContext(this));
    return contexts.get(this);
  });
  define(canvasProto, 'toDataURL', () => 'data:,');

  installHistory(win, { reload: options.reload });
  installLinks(win);
  installClipboard(win);
  installPointer(win);
  installKeys(win);
  installCentering(win);
  installDomFixes(win);
  installEditingFixes(win);
  installAnimations(win);
  installGeometry(win);
  installFrames(win);
  installTextareaSizing(win);
  installScrollbars(win);
  installNotifications(win, { dataDir: options.dataDir, notifier: options.notifier ?? null });
  const appWindow = createAppWindow(win);

  for (const name of collectNames(win)) {
    if (KEEP_NODE_GLOBALS.has(name)) continue;
    // Node's own navigator is a getter on globalThis; replace it too.
    Object.defineProperty(g, name, {
      configurable: true,
      enumerable: false,
      get() {
        return appWindow[name];
      },
      set(value) {
        win[name] = value;
      },
    });
  }

  define(g, 'window', appWindow);
  define(g, 'self', appWindow);

  // Browsers resolve relative request URLs against the page; Node's fetch
  // rejects them. The page's origin is the hosted webmail, so relative
  // fetches (e.g. /clear-manifest.json) reach the same files the web app does.
  const nodeFetch = globalThis.fetch;
  // Offline and back online, as a browser reports it (network.ts).
  const apiUrl = new URL(String(g.__FORWARDEMAIL_API_URL__ ?? 'https://api.forwardemail.net'));
  const network = installNetwork(win, {
    probe: () =>
      canConnect(apiUrl.hostname, Number(apiUrl.port) || (apiUrl.protocol === 'http:' ? 80 : 443)),
  });
  const networkFetch = network.wrapFetch(nodeFetch);
  const pageFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && !/^[a-z][a-z\d+.-]*:/i.test(input)) {
      input = new URL(input, (win.location as Location).href).href;
    }
    return networkFetch(input, init);
  };
  define(g, 'fetch', pageFetch);
  define(win, 'fetch', pageFetch);

  return {
    term,
    window: appWindow,
    document: term.document,
    localStorage: localStorage as Storage & { flush(): void },
    sessionStorage,
  };
}
