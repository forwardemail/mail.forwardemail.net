/**
 * Playwright configuration for Tauri E2E tests.
 *
 * This config reuses the same test suites as the web E2E tests but connects
 * to a running Tauri application instead of a dev server.
 *
 * Usage:
 *   # Run against dev server (web mode — same tests, no Tauri binary)
 *   npx playwright test --config playwright.config.js
 *
 *   # Run against Tauri binary via WebDriver (Linux/Windows)
 *   TAURI_E2E_BINARY=./src-tauri/target/release/forwardemail-desktop \
 *     npx playwright test --config playwright.tauri.config.js
 *
 *   # Run against Tauri binary via CDP (Windows only — Edge WebView2)
 *   TAURI_CDP_URL=http://localhost:9222 \
 *     npx playwright test --config playwright.tauri.config.js
 *
 * Architecture:
 *   The tests are designed to be platform-agnostic. They use page.evaluate()
 *   to check for Tauri-specific APIs (window.__TAURI_INTERNALS__) and branch
 *   accordingly. This means the same test files work for both web and Tauri.
 *
 *   For Tauri-specific tests (IPC commands, deep-links, tray icon), the tests
 *   check IS_TAURI_BINARY and skip when running in web mode.
 *
 * Approaches for Tauri testing:
 *
 *   1. **WebDriver (Linux/Windows)**: Uses tauri-driver as a WebDriver server.
 *      Install: `cargo install tauri-driver --locked`
 *      Limitation: macOS not supported (no WKWebView driver).
 *
 *   2. **CDP (Windows only)**: Connect Playwright to Edge WebView2 via Chrome
 *      DevTools Protocol. Requires enabling remote debugging in the Tauri app.
 *      Limitation: Only works on Windows with Edge WebView2.
 *
 *   3. **Dev Server (all platforms)**: Run the same tests against the Vite dev
 *      server. Tests that require Tauri APIs are skipped. This is the default
 *      and works on all platforms including CI.
 */

import { defineConfig, devices } from '@playwright/test';

const TAURI_BINARY = process.env.TAURI_E2E_BINARY;
const TAURI_CDP_URL = process.env.TAURI_CDP_URL;
const APP_URL = process.env.TAURI_E2E_URL || 'http://localhost:5173';

// Determine the connection mode
const useCDP = Boolean(TAURI_CDP_URL);
const useBinary = Boolean(TAURI_BINARY) && !useCDP;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000, // Longer timeout for Tauri binary startup
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false, // Serial execution for Tauri binary
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: APP_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // If using CDP, connect to the running Tauri app
    ...(useCDP
      ? {
          connectOptions: {
            wsEndpoint: TAURI_CDP_URL,
          },
        }
      : {}),
  },
  projects: [
    {
      name: 'tauri-desktop',
      testMatch: [
        'tauri/**/*.spec.ts',
        // Also run shared tests that work in both web and Tauri
        'lock-screen-pin.spec.ts',
        'lock-screen-passkey.spec.ts',
        'crypto-store.spec.ts',
        'auto-updater.spec.ts',
        'mailto-handler.spec.ts',
        'websocket-events.spec.ts',
        'favicon-badge.spec.ts',
        'notifications.spec.ts',
      ],
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Only start dev server if not connecting to a Tauri binary
  ...(useBinary || useCDP
    ? {}
    : {
        webServer: {
          command: 'pnpm dev --host --port 5173',
          url: 'http://localhost:5173',
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});
