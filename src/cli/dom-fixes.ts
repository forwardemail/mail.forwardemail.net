/**
 * Small conformance fixes to the terminal DOM.
 *
 * TermDOM's Node.prototype getters are base-class defaults (nodeType 0,
 * nodeName "") that each node class overrides. Browsers put the real
 * getters on Node.prototype, and libraries such as DOMPurify call them from
 * there directly, so without this every node reads as nameless and untyped
 * and the sanitizer removes all of it. Each overridden Node.prototype getter
 * becomes a dispatch to the node's own class.
 */
import type { AnyRecord } from './types';

export function installDomFixes(win: AnyRecord) {
  const NodeProto = win.Node?.prototype;
  if (!NodeProto) return;
  const classes = [
    'Element',
    'Text',
    'Comment',
    'CDATASection',
    'CharacterData',
    'ProcessingInstruction',
    'Document',
    'DocumentFragment',
    'DocumentType',
    'Attr',
  ]
    .map((name) => win[name]?.prototype)
    .filter(Boolean);

  for (const name of Object.getOwnPropertyNames(NodeProto)) {
    const base = Object.getOwnPropertyDescriptor(NodeProto, name);
    if (!base?.get) continue;
    const overridden = classes.some((proto: object) => {
      let p: object | null = proto;
      while (p && p !== NodeProto) {
        if (Object.getOwnPropertyDescriptor(p, name)?.get) return true;
        p = Object.getPrototypeOf(p);
      }
      return false;
    });
    if (!overridden) continue;
    Object.defineProperty(NodeProto, name, {
      ...base,
      get(this: object) {
        let p = Object.getPrototypeOf(this);
        while (p && p !== NodeProto) {
          const own = Object.getOwnPropertyDescriptor(p, name);
          if (own?.get) return own.get.call(this);
          p = Object.getPrototypeOf(p);
        }
        return base.get!.call(this);
      },
    });
  }
}

const VOID_ELEMENTS = new Set([
  'br',
  'img',
  'input',
  'hr',
  'wbr',
  'area',
  'embed',
  'source',
  'track',
]);

/**
 * A caret "inside" a void element (ProseMirror puts it at <br>, 0 in an
 * empty paragraph) is legal in the DOM, and browsers insert typed text
 * beside the element. TermDOM would insert it into the <br>, where it shows
 * on screen but no editor sees it. Before each edit the selection is moved
 * to the same spot in the parent.
 */
export function installEditingFixes(win: AnyRecord) {
  const outside = (node: AnyRecord | null, offset: number): [AnyRecord | null, number] => {
    if (!node || node.nodeType !== 1 || !VOID_ELEMENTS.has(node.localName) || !node.parentNode) {
      return [node, offset];
    }
    const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
    return [node.parentNode, offset > 0 ? index + 1 : index];
  };
  win.addEventListener(
    'beforeinput',
    () => {
      const selection = win.getSelection?.();
      if (!selection || selection.rangeCount === 0) return;
      const [anchor, anchorOffset] = outside(selection.anchorNode, selection.anchorOffset);
      const [focus, focusOffset] = outside(selection.focusNode, selection.focusOffset);
      if (anchor !== selection.anchorNode || focus !== selection.focusNode) {
        selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
      }
    },
    true,
  );
}

/**
 * Element.animate() for a document that is never animated. TermDOM throws
 * NotSupportedError, and Svelte's transitions (menus, dialogs, toasts) call
 * it on every open and close. Here each animation finishes on the next tick,
 * so transitions complete at once, as with reduced motion in a browser.
 */
export function installAnimations(win: AnyRecord) {
  type Listener = (this: unknown, event: AnyRecord) => void;

  class TerminalAnimation {
    id = '';
    playState = 'running';
    currentTime: number | null = 0;
    startTime: number | null = null;
    playbackRate = 1;
    pending = false;
    replaceState = 'active';
    timeline = null;
    onfinish: Listener | null = null;
    oncancel: Listener | null = null;
    onremove: Listener | null = null;
    ready: Promise<TerminalAnimation>;
    // Never rejected: a browser rejects it on cancel(), which here would be an
    // unhandled rejection whenever nothing awaits it.
    finished: Promise<TerminalAnimation>;
    private resolveFinished!: (value: TerminalAnimation) => void;
    private listeners = new Map<string, Set<Listener>>();

    constructor(
      public effect: unknown,
      private duration: number,
    ) {
      this.ready = Promise.resolve(this);
      this.finished = new Promise((resolve) => {
        this.resolveFinished = resolve;
      });
      setTimeout(() => this.finish(), 0);
    }

    private fire(type: string) {
      const event = { type, target: this, currentTime: this.currentTime, timelineTime: null };
      (this as AnyRecord)[`on${type}`]?.call(this, event);
      for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
    }

    finish() {
      if (this.playState === 'finished' || this.playState === 'idle') return;
      this.playState = 'finished';
      this.currentTime = this.duration;
      this.resolveFinished(this);
      this.fire('finish');
    }

    cancel() {
      if (this.playState === 'idle') return;
      this.playState = 'idle';
      this.currentTime = null;
      this.fire('cancel');
    }

    play() {}
    pause() {}
    reverse() {}
    persist() {}
    commitStyles() {}
    updatePlaybackRate(rate: number) {
      this.playbackRate = rate;
    }

    addEventListener(type: string, listener: Listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
    }

    removeEventListener(type: string, listener: Listener) {
      this.listeners.get(type)?.delete(listener);
    }
  }

  const durationOf = (options: unknown) => {
    const value = typeof options === 'number' ? options : (options as AnyRecord)?.duration;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  };
  const define = (target: AnyRecord | undefined, name: string, value: unknown) => {
    if (target) Object.defineProperty(target, name, { value, configurable: true, writable: true });
  };

  define(win.Element?.prototype, 'animate', function (_keyframes: unknown, options?: unknown) {
    return new TerminalAnimation(null, durationOf(options));
  });
  define(win.Element?.prototype, 'getAnimations', () => []);
  define(win.Document?.prototype, 'getAnimations', () => []);
  define(win, 'Animation', TerminalAnimation);
  if (win.Document?.prototype) {
    Object.defineProperty(win.Document.prototype, 'timeline', {
      configurable: true,
      get: () => null,
    });
  }
}
