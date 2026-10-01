/**
 * CSS lengths on a character grid.
 *
 * TermDOM lays out in whole terminal cells and treats one CSS pixel as one
 * cell, so the webmail's lengths (a 240px sidebar, 1rem of padding,
 * `@media (min-width: 821px)`) would come out 8 to 16 times too large. The
 * terminal build treats a cell as a block of virtual pixels instead, like a
 * high-DPI screen in reverse: a column is PX_PER_COLUMN pixels wide and a row
 * PX_PER_ROW pixels tall, which is the shape of a terminal cell, and 1rem is
 * the usual 16px.
 *
 * Every px, rem and em length in the stylesheet, in inline styles and in
 * media queries is converted to whole cells along the axis it applies to.
 * Rows round down (a 12px vertical padding is not worth a whole row) and
 * columns round to nearest (any gap wider than zero keeps at least one
 * column). Tailwind's `calc(var(--spacing) * n)` utilities are folded to a
 * single length first so they round like everything else. Font sizes and
 * line heights are dropped: every glyph is one cell.
 *
 * A custom property holding a length (--fe-space-3: 12px) can end up on
 * either axis, so each one gets a vertical twin (--fe-space-3-v) converted as
 * rows, and vertical declarations are pointed at the twins.
 *
 * Plain JS so scripts/build-cli.mjs can run it over the compiled stylesheet
 * at build time and the launcher can run it over styles set at runtime.
 */
import * as csstree from 'css-tree';

export const PX_PER_COLUMN = 8;
export const PX_PER_ROW = 16;
const PX_PER_REM = 16;
const SPACING_PX = 4; // Tailwind's --spacing: 0.25rem

const H = 'h';
const V = 'v';
const BORDER = 'border';

// Properties whose value is drawn, not laid out: nothing to convert.
const SKIP = new Set([
  'box-shadow',
  'text-shadow',
  'filter',
  'backdrop-filter',
  'background',
  'background-image',
  'background-size',
  'background-position',
  'mask',
  'mask-image',
  'mask-size',
  'clip-path',
  'content',
  'font',
  'transition',
  'animation',
  'letter-spacing',
  'word-spacing',
  'perspective',
  'text-underline-offset',
  'text-decoration-thickness',
  'outline-offset',
]);

// One glyph is one cell whatever the font size.
const DROP = new Set(['font-size', 'line-height']);

// Shorthands laid out top, right, bottom, left.
const BOX_SHORTHANDS = new Set(['margin', 'padding', 'inset', 'scroll-margin', 'scroll-padding']);

export function pxToCells(px, axis) {
  if (axis === BORDER) return px > 0 ? 1 : px < 0 ? -1 : 0;
  const sign = px < 0 ? -1 : 1;
  const abs = Math.abs(px);
  if (abs === 0) return 0;
  if (axis === V) return sign * Math.floor(abs / PX_PER_ROW + 0.2);
  return sign * Math.max(1, Math.round(abs / PX_PER_COLUMN));
}

function toPx(value, unit) {
  const n = Number(value);
  switch (unit.toLowerCase()) {
    case 'px':
      return n;
    case 'rem':
    case 'em':
      return n * PX_PER_REM;
    default:
      return null;
  }
}

function axisForProperty(property) {
  const p = property.toLowerCase();
  if (SKIP.has(p)) return null;
  if (p.includes('radius')) return null;
  if (p.startsWith('border') || p.startsWith('outline') || p === 'column-rule-width') {
    return BORDER;
  }
  if (p.startsWith('--')) {
    if (p === '--spacing' || /shadow|blur|tracking|leading|ease|duration/.test(p)) return null;
    return H;
  }
  if (/height|top|bottom|block|row/.test(p)) return V;
  if (/width|left|right|inline|column|flex|indent|basis/.test(p)) return H;
  return null;
}

/** Axis of the i-th of n space-separated components, or null to skip. */
function planFor(property) {
  const p = property.toLowerCase();
  if (BOX_SHORTHANDS.has(p)) {
    return (i, n) => (n === 1 ? 'both' : ([V, H, V, H][i] ?? null));
  }
  if (p === 'gap' || p === 'grid-gap') return (i, n) => (n === 1 ? 'both' : ([V, H][i] ?? null));
  if (p === 'border-spacing' || p === 'translate') return (i) => [H, V][i] ?? null;
  const axis = axisForProperty(p);
  return axis ? () => axis : null;
}

const isSpacingVar = (node) =>
  node.type === 'Function' &&
  node.name.toLowerCase() === 'var' &&
  node.children.first?.type === 'Identifier' &&
  node.children.first.name === '--spacing';

