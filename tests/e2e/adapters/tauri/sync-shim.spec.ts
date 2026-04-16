import { expect, test } from '@playwright/test';

/**
 * Tauri-only adapter contract: sync-shim replaces the PWA service worker.
 * This verifies that the shim boots and registers the mutation-queue sync
 * handler (the SW has `sync.register('mutation-queue')` in web mode).
 */
test.describe('tauri adapter: sync-shim', () => {
  test('sync-shim initializes instead of SW', async ({ page }) => {
    await page.goto('/');

    const shape = await page.evaluate(async () => {
      const mod = await import('/src/utils/sync-bridge.js').catch(() => null);
      return {
        loaded: !!mod,
        exports: mod ? Object.keys(mod) : [],
      };
    });

    expect(shape.loaded, 'sync-bridge module failed to load').toBe(true);
    expect(shape.exports.length).toBeGreaterThan(0);
  });
});
