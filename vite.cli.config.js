import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { libsodiumResolverPlugin, stubTauriModulesPlugin } from './vite.config.js';
import { convertDeclarations } from './src/cli/px-to-cells.js';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

/**
 * Terminal (CLI) build of the webmail. Two passes, both driven by
 * scripts/build-cli.mjs:
 *
 *   --mode app       src/main.ts and everything it imports, unchanged, as
 *                    CommonJS, through src/cli/app-entry.ts (which also
 *                    hands the keyboard shortcut manager to the terminal
 *                    code). Its stylesheets are extracted to app.css.
 *   --mode launcher  src/cli/index.ts: argument parsing, the self-updater and
 *                    the TermDOM environment that stands in for the browser.
 *   --mode thread    src/cli/worker-thread.ts: the scope each Web Worker
 *                    thread starts with.
 *
 * The launcher has to run before any of the app's module code (which touches
 * `self`, `document` and `localStorage` at import time), so build-cli.mjs
 * wraps the app in a function the launcher calls once the environment is in
 * place, and writes both into one self-contained file.
 */
export const CLI_OUT_DIR = 'cli/dist';

const external = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

const define = {
  'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  'import.meta.env.VITE_BUILD_HASH': JSON.stringify('cli'),
  'import.meta.env.VITE_PKG_VERSION': JSON.stringify(pkg.version),
  'import.meta.env.VAPID_PUBLIC_KEY': JSON.stringify(''),
  // --api / FORWARDEMAIL_API_URL, read when the app starts (src/cli/index.ts).
  'import.meta.env.VITE_WEBMAIL_API_BASE': 'globalThis.__FORWARDEMAIL_API_URL__',
  // CLI_BUILD_DEV=1 keeps the app's development logging (useful with
  // FORWARDEMAIL_DEBUG=1, which writes the console to a log file).
  ...(process.env.CLI_BUILD_DEV ? { 'import.meta.env.DEV': 'true' } : {}),
};

// Web fonts are meaningless on a character grid and would add megabytes of
// base64 to the executable.
function stripFontFaces(css) {
  return css.replace(/@font-face\s*\{[^}]*\}/g, '');
}

// Static style="" attributes in components end up in Svelte's template
// strings, which the runtime clones without going through any style API, so
// their pixel lengths are converted here. Attributes with {expressions} are
// left as written.
function staticInlineStylesPlugin() {
  return {
    name: 'forwardemail-cli-static-inline-styles',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.svelte') || !code.includes('px')) return null;
      const next = code.replace(
        /(\sstyle=)"([^"{}]*px[^"{}]*)"/g,
        (_m, attr, value) => `${attr}"${convertDeclarations(value)}"`,
      );
      return next === code ? null : { code: next, map: null };
    },
  };
}

/**
 * Caches for three pure functions TermDOM calls on every restyle. Matching
 * a declaration against its property grammar is most of the time the
 * terminal spends on the webmail's (large) stylesheet, and the same
 * property/value pairs and class attributes recur across thousands of
 * elements. Each patch must apply exactly once, so a TermDOM upgrade that
 * moves the code fails the build instead of silently losing the caches.
 * These are candidates for upstreaming to TermDOM.
 */