// calc(var(--spacing) * 4) -> 16px, var(--spacing) -> 4px, and
// calc(16px * 2) -> 32px, so the whole expression rounds once.
function foldSpacing(node) {
  csstree.walk(node, {
    leave(child, item, list) {
      if (!list) return;
      if (isSpacingVar(child)) {
        list.replace(
          item,
          list.createItem({ type: 'Dimension', value: String(SPACING_PX), unit: 'px' }),
        );
        return;
      }
      if (child.type === 'Function' && child.name.toLowerCase() === 'calc') {
        const parts = child.children.toArray().filter((p) => p.type !== 'WhiteSpace');
        if (parts.length === 3 && parts[1].type === 'Operator' && parts[1].value.trim() === '*') {
          const [a, , b] = parts;
          const dim = a.type === 'Dimension' ? a : b.type === 'Dimension' ? b : null;
          const num = a.type === 'Number' ? a : b.type === 'Number' ? b : null;
          if (dim && num && toPx(dim.value, dim.unit) !== null) {
            const px = toPx(dim.value, dim.unit) * Number(num.value);
            list.replace(
              item,
              list.createItem({ type: 'Dimension', value: String(px), unit: 'px' }),
            );
          }
        } else if (parts.length === 1 && parts[0].type === 'Dimension') {
          list.replace(item, list.createItem(parts[0]));
        }
      }
    },
  });
}

// Names of custom properties that hold lengths, set while converting a
// stylesheet: vertical uses of them read the -v twin.
let lengthVars = new Set();
const VERTICAL_SUFFIX = '-v';

function convertDimensions(node, axis) {
  csstree.walk(node, {
    enter(child) {
      if (child.type === 'Url') return csstree.walk.skip;
      if (
        axis === V &&
        child.type === 'Function' &&
        child.name.toLowerCase() === 'var' &&
        child.children.first?.type === 'Identifier' &&
        lengthVars.has(child.children.first.name)
      ) {
        child.children.first.name += VERTICAL_SUFFIX;
      }
      if (child.type === 'Dimension') {
        const px = toPx(child.value, child.unit);
        if (px === null) return undefined;
        child.value = String(pxToCells(px, axis));
        child.unit = 'px';
      }
      return undefined;
    },
  });
}

function convertTransform(valueNode) {
  csstree.walk(valueNode, {
    visit: 'Function',
    enter(fn) {
      const name = fn.name.toLowerCase();
      const args = [];
      fn.children.forEach((child) => {
        if (child.type !== 'Operator' && child.type !== 'WhiteSpace') args.push(child);
      });
      const plan =
        name === 'translatex'
          ? [H]
          : name === 'translatey'
            ? [V]
            : name === 'translate' || name === 'translate3d'
              ? [H, V]
              : [];
      args.forEach((arg, i) => plan[i] && convertDimensions(arg, plan[i]));
    },
  });
}

// Custom properties are kept as raw text by the parser.
function convertRaw(text, axis) {
  let out = text.replace(/url\([^)]*\)|(-?\d*\.?\d+)(px|rem|em)\b/gi, (match, number, unit) =>
    number === undefined ? match : `${pxToCells(toPx(number, unit), axis)}px`,
  );
  if (axis === V) {
    out = out.replace(/var\(\s*(--[\w-]+)/g, (match, name) =>
      lengthVars.has(name) ? `var(${name}${VERTICAL_SUFFIX}` : match,
    );
  }
  return out;
}

const RAW_LENGTH = /(-?\d*\.?\d+)(px|rem|em)\b/i;

// Custom properties whose value is a length or refers to one.
function collectLengthVars(ast) {
  const values = new Map();
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(decl) {
      if (!decl.property.startsWith('--') || decl.property === '--spacing') return;
      const text = decl.value.type === 'Raw' ? decl.value.value : csstree.generate(decl.value);
      if (!values.has(decl.property)) values.set(decl.property, []);
      values.get(decl.property).push(text);
    },
  });
  const found = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, texts] of values) {
      if (found.has(name) || !axisForProperty(name)) continue;
      const isLength = texts.some(
        (text) =>
          (RAW_LENGTH.test(text) && !/url\(/i.test(text)) ||
          [...text.matchAll(/var\(\s*(--[\w-]+)/g)].some((m) => found.has(m[1])),
      );
      if (isLength) {
        found.add(name);
        changed = true;
      }
    }
  }
  return found;
}

