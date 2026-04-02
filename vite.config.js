import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults } from 'vitest/config';
import { visualizer } from 'rollup-plugin-visualizer';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const enableAnalyzer = process.env.ANALYZE === 'true';

// Tauri sets TAURI_ENV_PLATFORM during `tauri build` / `tauri dev`.
// When building for Tauri, @tauri-apps/* packages must be bundled so
// they're available in the packaged app. For web builds they stay
// external (dynamic imports fall back to no-ops).
const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM);

// Generate build hash for version tracking
const BUILD_HASH = createHash('md5')
  .update(`${pkg.version}-${Date.now()}`)
  .digest('hex')
  .slice(0, 8);
const APP_VERSION = `${pkg.version}-${BUILD_HASH}`;

// Resolve the libsodium core ESM file path.
// pnpm's strict layout means the ESM wrappers file's relative import
// `from "./libsodium.mjs"` cannot find the core package as a sibling.
// We locate it once at config time and redirect the import via a plugin.
function findLibsodiumCorePath() {
  try {
    // Resolve the libsodium core package directly — works cross-platform
    // and across pnpm's strict layout without shelling out to `find`.
    const corePath = require.resolve('libsodium');
    // corePath points to the CJS entry; find the ESM sibling
    const coreDir = path.dirname(corePath);
    const esmPath = path.join(coreDir, '..', 'modules-esm', 'libsodium.mjs');
    if (fs.existsSync(esmPath)) return esmPath;

    // Fallback: walk up from the wrappers entry to the pnpm store
    const wrappersEntry = require.resolve('libsodium-wrappers');
    const normalized = wrappersEntry.split(path.sep).join('/');
    const storeIdx = normalized.indexOf('node_modules/.pnpm/');
    if (storeIdx !== -1) {
      const pnpmStore = wrappersEntry.substring(0, storeIdx + 'node_modules/.pnpm/'.length);
      // Search for any libsodium version in the store
      const entries = fs.readdirSync(pnpmStore).filter((e) => e.startsWith('libsodium@'));
      for (const entry of entries) {
        const candidate = path.join(
          pnpmStore,
          entry,
          'node_modules',
          'libsodium',
          'dist',
          'modules-esm',
          'libsodium.mjs',
        );
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

const LIBSODIUM_CORE_ESM = findLibsodiumCorePath();

/**
 * Vite/Rollup plugin to fix libsodium ESM resolution under pnpm.
 *
 * The `libsodium-wrappers` ESM entry imports `from "./libsodium.mjs"` but
 * under pnpm's strict layout the core `libsodium` package is not a sibling
 * directory.  This plugin intercepts that broken relative import and
 * redirects it to the actual file on disk.
 */
function libsodiumResolverPlugin() {
  return {
    name: 'libsodium-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        LIBSODIUM_CORE_ESM &&
        importer &&
        importer.includes('libsodium-wrappers') &&
        (source === './libsodium.mjs' || source === './libsodium-sumo.mjs')
      ) {
        return LIBSODIUM_CORE_ESM;
      }
      return null;
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  // Inject version at build time for version negotiation
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
    'import.meta.env.VITE_BUILD_HASH': JSON.stringify(BUILD_HASH),
    'import.meta.env.VITE_PKG_VERSION': JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
      $types: path.resolve('./src/types'),
    },
  },
  // Exclude libsodium-wrappers from esbuild dep pre-bundling.
  // Its ESM entry uses a relative import ("./libsodium.mjs") that breaks
  // under pnpm's strict layout.  The Rollup plugin above handles the
  // production build; for the dev server we simply skip pre-bundling so
  // Vite serves the files directly and our resolveId hook can intercept.
  optimizeDeps: {
    // Pre-bundle deps that live behind dynamic imports (Calendar.svelte,
    // Compose.svelte) so Vite discovers them at startup instead of mid-session.
    // Late discovery triggers dep re-optimization which regenerates ALL chunk
    // hashes and 404s every chunk URL the browser already loaded.
    include: [
      // Calendar.svelte deps
      '@schedule-x/calendar',
      '@schedule-x/svelte',
      // NOTE: @schedule-x/theme-default is CSS-only (no JS entry) so it
      // cannot be pre-bundled.  Vite handles CSS imports separately.
      // Compose.svelte deps (only used behind dynamic import)
      '@tiptap/extension-placeholder',
      '@tiptap/extension-highlight',
      '@tiptap/extension-underline',
      '@tiptap/extension-text-style',
      '@tiptap/extension-text-align',
      '@tiptap/extension-color',
      '@tiptap/extension-font-family',
      '@tiptap/extension-image',
      '@tiptap/extension-table',
      '@tiptap/extension-table-row',
      '@tiptap/extension-table-cell',
      '@tiptap/extension-table-header',
    ],
    exclude: ['libsodium-wrappers'],
  },
  esbuild: {
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      // Tauri APIs are only available in the Tauri runtime; exclude from web builds.
      // Dynamic imports in the code already guard against calling them on web.
      // When building for Tauri (TAURI_ENV_PLATFORM is set), these must be
      // bundled so they resolve in the packaged webview.
      ...(isTauriBuild
        ? {}
        : {
            external: [
              '@tauri-apps/api/core',
              '@tauri-apps/api/event',
              '@tauri-apps/api/window',
              '@tauri-apps/plugin-notification',
              '@tauri-apps/plugin-updater',
              '@tauri-apps/plugin-os',
              '@tauri-apps/plugin-deep-link',
              '@tauri-apps/plugin-process',
              'tauri-plugin-remote-push-api',
            ],
          }),
      input: {
        main: './index.html',
        compose: './compose.html',
      },
      output: {
        manualChunks: {
          vendor: [
            'svelte',
            'dexie',
            'ky',
            'dompurify',
            'flexsearch',
            'openpgp',
            '@tiptap/core',
            '@tiptap/starter-kit',
            '@tiptap/extension-link',
            '@schedule-x/calendar',
            '@schedule-x/svelte',
          ],
        },
      },
    },
  },
  plugins: [
    libsodiumResolverPlugin(),
    // Tauri injects IPC bootstrap scripts into the webview and adds the
    // correct nonces/hashes to the CSP configured in tauri.conf.json.
    // However, it does NOT modify CSP <meta> tags in the HTML.  If both
    // exist the browser applies the most restrictive union, which blocks
    // Tauri's injected scripts and causes a blank screen.  Strip the
    // meta-tag CSP for Tauri builds — tauri.conf.json handles it.
    // The tauri.conf.json CSP matches or exceeds the meta-tag policy:
    //   - default-src 'self' ipc: https://ipc.localhost
    //   - script-src 'self' 'wasm-unsafe-eval'
    //   - connect-src includes wss://api.forwardemail.net for WebSocket
    //   - worker-src 'self' blob: for sync/search workers
    //   - object-src 'none' (strict)
    isTauriBuild && {
      name: 'strip-csp-meta-for-tauri',
      transformIndexHtml(html) {
        return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
      },
    },
    svelte(),
    enableAnalyzer &&
      visualizer({
        filename: 'dist/stats.html',
        template: 'treemap',
        gzipSize: true,
        brotliSize: true,
      }),
  ].filter(Boolean),
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: [...configDefaults.exclude, 'tests/e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
