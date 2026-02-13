import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import AutoImport from 'unplugin-auto-import/vite';
import Icons from 'unplugin-icons/vite';
import IconsResolver from 'unplugin-icons/resolver';
import { configDefaults } from 'vitest/config';
import { visualizer } from 'rollup-plugin-visualizer';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const enableAnalyzer = process.env.ANALYZE === 'true';

// Generate build hash for version tracking
const BUILD_HASH = createHash('md5')
  .update(`${pkg.version}-${Date.now()}`)
  .digest('hex')
  .slice(0, 8);
const APP_VERSION = `${pkg.version}-${BUILD_HASH}`;

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
  esbuild: {
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: './index.html',
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
    Icons({
      compiler: 'svelte',
    }),
    AutoImport({
      dts: true,
      eslintrc: { enabled: true },
      resolvers: [
        IconsResolver({
          prefix: false,
          enabledCollections: ['lucide'],
        }),
      ],
    }),
    svelte(),
    enableAnalyzer &&
      visualizer({
        filename: 'dist/stats.html',
        template: 'treemap',
        gzipSize: true,
        brotliSize: true,
      }),
  ],
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
