import { defineConfig, devices } from '@playwright/test';

/**
 * Test strategy across platforms:
 *
 *   tests/e2e/smoke/          — runs on every project (web + desktop + mobile)
 *   tests/e2e/adapters/web    — browser-only (PWA, SW, mailto, clipboard)
 *   tests/e2e/*.spec.js       — legacy full-flow suites (desktop chromium only)
 *
 * Native-WebView coverage (real WKWebView/WebView2/WebKitGTK/Android System
 * WebView) lives in `e2e-webview/` and `e2e-mobile/`, driven by WebdriverIO —
 * Playwright cannot drive Tauri's native WebViews.
 */

const runWebkit = process.env.PW_RUN_WEBKIT === '1';
const runFirefox = process.env.PW_RUN_FIREFOX === '1';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // Cap worker count — `vite preview` is single-threaded, and tests that
  // load large chunks (Contacts, Calendar) can saturate the server when all
  // workers hit it at once. 4 workers keeps the server responsive while
  // still getting parallel speed-ups.
  workers: process.env.CI ? 2 : 4,
  // Locally retry once, CI retries twice. After the helpers were tightened
  // up, the residual flake rate on these suites is ~3% per test; 1 retry
  // collapses that to ~0.1% — effectively 100% reliable — without masking
  // real regressions (which fail deterministically).
  retries: process.env.CI ? 2 : 1,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // --------------- Web (browsers) -----------------------------------------
    {
      name: 'web-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    ...(runFirefox
      ? [
          {
            name: 'web-firefox',
            use: { ...devices['Desktop Firefox'] },
            // Firefox only runs smoke + web-adapter suites — the legacy
            // desktop specs use selectors we haven't validated cross-browser.
            testMatch: [/smoke\//, /adapters\/web\//],
          },
        ]
      : []),
    ...(runWebkit
      ? [
          {
            name: 'web-webkit',
            use: { ...devices['Desktop Safari'] },
            testMatch: [/smoke\//, /adapters\/web\//],
          },
        ]
      : []),

    // --------------- Mobile viewports (responsive) --------------------------
    {
      name: 'mobile-android-web',
      use: { ...devices['Pixel 7'] },
      testMatch: [/smoke\//, /mailbox\.spec/, /agents\.spec/, /adapters\/web\//],
    },
    {
      name: 'mobile-ios-web',
      use: { ...devices['iPhone 14'] },
      // Skip mailbox.spec on iOS — it has rendering/timing differences on
      // WebKit (messages render differently than Chromium, selectors miss).
      // mobile-android-web (Pixel 7, Chromium) already covers mobile viewport
      // for the mailbox flow. Dedicated iOS mailbox coverage needs a proper
      // investigation of the WebKit-specific gaps and is tracked separately.
      testMatch: [/smoke\//, /adapters\/web\//],
      testIgnore: [/mailbox\.spec/],
    },
  ],
  // Serve a built bundle via `vite preview` rather than `vite dev`. Vite's
  // dev-mode dependency optimizer races under parallel Playwright workers
  // and periodically 500s on chunks mid-flight (`The file does not exist at
  // "node_modules/.vite/deps/chunk-*.js?v=..."`), which surfaces as dozens
  // of flaky selector timeouts. Preview mode serves static built assets and
  // is deterministic. The one-time build cost (~30s) pays for itself
  // immediately in reliability.
  webServer: {
    command: 'pnpm build && pnpm exec vite preview --host --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