const TERMDOM_PATCHES = [
  {
    find: 'function getGrammarTerms(property, value) {',
    replace: `var __feGrammarTerms = new Map();
function getGrammarTerms(property, value) {
  const key = property + "\\0" + value;
  let terms = __feGrammarTerms.get(key);
  if (terms === undefined) {
    terms = __feGrammarTermsUncached(property, value);
    if (__feGrammarTerms.size > 20000) __feGrammarTerms.clear();
    __feGrammarTerms.set(key, terms);
  }
  return terms === null ? null : terms.map((term) => ({ text: term.text, terms: term.terms.slice() }));
}
function __feGrammarTermsUncached(property, value) {`,
  },
  {
    find: `function matchesProperty(property, text) {
  return grammarLexer.matchProperty(property, text).matched !== null;
}`,
    replace: `var __feMatchesProperty = new Map();
function matchesProperty(property, text) {
  const key = property + "\\0" + text;
  let matches = __feMatchesProperty.get(key);
  if (matches === undefined) {
    matches = grammarLexer.matchProperty(property, text).matched !== null;
    if (__feMatchesProperty.size > 20000) __feMatchesProperty.clear();
    __feMatchesProperty.set(key, matches);
  }
  return matches;
}`,
  },
  {
    find: `        const quirks = isInQuirksMode(element);
        for (const token of splitOnWhitespace(value)) {
          if (quirks ? toASCIILowercase(token) === folded : token === name) {
            return true;
          }
        }
        return false;`,
    replace: `        if (!isInQuirksMode(element)) {
          return __feClassTokens(value).has(name);
        }
        for (const token of splitOnWhitespace(value)) {
          if (toASCIILowercase(token) === folded) {
            return true;
          }
        }
        return false;`,
  },
  {
    find: 'function splitOnWhitespace(text) {',
    replace: `var __feClassTokenSets = new Map();
function __feClassTokens(value) {
  let tokens = __feClassTokenSets.get(value);
  if (tokens === undefined) {
    tokens = new Set(splitOnWhitespace(value));
    if (__feClassTokenSets.size > 20000) __feClassTokenSets.clear();
    __feClassTokenSets.set(value, tokens);
  }
  return tokens;
}
function splitOnWhitespace(text) {`,
  },
  // The first read of each property on an element scans every rule the
  // element matches. Tailwind elements match dozens, a restyle reads about a
  // hundred properties per element, and a folder switch builds hundreds of
  // elements, which made it take seconds. The winning normal and !important
  // value of each property is merged once per rule list instead (shared
  // between elements by rule ids, as TermDOM's own resolved-value cache is).
  // Logical properties, which depend on direction, keep the scan.
  {
    find: `  for (const rule of declaration[kCSSRules]) {
    const name = getDeclaredName(rule, names, false, mapsHere);`,
    replace: `  const __feMerged = names.length === 1 ? __feMergedRules(declaration[kCSSRules]).get(names[0]) : void 0;
  if (__feMerged !== void 0) {
    ruleValue = __feMerged.value;
    importantRuleValue = __feMerged.important;
  }
  for (const rule of names.length === 1 ? [] : declaration[kCSSRules]) {
    const name = getDeclaredName(rule, names, false, mapsHere);`,
  },
  {
    find: 'function getRuleId(rule) {',
    replace: `var __feMergedByList = new WeakMap();
var __feMergedByIds = new Map();
function __feMergedRules(rules) {
  let merged = __feMergedByList.get(rules);
  if (merged !== void 0) return merged;
  let key = "";
  for (const rule of rules) {
    const id = getRuleId(rule);
    if (id === -1) {
      key = null;
      break;
    }
    key += id + ",";
  }
  merged = key === null ? void 0 : __feMergedByIds.get(key);
  if (merged === void 0) {
    merged = new Map();
    const origins = new Map();
    for (const rule of rules) {
      for (const name in rule.declarations) {
        const value = rule.declarations[name];
        if (value === void 0) continue;
        let entry = merged.get(name);
        if (entry === void 0) {
          entry = { value: "", important: "" };
          merged.set(name, entry);
        }
        if (!rule.important[name]) {
          entry.value = value;
          continue;
        }
        const origin = origins.get(name);
        if (entry.important === "" || Boolean(rule.uaOrigin) === origin.ua && rule.layerRank === origin.layer) {
          entry.important = value;
          origins.set(name, { ua: Boolean(rule.uaOrigin), layer: rule.layerRank });
        }
      }
    }
    if (key !== null) {
      if (__feMergedByIds.size > 20000) __feMergedByIds.clear();
      __feMergedByIds.set(key, merged);
    }
  }
  __feMergedByList.set(rules, merged);
  return merged;
}
function getRuleId(rule) {`,
  },
  // Selector matching lowercases every attribute name it looks up, almost
  // always already lowercase; skip the regex replace when there is nothing
  // to change.
  {
    find: `function toASCIILowercase(value) {
  return value.replace(`,
    replace: `function toASCIILowercase(value) {
  let upper = false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      upper = true;
      break;
    }
  }
  if (!upper) return value;
  return value.replace(`,
  },
  // Pure black. TermDOM's cell grid stores 0 for "the terminal's default
  // color", which is also the number for #000000, so black text (the light
  // theme's calendar, for one) was drawn in the terminal's own foreground:
  // light gray on a dark terminal, next to invisible on a white page. Black
  // is kept one step above zero, which no eye can tell apart.
  {
    find: '  return parseColor(cssColor)?.color ?? 0;',
    replace: `  const parsed = parseColor(cssColor);
  return parsed ? parsed.color || 1 : 0;`,
  },
  // A box laid out again with the constraints of its last placement reused
  // that placement whole, but its children's sizes may have been measured
  // again in between under other constraints. A message list row then kept
  // a sender and subject of zero width once the pointer had passed over the
  // row below it, and the row went blank. Boxes are placed again instead;
  // measuring stays cached, and the cost did not show in navigation timings.
  {
    find: `    if (node.cachedLayout && isMatchingConstraints(`,
    replace: `    if (false && node.cachedLayout && isMatchingConstraints(`,
  },
  // document.caretPositionFromPoint() and caretRangeFromPoint(), from
  // TermDOM's own hit testing. ProseMirror (the message editor) calls them on
  // every click in the editor to place the caret, and TermDOM threw "not
  // implemented", which the app reported as an error.
  {
    find: `  caretPositionFromPoint(x, y, options) {
    toDouble(x);
    toDouble(y);
    toDictionary(options ?? {}, "A CaretPositionFromPointOptions");
    throw domError(
      "NotSupportedError",
      "caretPositionFromPoint is not implemented"
    );
  }
  caretRangeFromPoint(_x, _y) {
    throw domError(
      "NotSupportedError",
      "caretRangeFromPoint is not implemented"
    );
  }`,
    replace: `  caretPositionFromPoint(x, y, options) {
    toDictionary(options ?? {}, "A CaretPositionFromPointOptions");
    const found = __feCaretAt(this, toDouble(x), toDouble(y));
    if (found === null) return null;
    const document = this;
    return {
      offsetNode: found.node,
      offset: found.offset,
      getClientRect() {
        const range = document.createRange();
        range.setStart(found.node, found.offset);
        range.collapse(true);
        return range.getBoundingClientRect();
      }
    };
  }
  caretRangeFromPoint(x, y) {
    const found = __feCaretAt(this, toDouble(x), toDouble(y));
    if (found === null) return null;
    const range = this.createRange();
    range.setStart(found.node, found.offset);
    range.collapse(true);
    return range;
  }`,
  },
  {
    find: 'function elementAtDocumentPoint(document, x, y, context = document) {',
    replace: `function __feCaretAt(document, x, y) {
  const attached = getAttachedDocument(document);
  const element = attached === void 0 ? null : elementAtDocumentPoint(document, x, y);
  if (element === null) return null;
  return attached[kLayout2].caretPositionFromPoint(x, y, element, true) ?? null;
}
function elementAtDocumentPoint(document, x, y, context = document) {`,
  },
  // Text positions under a point (selecting with the mouse, placing the
  // caret) also look inside open shadow trees, where the terminal client
  // renders message bodies (src/cli/frames.ts).
  {
    find: `  for (const child of Array.from(root.childNodes)) {
    yield* getTextNodes(child);
  }`,
    replace: `  const owner = root.shadowRoot ?? root;
  for (const child of Array.from(owner.childNodes)) {
    yield* getTextNodes(child);
  }`,
  },
  // CSS transitions. Once any element has had an inline transition, TermDOM
  // tracks transitions for every element, and each restyle evaluates every
  // transitionable property (seconds per navigation). A character grid has
  // nothing to animate, and the stylesheet's transitions are already pruned,
  // so styles always take their end value at once.
  {
    find: '  if (!cascade[kTransitionsExist] && !active) {',
    replace: `  if (!active) {
    return;
  }
  if (!cascade[kTransitionsExist] && !active) {`,
  },
  // ESC followed by a key in one read is Escape, then that key. TermDOM reads
  // it as Alt+key (the old Meta prefix), but the same bytes arrive whenever
  // Esc and the next key are pressed while the client is busy drawing, and
  // both presses were lost: Esc then Ctrl+N did nothing. The webmail has no
  // Alt shortcuts, and terminals that report Alt as a modifier (CSI u,
  // modifyOtherKeys) send sequences this does not touch.
  {
    find: '          items.push({ ...item, char: "", altKey: true });',
    // Alt+Backspace and Alt+B/F/D, the word-editing keys terminals send
    // with an Esc prefix (macOS Option as Meta), keep their Alt meaning: an
    // Esc there would also close the dialog being typed in.
    replace: `          if (item.key === "Backspace" || /^[bfd]$/.test(item.key)) {
            items.push({ ...item, char: "", altKey: true });
          } else {
            items.push(decodeKeyToken("\\x1B"), item);
          }`,
  },
  // A terminal sends a shifted character (?, A, !) as the character itself,
  // with no modifier. A browser reports Shift held for it, and the webmail's
  // shortcuts depend on that: "?" is bound as shift+/ and would never fire.
  {
    find: '  const { key: keyName, char, shiftKey, ctrlKey, altKey, metaKey } = stroke;',
    replace: `  const { key: keyName, char, ctrlKey, altKey, metaKey } = stroke;
  const shiftKey = stroke.shiftKey || /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/.test(keyName);`,
  },
  // color-mix(), which Tailwind uses for every translucent color (bg-muted/50,
  // text-foreground/70). Without it those colors parse as nothing and paint
  // the terminal's own background: black bars in a dark terminal, white in a
  // light one. Mixed in sRGB with premultiplied alpha.
  {
    find: `  if (functionMatch) {
    return parseColorFunction(functionMatch[1], functionMatch[2]);
  }
  return null;
}`,
    replace: `  if (functionMatch) {
    return parseColorFunction(functionMatch[1], functionMatch[2]);
  }
  if (color.startsWith("color-mix(") && color.endsWith(")")) {
    return __feParseColorMix(color.slice(10, -1));
  }
  return null;
}
function __feSplitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}
function __feParseColorMix(args) {
  const parts = __feSplitTopLevel(args);
  if (parts.length !== 3 || !/^in\\s/.test(parts[0])) return null;
  const sides = parts.slice(1).map((part) => {
    const match = part.match(/^(?:(-?[\\d.]+)%\\s+)?(.*?)(?:\\s+(-?[\\d.]+)%)?$/);
    if (!match) return null;
    const color = match[2] === "transparent" ? { color: 0, alpha: 0 } : parseColor(match[2]);
    const pct = match[1] ?? match[3];
    return color ? { color, pct: pct === undefined ? null : Number(pct) } : null;
  });
  if (sides.some((side) => side === null)) return null;
  let [p1, p2] = sides.map((side) => side.pct);
  if (p1 === null && p2 === null) p1 = p2 = 50;
  else if (p1 === null) p1 = 100 - p2;
  else if (p2 === null) p2 = 100 - p1;
  const sum = p1 + p2;
  if (!(sum > 0)) return null;
  const w1 = p1 / sum;
  const w2 = p2 / sum;
  const [a, b] = sides.map((side) => side.color);
  const alpha = a.alpha * w1 + b.alpha * w2;
  const channel = (shift) => {
    if (alpha === 0) return 0;
    const value = (((a.color >> shift) & 255) * a.alpha * w1 + ((b.color >> shift) & 255) * b.alpha * w2) / alpha;
    return Math.max(0, Math.min(255, Math.round(value)));
  };
  return {
    color: (channel(16) << 16) | (channel(8) << 8) | channel(0),
    alpha: alpha * Math.min(1, sum / 100),
  };
}`,
  },
];

