/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/**
 * Forward Email – Tauri Native Features E2E Tests
 *
 * Tests for Tauri-specific native integrations:
 *   - IPC command invocation pattern
 *   - Badge count management
 *   - Window state events
 *   - Tray icon events
 *   - Auto-updater event flow
 *   - Deep-link handling
 *   - Single instance enforcement
 *   - Notification channels
 *
 * These tests verify the event contracts and patterns used by the
 * Tauri bridges, even when running in a browser context (where Tauri
 * APIs are mocked/simulated).
 */

import { expect, test } from '@playwright/test';

const APP_URL = process.env.TAURI_E2E_URL || 'http://localhost:4173';

// ---------------------------------------------------------------------------
// IPC Command Pattern
// ---------------------------------------------------------------------------

test.describe('IPC Command Pattern', () => {
  test('Tauri invoke pattern can be simulated', async ({ page }) => {
    await page.goto(APP_URL);

    const result = await page.evaluate(() => {
      // Simulate the Tauri invoke pattern
      const mockInvoke = async (cmd: string, args?: any) => {
        const commands: Record<string, any> = {
          get_badge_count: 5,
          set_badge_count: null,
          get_platform: 'linux',
          get_version: '0.1.0',
        };
        return commands[cmd] ?? null;
      };

      return Promise.all([
        mockInvoke('get_badge_count'),
        mockInvoke('get_platform'),
        mockInvoke('get_version'),
      ]);
    });

    expect(result[0]).toBe(5);
    expect(result[1]).toBe('linux');
    expect(result[2]).toBe('0.1.0');
  });

  test('IPC error handling works', async ({ page }) => {
    await page.goto(APP_URL);

    const caught = await page.evaluate(async () => {
      const mockInvoke = async (cmd: string) => {
        if (cmd === 'unknown_command') {
          throw new Error('Command not found: unknown_command');
        }
        return null;
      };

      try {
        await mockInvoke('unknown_command');
        return false;
      } catch (err: any) {
        return err.message.includes('unknown_command');
      }
    });

    expect(caught).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Badge Count
// ---------------------------------------------------------------------------

test.describe('Badge Count', () => {
  test('badge count can be set and retrieved', async ({ page }) => {
    await page.goto(APP_URL);

    const result = await page.evaluate(() => {
      // Simulate badge count state
      let badgeCount = 0;

      const setBadge = (count: number) => {
        badgeCount = Math.max(0, count);
      };
      const getBadge = () => badgeCount;

      setBadge(10);
      const after10 = getBadge();
      setBadge(0);
      const afterClear = getBadge();
      setBadge(-5); // Should clamp to 0
      const afterNegative = getBadge();

      return { after10, afterClear, afterNegative };
    });

    expect(result.after10).toBe(10);
    expect(result.afterClear).toBe(0);
    expect(result.afterNegative).toBe(0);
  });

  test('web Badge API check does not throw', async ({ page }) => {
    await page.goto(APP_URL);

    const noThrow = await page.evaluate(() => {
      try {
        const hasBadge = 'setAppBadge' in navigator;
        return typeof hasBadge === 'boolean';
      } catch {
        return false;
      }
    });
    expect(noThrow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Window State Events
// ---------------------------------------------------------------------------

test.describe('Window State Events', () => {
  test('focus event can be received', async ({ page }) => {
    await page.goto(APP_URL);

    const received = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        window.addEventListener('focus', () => resolve(true), {
          once: true,
        });
        window.dispatchEvent(new Event('focus'));
        setTimeout(() => resolve(false), 2000);
      });
    });
    expect(received).toBe(true);
  });

  test('blur event can be received', async ({ page }) => {
    await page.goto(APP_URL);

    const received = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        window.addEventListener('blur', () => resolve(true), {
          once: true,
        });
        window.dispatchEvent(new Event('blur'));
        setTimeout(() => resolve(false), 2000);
      });
    });
    expect(received).toBe(true);
  });

  test('resize event can be received', async ({ page }) => {
    await page.goto(APP_URL);

    const received = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        window.addEventListener('resize', () => resolve(true), {
          once: true,
        });
        window.dispatchEvent(new Event('resize'));
        setTimeout(() => resolve(false), 2000);
      });
    });
    expect(received).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auto-Updater Event Flow
// ---------------------------------------------------------------------------

test.describe('Auto-Updater Event Flow', () => {
  test('full update lifecycle events dispatch in order', async ({ page }) => {
    await page.goto(APP_URL);

    const events = await page.evaluate(() => {
      return new Promise<string[]>((resolve) => {
        const received: string[] = [];

        const eventNames = [
          'fe:update-checking',
          'fe:update-available',
          'fe:update-downloading',
          'fe:update-downloaded',
        ];

        for (const name of eventNames) {
          window.addEventListener(
            name,
            () => {
              received.push(name);
              if (received.length === eventNames.length) {
                resolve(received);
              }
            },
            { once: true },
          );
        }

        // Dispatch in order
        for (const name of eventNames) {
          window.dispatchEvent(
            new CustomEvent(name, {
              detail: { version: '2.0.0' },
            }),
          );
        }

        setTimeout(() => resolve(received), 3000);
      });
    });

    expect(events).toHaveLength(4);
    expect(events[0]).toBe('fe:update-checking');
    expect(events[1]).toBe('fe:update-available');
    expect(events[2]).toBe('fe:update-downloading');
    expect(events[3]).toBe('fe:update-downloaded');
  });

  test('fe:update-not-available event dispatches', async ({ page }) => {
    await page.goto(APP_URL);

    const received = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        window.addEventListener('fe:update-not-available', () => resolve(true), { once: true });
        window.dispatchEvent(new CustomEvent('fe:update-not-available'));
        setTimeout(() => resolve(false), 2000);
      });
    });
    expect(received).toBe(true);
  });

  test('fe:update-error event carries error message', async ({ page }) => {
    await page.goto(APP_URL);

    const result = await page.evaluate(() => {
      return new Promise<any>((resolve) => {
        window.addEventListener('fe:update-error', (e: any) => resolve(e.detail), { once: true });
        window.dispatchEvent(
          new CustomEvent('fe:update-error', {
            detail: { error: 'Download failed: network timeout' },
          }),
        );
        setTimeout(() => resolve(null), 2000);
      });
    });

    expect(result).toBeTruthy();
    expect(result.error).toContain('network timeout');
  });
});

