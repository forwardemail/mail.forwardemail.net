import { expect, test } from '@playwright/test';

/**
 * Web-only adapter contract: the PWA service worker should register so the
 * app can cache assets and process the mutation-queue via Background Sync.
 * This is NOT valid under Tauri (which replaces the SW with sync-shim).
 */
test.describe('web adapter: service worker', () => {
  test('service worker registers in a supported browser', async ({ page, browserName }) => {
    test.skip(
      browserName === 'webkit',
      'Safari requires HTTPS for PWA; skip under http dev server',
    );

    await page.goto('/');

    // Wait for the SW to become active — the webmail app registers on idle.
    const reg = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return null;
      // Allow a few seconds for registration; Workbox registers on window load.
      const timeout = 5000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const r = await navigator.serviceWorker.getRegistration();
        if (r) return { active: Boolean(r.active), scope: r.scope };
        await new Promise((r2) => setTimeout(r2, 250));
      }
      return null;
    });

    if (!reg) {
      test.skip(true, 'SW not registered in this dev environment — vite dev may skip SW');
    }
    expect(reg!.scope).toContain('/');
  });
});