// bits-ui (menus, selects, popovers, tooltips) places floating content with
// left: 0; top: 0 and a transform, which TermDOM does not draw: every menu
// would open in the top-left corner and catch the clicks meant for what is
// under it. The library's own non-transform mode sets left and top instead.
// While a popup is still being measured it is hidden rather than moved off
// screen with a transform.
const BITS_UI_PATCHES = {
  'internal/floating-svelte/use-floating.svelte.js': [
    {
      find: '        if (transformOption) {',
      replace: '        if (false) {',
    },
  ],
  'bits/utilities/floating-layer/use-floating-layer.svelte.js': [
    {
      find: `            transform: this.floating.isPositioned
                ? this.floating.floatingStyles.transform
                : "translate(0, -200%)",`,
      replace: `            ...(!this.floating.isPositioned && { visibility: "hidden" }),`,
    },
  ],
};

/**
 * Applies exact-match source patches to dependencies. Each must match once,
 * so an upgrade that changes the patched code fails the build instead of
 * silently dropping the fix.
 */
function sourcePatchesPlugin(name, patchesFor) {
  return {
    name,
    transform(code, id) {
      const patches = patchesFor(id.replace(/\\/g, '/'));
      if (!patches) return null;
      let next = code;
      for (const { find, replace } of patches) {
        const count = next.split(find).length - 1;
        if (count !== 1) {
          throw new Error(
            `${name}: expected one match in ${id}, found ${count}: ${find.split('\\n')[0]}`,
          );
        }
        next = next.replace(find, () => replace);
      }
      return { code: next, map: null };
    },
  };
}

