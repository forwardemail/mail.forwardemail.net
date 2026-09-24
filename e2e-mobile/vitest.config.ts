import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['specs/**/*.spec.ts'],
    setupFiles: ['./setup/undici-dispatcher.ts', './setup/per-test.ts'],
    // Appium sessions are heavyweight — keep file-level parallelism off.
    fileParallelism: false,
    // Cold-start emulator + WebView appearance can take 30–60s.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    reporters: ['default', ['junit', { outputFile: './reports/junit.xml' }]],
  },
});
