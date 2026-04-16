import { expect, test } from '@playwright/test';

/**
 * Web-only adapter contract: the browser exposes a working IndexedDB with
 * the expected Dexie database name pattern. This catches mobile-webview
 * quota and key-range regressions.
 */
test.describe('web adapter: IndexedDB', () => {
  test('can open webmail-cache-v1 and write/read the meta table', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      return await new Promise<{ ok: boolean; value: string | null; error?: string }>((resolve) => {
        const open = indexedDB.open('webmail-cache-playwright', 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore('meta', { keyPath: 'key' });
        };
        open.onerror = () => resolve({ ok: false, value: null, error: String(open.error) });
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ key: 'probe', value: 'hello' });
          tx.oncomplete = () => {
            const rtx = db.transaction('meta', 'readonly');
            const req = rtx.objectStore('meta').get('probe');
            req.onsuccess = () => {
              db.close();
              indexedDB.deleteDatabase('webmail-cache-playwright');
              resolve({ ok: true, value: req.result?.value ?? null });
            };
          };
          tx.onerror = () => resolve({ ok: false, value: null, error: String(tx.error) });
        };
      });
    });

    expect(result.ok, result.error).toBe(true);
    expect(result.value).toBe('hello');
  });
});
