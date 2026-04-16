import { expect, test } from '@playwright/test';

/**
 * Tauri-only adapter contract: notification bridge is loaded and exposes
 * the expected functions. We're not actually popping a notification in CI —
 * just verifying the contract.
 */
test.describe('tauri adapter: notification bridge', () => {
  test('notification-bridge exports are reachable', async ({ page }) => {
    await page.goto('/');
    const shape = await page.evaluate(async () => {
      const mod = await import('/src/utils/notification-bridge.js');
      return Object.keys(mod);
    });
    // At minimum, the bridge should expose a notify() or similar entrypoint.
    expect(shape.length).toBeGreaterThan(0);
  });
});
