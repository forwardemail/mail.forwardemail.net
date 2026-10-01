/**
 * Virtual pixels for the webmail's scripts.
 *
 * Stylesheets are converted from CSS pixels to cells (./px-to-cells.js):
 * a column is PX_PER_COLUMN pixels wide and a row PX_PER_ROW pixels tall.
 * Scripts see the same world. Window size, element rects and sizes, pointer
 * coordinates and media queries are reported in virtual pixels, and pixel
 * lengths a script writes into an element's inline style are converted back
 * to cells. A menu positioned from a button's rect, or a sidebar sized from
 * a stored 240px, lands where the browser would put it, scaled to the grid.
 *
 * TermDOM's own code must keep working in cells, so the conversion is
 * limited to what the app touches: the app gets its own view of `window`,
 * inline styles are converted only for elements in the document (the
 * engine's form controls live in shadow trees), and scroll offsets stay in
 * cells because the engine reads them through the same public properties.
 */
import {
  PX_PER_COLUMN as X,
  PX_PER_ROW as Y,
  convertDeclarations,
  convertMediaQuery,
} from './px-to-cells.js';
import type { AnyRecord } from './types';

const WINDOW_SCALED: Record<string, number> = {
  innerWidth: X,
  outerWidth: X,
  innerHeight: Y,
  outerHeight: Y,
};

function findDescriptor(proto: object | null, name: string): PropertyDescriptor | undefined {
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor) return descriptor;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

function redefine(proto: object, name: string, descriptor: PropertyDescriptor) {
  Object.defineProperty(proto, name, { configurable: true, enumerable: true, ...descriptor });
}

function scaleGetter(
  proto: object,
  name: string,
  scale: number,
  raw?: (self: AnyRecord) => boolean,
) {
  const original = findDescriptor(proto, name);
  if (!original?.get) return;
  const get = original.get;
  redefine(proto, name, {
    get(this: AnyRecord) {
      const value = get.call(this);
      if (typeof value !== 'number' || raw?.(this)) return value;
      return value * scale;
    },
    set: original.set,
  });
}