function hasLength(node) {
  let found = false;
  csstree.walk(node, {
    enter(d) {
      if (d.type === 'Dimension' && toPx(d.value, d.unit) !== null) found = true;
      if (isSpacingVar(d)) found = true;
      if (
        d.type === 'Function' &&
        d.name.toLowerCase() === 'var' &&
        lengthVars.has(d.children.first?.name)
      ) {
        found = true;
      }
    },
  });
  return found;
}

// Returns false when the declaration should be removed.
function convertDeclaration(decl) {
  const property = decl.property.toLowerCase();
  if (DROP.has(property)) return false;

  if (decl.value.type === 'Raw') {
    const axis = axisForProperty(property);
    if (axis) decl.value.value = convertRaw(decl.value.value, axis);
    return true;
  }
  if (property.startsWith('--')) return true;

  if (!hasLength(decl.value)) return true;

  if (property === 'transform') {
    convertTransform(decl.value);
    return true;
  }

  const plan = planFor(property);
  if (!plan) return true;

  foldSpacing(decl.value);

  const components = [];
  decl.value.children.forEach((child) => {
    if (child.type !== 'Operator' && child.type !== 'WhiteSpace') components.push(child);
  });

  components.forEach((component, i) => {
    const axis = plan(i, components.length);
    if (!axis) return;
    if (axis === 'both') {
      // One value for both axes: split it so rows and columns each get theirs.
      const vertical = csstree.clone(component);
      convertDimensions(vertical, V);
      convertDimensions(component, H);
      decl.value.children.prependData(vertical);
      return;
    }
    convertDimensions(component, axis);
  });
  return true;
}

function convertPrelude(prelude) {
  let feature = '';
  csstree.walk(prelude, {
    enter(node) {
      if (node.type === 'Feature' || node.type === 'MediaFeature') feature = node.name;
      if (node.type === 'FeatureRange') {
        feature = '';
        csstree.walk(node, {
          visit: 'Identifier',
          enter(id) {
            feature ||= id.name;
          },
        });
      }
      if (node.type === 'Dimension') {
        const px = toPx(node.value, node.unit);
        if (px === null) return;
        // Breakpoints are compared, not drawn: keep the fraction.
        const size = /height/i.test(feature) ? PX_PER_ROW : PX_PER_COLUMN;
        node.value = String(Math.round((px / size) * 1000) / 1000);
        node.unit = 'px';
      }
    },
  });
}

function convertDeclarationList(ast, skipTwins = false) {
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(node, item, list) {
      // A twin is already in rows.
      if (
        skipTwins &&
        node.property.endsWith(VERTICAL_SUFFIX) &&
        lengthVars.has(node.property.slice(0, -2))
      ) {
        return;
      }
      if (!convertDeclaration(node) && list) list.remove(item);
    },
  });
}

/** Converts every length in a stylesheet. */
export function convertStylesheet(css) {
  const ast = csstree.parse(css, {
    parseCustomProperty: false,
    onParseError: () => {},
  });
  lengthVars = collectLengthVars(ast);
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(decl, item, list) {
      if (!list || !lengthVars.has(decl.property) || decl.value.type !== 'Raw') return;
      list.insertData(
        {
          type: 'Declaration',
          important: decl.important,
          property: decl.property + VERTICAL_SUFFIX,
          value: { type: 'Raw', value: convertRaw(decl.value.value, V) },
        },
        item.next,
      );
    },
  });
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node) {
      if (node.prelude && /^(media|container)$/i.test(node.name)) {
        if (node.prelude.type === 'Raw') {
          node.prelude.value = convertMediaQuery(node.prelude.value);
        } else {
          convertPrelude(node.prelude);
        }
      }
    },
  });
  convertDeclarationList(ast, true);
  lengthVars = new Set();
  return csstree.generate(ast);
}

/** Converts a declaration list such as an element's style attribute. */
export function convertDeclarations(text) {
  if (!/px|r?em|--spacing/i.test(text)) return text;
  const ast = csstree.parse(text, {
    context: 'declarationList',
    parseCustomProperty: false,
    onParseError: () => {},
  });
  convertDeclarationList(ast);
  return csstree.generate(ast);
}

/** Converts the lengths of a media query, as matchMedia() receives it. */
export function convertMediaQuery(query) {
  return String(query).replace(
    /((?:min-|max-)?(?:device-)?(width|height)\s*(?:[:<>=]+)\s*)(-?\d*\.?\d+)(px|rem|em)/gi,
    (_match, prefix, dimension, number, unit) => {
      const size = /height/i.test(dimension) ? PX_PER_ROW : PX_PER_COLUMN;
      return `${prefix}${Math.round((toPx(number, unit) / size) * 1000) / 1000}px`;
    },
  );
}
