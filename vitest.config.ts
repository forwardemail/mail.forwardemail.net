import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

const rootDir = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  plugins: [
    svelte({
      hot: false,
      compilerOptions: { dev: true },
    }),
  ],
  resolve: {
    alias: {
      $lib: path.resolve(rootDir, 'src/lib'),
    },
    conditions: ['browser'],
  },
  test: {
    environment: 'jsdom',
    // Several existing tests use describe/it/vi without importing them.
    // Vitest's default is globals:false, so we opt in explicitly.
    globals: true,
    include: ['tests/unit/**/*.{test,spec}.{js,ts}', 'tests/component/**/*.{test,spec}.{js,ts}'],
    setupFiles: ['tests/setup/global.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{js,ts,svelte}'],
      exclude: [
        'src/**/*.d.ts',
        'src/workers/**',
        'src/main.ts',
        'src/compose-main.ts',
        'src/polyfills.ts',
      ],
    },
  },
});
