/**
 * Drops the parts of the webmail's stylesheet a terminal cannot use.
 *
 * TermDOM matches every rule against every element, so rules that can never
 * change a cell (keyframes, shadows, transitions, scrollbar styling, print
 * styles) cost time on every restyle without adding anything. Removing them
 * at build time keeps the terminal client responsive.
 */
import * as csstree from 'css-tree';

// Declarations with no effect on a character grid.
const DEAD_PROPERTY =
  /^(-webkit-|-moz-|-ms-)|^(transition|animation|box-shadow|text-shadow|filter|backdrop-filter|will-change|cursor|touch-action|overscroll-behavior|scroll-behavior|scroll-snap|mask|clip-path|contain$|content-visibility|backface-visibility|perspective|transform|translate$|rotate$|scale$|appearance|caret-color|accent-color|tab-size|font-family|font-feature-settings|font-variation-settings|font-optical-sizing|-webkit-font-smoothing|text-rendering|image-rendering|object-fit|object-position|print-color-adjust|forced-color-adjust|resize|isolation|mix-blend-mode|background-blend-mode|stroke|fill$|opacity|pointer-events|container|scrollbar|scroll-margin|scroll-padding|hyphens|orphans|widows|line-break|color-scheme|interpolate-size|field-sizing|zoom$)/i;

// Selectors that match nothing in a terminal document.
const DEAD_SELECTOR =
  /::-webkit-|::-moz-|:-webkit-|:-moz-|::-ms-|:-ms-|::file-selector-button|::backdrop|::marker|:autofill|::cue|::view-transition|::scroll-marker/i;

// A pseudo-element named on its own (`*, ::before, ::after` resets and
// Tailwind's property defaults) makes TermDOM consider a ::before and
// ::after for every element in the document, the most expensive part of a
// restyle. Rules that give a pseudo-element content name it with a class.
const UNIVERSAL_PSEUDO =
  /^\*?::?(before|after|backdrop|placeholder|selection|file-selector-button|marker)$/i;

// Media queries a terminal never matches.
const DEAD_MEDIA =
  /\bprint\b|prefers-reduced-motion|prefers-contrast|forced-colors|\(pointer:\s*coarse\)|\(any-pointer:\s*coarse\)|-webkit-min-device-pixel-ratio|min-resolution|display-mode/i;

const DEAD_AT_RULES = new Set([
  'keyframes',
  '-webkit-keyframes',
  'font-face',
  'property',
  'page',
  'view-transition',
  'counter-style',
  'font-feature-values',
  'font-palette-values',
]);

// What a translucent color is drawn over. A cell cannot show what is behind
// it, so translucent colors are blended with the page background instead:
// a hover tint or a 50% muted fill comes out as the color the eye sees on
// the page, rather than the terminal's own background.
const BACKDROP = 'var(--background)';

function alphaOf(text) {
  const value = text.trim();
  if (value.endsWith('%')) return Number.parseFloat(value) / 100;
  return Number.parseFloat(value);
}

/**
 * Rewrites translucent colors in a declaration value as opaque mixes with
 * the page background: `color-mix(…, transparent)` mixes with the background
 * instead, and rgb()/hsl() with an alpha below 1 becomes a color-mix().
 */
export function opaqueColors(value) {
  // The arguments may hold one level of parentheses (var(--muted)), never
  // the closing parenthesis of this color-mix, so the match cannot reach a
  // "transparent" that belongs to something after it.
  let text = value.replace(
    /(color-mix\(\s*in\s+[^,()]+,(?:[^;()]|\([^()]*\))*?),\s*transparent(\s*\))/gi,
    `$1, ${BACKDROP}$2`,
  );
  text = text.replace(/\b(rgb|hsl)a?\(([^()]*)\)/gi, (whole, name, args) => {
    let channels;
    let alpha;
    if (args.includes('/')) {
      [channels, alpha] = args.split('/');
    } else {
      const parts = args.split(',');
      if (parts.length !== 4) return whole;
      channels = parts.slice(0, 3).join(',');
      alpha = parts[3];
    }
    const a = alphaOf(alpha);
    if (!Number.isFinite(a) || a >= 1) return whole;
    // Fully transparent paints nothing, rather than the page background.
    if (a <= 0) return 'transparent';
    const pct = Math.round(Math.max(0, a) * 1000) / 10;
    return `color-mix(in srgb, ${name.toLowerCase()}(${channels.trim()}) ${pct}%, ${BACKDROP})`;
  });
  return text;
}

