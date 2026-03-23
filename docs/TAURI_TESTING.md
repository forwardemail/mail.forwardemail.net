# Tauri E2E Testing Guide

This document describes the testing strategy for the Forward Email Tauri
desktop and mobile applications.

## Overview

The E2E test suite is designed to be **platform-agnostic**: the same Playwright
test files run against both the web app (via dev server) and the Tauri desktop
app (via WebDriver or CDP). Tests that require Tauri-specific APIs check for
`window.__TAURI_INTERNALS__` and skip gracefully when running in web mode.

## Test Configurations

### Web Mode (Default)

```bash
# Run all E2E tests against the Vite dev server
npx playwright test --config playwright.config.js
```

This starts the Vite dev server and runs tests in Chromium. All tests that
don't require Tauri-specific APIs will pass.

### Tauri Mode (Desktop)

```bash
# Build the Tauri app first
cd src-tauri && cargo tauri build

# Run tests against the Tauri binary via WebDriver (Linux/Windows)
TAURI_E2E_BINARY=./src-tauri/target/release/forwardemail-desktop \
  npx playwright test --config playwright.tauri.config.js
```

### Tauri Mode via CDP (Windows Only)

On Windows, you can connect Playwright directly to the Edge WebView2 via
Chrome DevTools Protocol:

```bash
# Start the Tauri app with remote debugging enabled
# (requires adding --remote-debugging-port=9222 to the WebView2 args)
TAURI_CDP_URL=http://localhost:9222 \
  npx playwright test --config playwright.tauri.config.js
```

## Test Structure

```
tests/e2e/
├── tauri/
│   ├── tauri-app.spec.ts        # Tauri-specific tests (IPC, deep-links, tray)
│   ├── sync-shim.spec.ts        # Sync shim (SW replacement) tests
│   └── native-features.spec.ts  # Native feature tests
├── websocket/
│   └── websocket.spec.ts        # WebSocket client tests
├── lock-screen-pin.spec.ts      # Lock screen PIN tests
├── lock-screen-passkey.spec.ts  # Lock screen passkey tests
├── crypto-store.spec.ts         # IndexedDB encryption tests
├── auto-updater.spec.ts         # Auto-updater tests
├── mailto-handler.spec.ts       # Mailto URL parsing tests
├── mailto-prompt.spec.ts        # Mailto prompt + settings tests
├── websocket-events.spec.ts     # WebSocket event wiring tests
├── favicon-badge.spec.ts        # Favicon badge overlay tests
├── notifications.spec.ts        # Notification system tests
├── background-service.spec.ts   # Background service tests
└── mockApi.js                   # Shared mock API helpers
```

## Writing Platform-Agnostic Tests

Tests should work in both web and Tauri contexts:

```typescript
import { expect, test } from '@playwright/test';

const IS_TAURI = Boolean(process.env.TAURI_E2E_BINARY);

test('feature works on all platforms', async ({ page }) => {
  await page.goto(APP_URL);

  // This runs in both web and Tauri
  const result = await page.evaluate(() => {
    return typeof someFeature === 'function';
  });
  expect(result).toBe(true);
});

test('tauri-specific feature', async ({ page }) => {
  test.skip(!IS_TAURI, 'Requires Tauri binary');

  await page.goto(APP_URL);

  const result = await page.evaluate(() => {
    return window.__TAURI_INTERNALS__ !== undefined;
  });
  expect(result).toBe(true);
});
```

## CI Integration

The GitHub Actions workflow [`e2e-apps.yml`](../.github/workflows/e2e-apps.yml) runs tests in both modes:

1. **Web E2E**: Runs on every PR against the Vite dev server.
2. **Tauri E2E**: Runs on release branches after building the Tauri binary.

### WebDriver Setup in CI (Linux)

```yaml
- name: Install WebKitWebDriver
  run: sudo apt-get install -y webkit2gtk-driver

- name: Install tauri-driver
  run: cargo install tauri-driver --locked

- name: Run Tauri E2E tests
  run: |
    # Start tauri-driver in background
    tauri-driver &
    TAURI_E2E_BINARY=./src-tauri/target/release/forwardemail-desktop \
      npx playwright test --config playwright.tauri.config.js
```

## Approaches Comparison

| Approach   | Platforms      | Pros                     | Cons           |
| ---------- | -------------- | ------------------------ | -------------- |
| Dev Server | All            | Fast, no build needed    | No Tauri APIs  |
| WebDriver  | Linux, Windows | Official Tauri support   | No macOS, slow |
| CDP        | Windows        | Full Playwright features | Windows only   |
| Appium     | iOS, Android   | Mobile testing           | Complex setup  |

## Recommended Workflow

1. **Development**: Run tests against the dev server for fast feedback.
2. **Pre-release**: Build the Tauri binary and run the full suite via WebDriver.
3. **CI**: Run web tests on every PR, Tauri tests on release branches.

## Troubleshooting

### WebDriver hangs on Linux

Ensure `WebKitWebDriver` is installed:

```bash
sudo apt-get install webkit2gtk-driver
which WebKitWebDriver
```

### Tests timeout on first run

The Tauri binary takes longer to start on first launch. Increase the timeout:

```bash
PLAYWRIGHT_TIMEOUT=120000 npx playwright test --config playwright.tauri.config.js
```

### CDP connection refused on Windows

Ensure the Tauri app is running with remote debugging enabled and the port
matches `TAURI_CDP_URL`.

## Related Documentation

- [DEVELOPMENT.md](./DEVELOPMENT.md) — Development guide including E2E test commands
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Full architecture document
- [SECURITY.md](./SECURITY.md) — Security hardening details
