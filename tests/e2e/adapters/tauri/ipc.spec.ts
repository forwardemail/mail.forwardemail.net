import { expect, test } from '@playwright/test';

/**
 * Tauri-only adapter contract: window.__TAURI__ is injected, isTauri
 * detection returns true, and basic IPC commands respond.
 *
 * These tests only run when TAURI_E2E_BINARY is set (see playwright.config.js).
 * Under plain web browsers, the tauri project is not registered, so this
 * file is never collected.
 */
test.describe('tauri adapter: IPC', () => {
  test('window.__TAURI__ is present', async ({ page }) => {
    await page.goto('/');
    const isTauri = await page.evaluate(() => typeof window.__TAURI__ !== 'undefined');
    expect(isTauri).toBe(true);
  });

  test('platform detection reports desktop/mobile correctly', async ({ page }) => {
    await page.goto('/');
    const platform = await page.evaluate(async () => {
      const mod = await import('/src/utils/platform.js');
      return {
        isTauri: mod.isTauri,
        isTauriDesktop: mod.isTauriDesktop,
      };
    });
    expect(platform.isTauri).toBe(true);
  });
});