export function pruneStylesheet(css) {
  const ast = csstree.parse(css, { parseCustomProperty: false, onParseError: () => {} });

  // Several passes: removing declarations can empty a rule, which can empty
  // a block, which can empty an at-rule.
  for (let pass = 0; pass < 3; pass++) {
    csstree.walk(ast, {
      leave(node, item, list) {
        if (!list) return;
        // A cell is drawn or it is not: transparent elements (hover overlays,
        // controls revealed by group-hover) are hidden, any other opacity is
        // shown. Without this they would all be drawn at full strength.
        if (node.type === 'Declaration' && node.property.toLowerCase() === 'opacity') {
          const value = csstree.generate(node.value).trim();
          const hidden = /^0*\.?0*%?$/.test(value);
          list.replace(
            item,
            list.createItem({
              type: 'Declaration',
              important: node.important,
              property: 'visibility',
              value: { type: 'Raw', value: hidden ? 'hidden' : 'visible' },
            }),
          );
          return;
        }
        if (node.type === 'Declaration' && pass === 0 && node.property !== '--background') {
          const text = csstree.generate(node.value);
          const opaque = opaqueColors(text);
          if (opaque !== text) node.value = { type: 'Raw', value: opaque };
        }
        if (node.type === 'Declaration' && DEAD_PROPERTY.test(node.property)) {
          list.remove(item);
          return;
        }
        // TermDOM prints content: attr(x) literally; without it the pseudo-
        // element (a placeholder or tooltip) is simply not drawn.
        if (
          node.type === 'Declaration' &&
          node.property === 'content' &&
          /\battr\(/i.test(csstree.generate(node.value))
        ) {
          list.remove(item);
          return;
        }
        if (node.type === 'Atrule') {
          const name = node.name.toLowerCase();
          if (DEAD_AT_RULES.has(name)) {
            list.remove(item);
            return;
          }
          if (name === 'media' && node.prelude && DEAD_MEDIA.test(csstree.generate(node.prelude))) {
            // `not print` style queries are rare; a query naming print or
            // motion preferences is dropped whole.
            list.remove(item);
            return;
          }
          if (node.block && node.block.children.isEmpty && !/^(layer|import)$/i.test(name)) {
            list.remove(item);
          }
          return;
        }
        if (node.type === 'Rule') {
          if (node.prelude.type === 'SelectorList') {
            node.prelude.children.forEach((selector, selectorItem, selectors) => {
              const text = csstree.generate(selector);
              if (DEAD_SELECTOR.test(text) || UNIVERSAL_PSEUDO.test(text)) {
                selectors.remove(selectorItem);
              }
            });
            if (node.prelude.children.isEmpty) {
              list.remove(item);
              return;
            }
          }
          if (node.block.children.isEmpty) list.remove(item);
        }
      },
    });
  }

  return csstree.generate(ast);
}

const VAR_REFERENCE = /var\(\s*(--[\w-]+)/g;

function declarationText(decl) {
  return decl.value.type === 'Raw' ? decl.value.value : csstree.generate(decl.value);
}

/**
 * Drops custom properties nothing reads. Tailwind and the design tokens
 * declare hundreds of them on :root and on every element (`*, ::before,
 * ::after`), and each one is inherited by every node TermDOM styles.
 *
 * `keep` lists names read from elsewhere: scripts, inline styles, the
 * terminal theme.
 */
export function pruneCustomProperties(css, keep = new Set()) {
  const ast = csstree.parse(css, { parseCustomProperty: false, onParseError: () => {} });
  const definitions = new Map();
  const used = new Set(keep);
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(decl) {
      const text = declarationText(decl);
      if (decl.property.startsWith('--')) {
        if (!definitions.has(decl.property)) definitions.set(decl.property, []);
        definitions.get(decl.property).push(text);
        return;
      }
      for (const match of text.matchAll(VAR_REFERENCE)) used.add(match[1]);
    },
  });

  // A property read by a used property is used.
  const queue = [...used];
  while (queue.length > 0) {
    const name = queue.pop();
    for (const text of definitions.get(name) ?? []) {
      for (const match of text.matchAll(VAR_REFERENCE)) {
        if (!used.has(match[1])) {
          used.add(match[1]);
          queue.push(match[1]);
        }
      }
    }
  }

  csstree.walk(ast, {
    visit: 'Declaration',
    enter(decl, item, list) {
      if (list && decl.property.startsWith('--') && !used.has(decl.property)) list.remove(item);
    },
  });

  // Rules and at-rules left empty go too.
  csstree.walk(ast, {
    leave(node, item, list) {
      if (!list) return;
      if ((node.type === 'Rule' || node.type === 'Atrule') && node.block?.children.isEmpty) {
        if (node.type === 'Atrule' && /^(layer|import)$/i.test(node.name)) return;
        list.remove(item);
      }
    },
  });

  return csstree.generate(ast);
}

/**
 * Inserts `extra` into the stylesheet right after the first rule whose
 * selector is exactly `selector`, inside the same block (and so the same
 * cascade layer). Rules placed there beat that utility but lose to every
 * utility and variant that comes after it, as an unlayered rule would not.
 */
export function insertAfterRule(css, selector, extra) {
  const ast = csstree.parse(css, { parseCustomProperty: false, onParseError: () => {} });
  const rules = csstree.parse(extra, { parseCustomProperty: false }).children;
  let done = false;
  csstree.walk(ast, {
    visit: 'Rule',
    enter(node, item, list) {
      if (done || !list || csstree.generate(node.prelude) !== selector) return;
      const before = item.next;
      for (const rule of rules.toArray()) list.insertData(rule, before);
      done = true;
    },
  });
  if (!done) throw new Error(`insertAfterRule: no rule for ${selector}`);
  return csstree.generate(ast);
}

/** Custom property names mentioned in source text (scripts, markup, CSS). */
export function referencedCustomProperties(text) {
  return new Set(String(text).match(/--[a-zA-Z][\w-]*/g) ?? []);
}