function termdomCachesPlugin() {
  return sourcePatchesPlugin('forwardemail-cli-termdom-patches', (id) =>
    /\/@b9g\/termdom\/index\.js$/.test(id) ? TERMDOM_PATCHES : null,
  );
}

// TipTap adds its stylesheet to <head> when the first editor is created.
// Any new stylesheet makes TermDOM re-parse every rule of every sheet, which
// with the webmail's stylesheet delayed the first compose window by a third
// of a second. Created when the module loads instead, it is parsed with the
// app's own sheets at startup, and TipTap reuses it.
const TIPTAP_PATCHES = [
  {
    find: 'class Editor extends EventEmitter {',
    replace: `if (typeof document !== "undefined") createStyleTag(style);
class Editor extends EventEmitter {`,
  },
];

function tiptapStylePlugin() {
  return sourcePatchesPlugin('forwardemail-cli-tiptap-style', (id) =>
    /\/@tiptap\/core\/dist\/index\.js$/.test(id) ? TIPTAP_PATCHES : null,
  );
}

function bitsUiFloatingPlugin() {
  return sourcePatchesPlugin('forwardemail-cli-bits-ui-floating', (id) => {
    const match = id.match(/\/bits-ui\/dist\/(.+)$/);
    return match ? (BITS_UI_PATCHES[match[1]] ?? null) : null;
  });
}

