import { defineConfig } from 'vitest/config';

/**
 * Tests for the terminal client (src/cli). They run in Node, not jsdom, and
 * the end-to-end ones start the built client (pnpm build:cli), so they are
 * kept apart from the unit suite: `pnpm test:cli`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/cli/**/*.test.{js,ts}'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each interactive test drives a full client; running them side by side
    // only makes them compete for the CPU.
    fileParallelism: false,
  },
});
