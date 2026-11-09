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
 * Changes to TermDOM's built code. Each patch must apply exactly once, so a
 * TermDOM upgrade that moves the code fails the build instead of silently
 * losing the change.
 */
const TERMDOM_PATCHES = [
  // ESC followed by a key in one read is Escape, then that key. TermDOM reads
  // it as Alt+key (the old Meta prefix), but the same bytes arrive whenever
  // Esc and the next key are pressed while the client is busy drawing, and
  // both presses were lost: Esc then Ctrl+N did nothing. The webmail has no
  // Alt shortcuts, and terminals with the kitty keyboard protocol send Esc as
  // its own sequence, which this does not touch.
  {
    find: `    items.push({ ...item, char: "", altKey: true });
    return i + 1 + width;`,
    // Alt+Backspace and Alt+B/F/D, the word-editing keys terminals send
    // with an Esc prefix (macOS Option as Meta), keep their Alt meaning: an
    // Esc there would also close the dialog being typed in.
    replace: `    if (item.key === "Backspace" || /^[bfd]$/.test(item.key)) {
      items.push({ ...item, char: "", altKey: true });
    } else {
      items.push(decodeKeyToken("\\x1B"), item);
    }
    return i + 1 + width;`,
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