// Lucide icons draw SVG paths, which a terminal cannot show. Every icon
// component renders through its package's ./Icon.svelte; the terminal build
// swaps that one file for a text-glyph version.
const LUCIDE_ICON = path.resolve('./src/cli/components/LucideIcon.svelte');
function lucideGlyphsPlugin() {
  return {
    name: 'forwardemail-cli-lucide-glyphs',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        /^\.\.?\/(\.\.\/)*Icon\.svelte$/.test(source) &&
        importer &&
        /(lucide-svelte|@lucide[\\/]svelte)[\\/]dist[\\/]/.test(importer)
      ) {
        return LUCIDE_ICON;
      }
      return null;
    },
  };
}

function collectCssPlugin() {
  return {
    name: 'forwardemail-cli-collect-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      let css = '';
      for (const [name, output] of Object.entries(bundle)) {
        if (output.type !== 'asset') continue;
        if (name.endsWith('.css')) css += String(output.source);
        delete bundle[name];
      }
      this.emitFile({ type: 'asset', fileName: 'app.css', source: stripFontFaces(css) });
    },
  };
}

const ENTRIES = {
  app: ['./src/cli/app-entry.ts', 'app.cjs'],
  launcher: ['./src/cli/index.ts', 'launcher.cjs'],
  thread: ['./src/cli/worker-thread.ts', 'thread.cjs'],
};

export default defineConfig(({ mode }) => {
  const isApp = mode === 'app';
  const [entry, fileName] = ENTRIES[mode] ?? ENTRIES.launcher;
  return {
    root: '.',
    publicDir: false,
    define,
    resolve: {
      alias: {
        $lib: path.resolve('./src/lib'),
        $types: path.resolve('./src/types'),
      },
      dedupe: ['svelte', 'svelte/internal', 'svelte/internal/client'],
    },
    worker: {
      // Workers run in-process from their inline source (src/cli/worker.ts),
      // which needs a single classic script per worker.
      format: 'iife',
      plugins: () => [libsodiumResolverPlugin(), stubTauriModulesPlugin()],
    },
    logLevel: process.env.CLI_BUILD_VERBOSE ? 'info' : 'warn',
    build: {
      target: 'node22',
      outDir: CLI_OUT_DIR,
      emptyOutDir: false,
      sourcemap: false,
      // CLI_BUILD_MINIFY=0 keeps names readable, for profiling.
      minify: process.env.CLI_BUILD_MINIFY !== '0',
      assetsInlineLimit: 0,
      cssCodeSplit: false,
      reportCompressedSize: false,
      copyPublicDir: false,
      lib: {
        entry,
        formats: ['cjs'],
        fileName: () => fileName,
      },
      rollupOptions: {
        external,
        output: { inlineDynamicImports: true, exports: 'auto' },
      },
    },
    plugins: isApp
      ? [
          libsodiumResolverPlugin(),
          stubTauriModulesPlugin(),
          staticInlineStylesPlugin(),
          lucideGlyphsPlugin(),
          bitsUiFloatingPlugin(),
          tiptapStylePlugin(),
          svelte({ onwarn: process.env.CLI_BUILD_VERBOSE ? undefined : () => {} }),
          collectCssPlugin(),
        ]
      : [termdomCachesPlugin()],
  };
});