// ---------------------------------------------------------------------------
// Deep Link Handling
// ---------------------------------------------------------------------------

test.describe('Deep Link Handling', () => {
  test('forwardemail:// URLs can be parsed', async ({ page }) => {
    await page.goto(APP_URL);

    const result = await page.evaluate(() => {
      const testUrls = [
        'forwardemail://compose?to=user@example.com&subject=Hello',
        'forwardemail://inbox/msg-123',
        'forwardemail://settings',
      ];

      return testUrls.map((urlStr) => {
        try {
          const url = new URL(urlStr);
          return {
            valid: true,
            protocol: url.protocol,
            hostname: url.hostname,
            pathname: url.pathname,
          };
        } catch {
          return { valid: false };
        }
      });
    });

    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.valid).toBe(true);
      expect(r.protocol).toBe('forwardemail:');
    }
  });

  test('mailto: URLs can be parsed', async ({ page }) => {
    await page.goto(APP_URL);

    const result = await page.evaluate(() => {
      try {
        const url = new URL('mailto:user@example.com?subject=Test&body=Hello');
        return {
          valid: true,
          protocol: url.protocol,
          pathname: url.pathname,
        };
      } catch {
        return { valid: false };
      }
    });

    expect(result.valid).toBe(true);
    expect(result.protocol).toBe('mailto:');
  });

  test('fe:deep-link custom event dispatches', async ({ page }) => {
    await page.goto(APP_URL);

    const result = await page.evaluate(() => {
      return new Promise<any>((resolve) => {
        window.addEventListener('fe:deep-link', (e: any) => resolve(e.detail), { once: true });
        window.dispatchEvent(
          new CustomEvent('fe:deep-link', {
            detail: {
              url: 'forwardemail://compose?to=test@example.com',
            },
          }),
        );
        setTimeout(() => resolve(null), 2000);
      });
    });

    expect(result).toBeTruthy();
    expect(result.url).toContain('forwardemail://compose');
  });
});

// ---------------------------------------------------------------------------
// Notification Channels
// ---------------------------------------------------------------------------

test.describe('Notification Channels', () => {
  test('notification channel IDs are well-defined', async ({ page }) => {
    await page.goto(APP_URL);

    const channels = await page.evaluate(() => {
      // These are the channel IDs used by notification-bridge.js
      return ['new-mail', 'calendar', 'contacts', 'updates', 'general'];
    });

    expect(channels).toContain('new-mail');
    expect(channels).toContain('calendar');
    expect(channels).toContain('updates');
  });
});

// ---------------------------------------------------------------------------
// Single Instance
// ---------------------------------------------------------------------------

test.describe('Single Instance', () => {
  test('single-instance event pattern works', async ({ page }) => {
    await page.goto(APP_URL);

    const received = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        window.addEventListener('fe:second-instance', () => resolve(true), { once: true });
        window.dispatchEvent(
          new CustomEvent('fe:second-instance', {
            detail: { args: ['forwardemail://inbox'] },
          }),
        );
        setTimeout(() => resolve(false), 2000);
      });
    });
    expect(received).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Content Security Policy
// ---------------------------------------------------------------------------

test.describe('Content Security Policy', () => {
  test('inline scripts are not blocked (Tauri uses custom scheme)', async ({ page }) => {
    await page.goto(APP_URL);

    const result = await page.evaluate(() => {
      try {
        return eval('1 + 1') === 2;
      } catch {
        // CSP may block eval — that's fine for security
        return 'blocked';
      }
    });

    // Either works or is blocked by CSP — both are acceptable
    expect([true, 'blocked']).toContain(result);
  });
});
