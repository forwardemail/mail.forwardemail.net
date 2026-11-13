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