/** The window as the app sees it: sizes and media queries in virtual pixels. */
export function createAppWindow(win: AnyRecord): AnyRecord {
  const matchMedia = (query: string) => win.matchMedia.call(win, convertMediaQuery(query));
  const bound = new Map<unknown, unknown>();
  const proxy: AnyRecord = new Proxy(win, {
    get(target, prop) {
      if (prop === 'window' || prop === 'self' || prop === 'globalThis') return proxy;
      if (prop === 'matchMedia') return matchMedia;
      const value = Reflect.get(target, prop, target);
      if (typeof prop === 'string' && prop in WINDOW_SCALED && typeof value === 'number') {
        return value * WINDOW_SCALED[prop];
      }
      // Methods run against the real window (addEventListener, scrollTo, ...).
      if (typeof value === 'function' && typeof prop === 'string' && /^[a-z]/.test(prop)) {
        if (!bound.has(value)) bound.set(value, value.bind(target));
        return bound.get(value);
      }
      return value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
  return proxy;
}

// Reading a length back from an inline style returns virtual pixels again.
const VERTICAL = /height|top|bottom|block|row/i;
function toVirtual(property: string, value: unknown) {
  if (typeof value !== 'string' || !value.includes('px')) return value;
  if (/radius|border|outline|shadow/i.test(property)) return value;
  const scale = VERTICAL.test(property) ? Y : X;
  return value.replace(/(-?\d*\.?\d+)px/g, (_m, n) => `${Number(n) * scale}px`);
}

export function installGeometry(win: AnyRecord) {
  const { Element, HTMLElement, MouseEvent, Document, ShadowRoot } = win;
  // The app's elements, attached or not yet; the engine's controls are
  // shadow trees.
  const inDocument = (node: AnyRecord) => !(node?.getRootNode?.() instanceof ShadowRoot);

  // Element rects and sizes. The engine measures through its layout, not
  // through these, so scaling them changes only what scripts read.
  for (const name of ['getBoundingClientRect', 'getClientRects']) {
    const original = findDescriptor(Element.prototype, name)?.value;
    if (typeof original !== 'function') continue;
    const Rect = win.DOMRect;
    const scale = (r: DOMRectReadOnly) => new Rect(r.x * X, r.y * Y, r.width * X, r.height * Y);
    redefine(Element.prototype, name, {
      writable: true,
      value:
        name === 'getBoundingClientRect'
          ? function (this: unknown) {
              return scale(original.call(this));
            }
          : function (this: unknown) {
              const rects = Array.from(original.call(this) as ArrayLike<DOMRectReadOnly>, scale);
              return Object.assign(rects, { item: (i: number) => rects[i] ?? null });
            },
    });
  }
  for (const name of ['offsetWidth', 'offsetLeft', 'clientWidth', 'clientLeft', 'scrollWidth'])
    scaleGetter(HTMLElement.prototype, name, X);
  for (const name of ['offsetHeight', 'offsetTop', 'clientHeight', 'clientTop', 'scrollHeight'])
    scaleGetter(HTMLElement.prototype, name, Y);
  // documentElement is not always an HTMLElement subclass here.
  for (const [name, scale] of [
    ['clientWidth', X],
    ['clientHeight', Y],
  ] as const) {
    if (findDescriptor(Element.prototype, name) && !Object.hasOwn(HTMLElement.prototype, name)) {
      scaleGetter(Element.prototype, name, scale);
    }
  }

  // Pointer coordinates. The engine's native <select> reads clientX from
  // its own listener to find the option under the pointer; that read stays
  // in cells.
  const raw = (event: AnyRecord) => {
    const target = event.currentTarget;
    return Boolean(target) && (target.localName === 'select' || !inDocument(target));
  };
  const clientX = findDescriptor(MouseEvent.prototype, 'clientX')!.get!;
  const clientY = findDescriptor(MouseEvent.prototype, 'clientY')!.get!;
  for (const name of ['clientX', 'x', 'screenX', 'movementX'])
    scaleGetter(MouseEvent.prototype, name, X, raw);
  for (const name of ['clientY', 'y', 'screenY', 'movementY'])
    scaleGetter(MouseEvent.prototype, name, Y, raw);
  const scrollX = () => (win.scrollX ?? 0) * X;
  const scrollY = () => (win.scrollY ?? 0) * Y;
  redefine(MouseEvent.prototype, 'pageX', {
    get(this: AnyRecord) {
      return clientX.call(this) * X + scrollX();
    },
  });
  redefine(MouseEvent.prototype, 'pageY', {
    get(this: AnyRecord) {
      return clientY.call(this) * Y + scrollY();
    },
  });
  const offset = (axis: 'x' | 'y') =>
    function (this: AnyRecord) {
      const target = this.target;
      const client = axis === 'x' ? clientX.call(this) * X : clientY.call(this) * Y;
      if (!target || typeof target.getBoundingClientRect !== 'function') return client;
      const rect = target.getBoundingClientRect();
      return client - (axis === 'x' ? rect.left : rect.top);
    };
  for (const [name, axis] of [
    ['offsetX', 'x'],
    ['layerX', 'x'],
    ['offsetY', 'y'],
    ['layerY', 'y'],
  ] as const) {
    redefine(MouseEvent.prototype, name, { get: offset(axis) });
  }

  for (const name of [
    'elementFromPoint',
    'elementsFromPoint',
    'caretPositionFromPoint',
    'caretRangeFromPoint',
  ]) {
    const original = findDescriptor(Document.prototype, name)?.value;
    if (typeof original !== 'function') continue;
    redefine(Document.prototype, name, {
      writable: true,
      value(this: unknown, x: number, y: number, ...rest: unknown[]) {
        return original.call(this, x / X, y / Y, ...rest);
      },
    });
  }

  // Inline styles the app writes: pixel lengths to cells.
  const styleGetter = findDescriptor(HTMLElement.prototype, 'style')!;
  const proxies = new WeakMap<object, unknown>();
  let converting = 0;
  const convert = (text: unknown) => (typeof text === 'string' ? convertDeclarations(text) : text);
  const convertOne = (property: string, value: unknown) => {
    if (typeof value !== 'string' || !/px|r?em/.test(value)) return value;
    const text = convertDeclarations(`${property}:${value}`);
    const colon = text.indexOf(':');
    return colon === -1 ? value : text.slice(colon + 1);
  };
  const cssName = (prop: string) =>
    prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  redefine(HTMLElement.prototype, 'style', {
    get(this: AnyRecord) {
      const style = styleGetter.get!.call(this);
      if (!style || !inDocument(this)) return style;
      let proxy = proxies.get(style);
      if (!proxy) {
        proxy = new Proxy(style, {
          get(target, prop) {
            if (prop === 'setProperty') {
              return (name: string, value: unknown, priority?: string) => {
                converting++;
                try {
                  return target.setProperty(name, convertOne(name, value), priority);
                } finally {
                  converting--;
                }
              };
            }
            if (prop === 'getPropertyValue') {
              return (name: string) => toVirtual(name, target.getPropertyValue(name));
            }
            const value = Reflect.get(target, prop, target);
            if (typeof value === 'function') return value.bind(target);
            if (typeof prop === 'string' && prop !== 'cssText' && typeof value === 'string') {
              return toVirtual(cssName(prop), value);
            }
            return value;
          },
          set(target, prop, value) {
            converting++;
            try {
              if (prop === 'cssText') target.cssText = convert(value);
              else if (typeof prop === 'string') {
                Reflect.set(target, prop, convertOne(cssName(prop), value), target);
              } else Reflect.set(target, prop, value, target);
            } finally {
              converting--;
            }
            return true;
          },
        });
        proxies.set(style, proxy);
      }
      return proxy;
    },
    set(this: AnyRecord, value: unknown) {
      converting++;
      try {
        styleGetter.set!.call(this, inDocument(this) ? convert(value) : value);
      } finally {
        converting--;
      }
    },
  });

  // setAttribute('style', ...) from the app; the engine's own write-back of
  // an inline style it just updated happens while `converting` is set.
  const setAttribute = findDescriptor(Element.prototype, 'setAttribute')!.value;
  redefine(Element.prototype, 'setAttribute', {
    writable: true,
    value(this: AnyRecord, name: string, value: unknown) {
      if (
        converting === 0 &&
        typeof name === 'string' &&
        name.toLowerCase() === 'style' &&
        inDocument(this)
      ) {
        value = convert(String(value));
      }
      return setAttribute.call(this, name, value);
    },
  });
}
