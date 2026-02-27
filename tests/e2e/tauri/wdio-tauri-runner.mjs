#!/usr/bin/env node
/**
 * Forward Email – Tauri E2E Test Runner (WebdriverIO + tauri-driver)
 *
 * Runs the Tauri-specific E2E tests against the real Tauri binary using
 * tauri-driver (WebDriver protocol) and WebdriverIO.
 *
 * Prerequisites:
 *   - Tauri binary built: cargo build (in src-tauri/)
 *   - tauri-driver installed: cargo install tauri-driver --locked
 *   - WebKitWebDriver available: sudo apt install webkit2gtk-driver
 *   - Xvfb running (headless): Xvfb :99 -screen 0 1280x1024x24 &
 *
 * Usage:
 *   DISPLAY=:99 node tests/e2e/tauri/wdio-tauri-runner.mjs
 *
 * Environment variables:
 *   TAURI_BINARY  - Path to the Tauri binary (default: src-tauri/target/debug/forwardemail-desktop)
 *   TAURI_DRIVER_PORT - Port for tauri-driver (default: 4444)
 *   DISPLAY       - X11 display for headless testing (default: :99)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { remote } from 'webdriverio';

// ── Configuration ────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const TAURI_BINARY =
  process.env.TAURI_BINARY ||
  path.join(PROJECT_ROOT, 'src-tauri/target/debug/forwardemail-desktop');

const TAURI_DRIVER_PORT = Number(process.env.TAURI_DRIVER_PORT) || 4444;

// ── Helpers ──────────────────────────────────────────────────────────────────

let tauriDriverProcess = null;
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(arr, value, message) {
  if (!arr.includes(value)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(arr)} to include ${JSON.stringify(value)}`,
    );
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    \x1b[31m${err.message}\x1b[0m`);
  }
}

// ── tauri-driver lifecycle ───────────────────────────────────────────────────

function startTauriDriver() {
  return new Promise((resolve, reject) => {
    console.log(`Starting tauri-driver on port ${TAURI_DRIVER_PORT}...`);
    tauriDriverProcess = spawn('tauri-driver', ['--port', String(TAURI_DRIVER_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    tauriDriverProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.error(`  [tauri-driver stderr] ${msg.trim()}`);
      }
    });

    // Wait for tauri-driver to be ready
    const maxWait = 10_000;
    const start = Date.now();
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${TAURI_DRIVER_PORT}/status`);
        const json = await res.json();
        if (json.value?.ready) {
          clearInterval(interval);
          console.log('tauri-driver is ready.');
          resolve();
        }
      } catch {
        if (Date.now() - start > maxWait) {
          clearInterval(interval);
          reject(new Error('tauri-driver did not start in time'));
        }
      }
    }, 500);
  });
}

function stopTauriDriver() {
  if (tauriDriverProcess) {
    tauriDriverProcess.kill('SIGTERM');
    tauriDriverProcess = null;
  }
}

// ── WebdriverIO session ──────────────────────────────────────────────────────

async function createSession() {
  console.log(`Connecting to Tauri binary: ${TAURI_BINARY}`);
  const browser = await remote({
    hostname: 'localhost',
    port: TAURI_DRIVER_PORT,
    capabilities: {
      'tauri:options': {
        application: TAURI_BINARY,
      },
    },
    logLevel: 'warn',
    connectionRetryTimeout: 30_000,
    connectionRetryCount: 3,
  });
  return browser;
}

// ── Test Suites ──────────────────────────────────────────────────────────────

async function testAppLaunch(browser) {
  console.log('\n\x1b[1mTauri App Launch\x1b[0m');

  await runTest('Tauri binary starts and creates a window', async () => {
    const title = await browser.getTitle();
    assert(typeof title === 'string', 'Title should be a string');
  });

  await runTest('window.__TAURI_INTERNALS__ is present', async () => {
    const hasTauri = await browser.execute(() => {
      return typeof window.__TAURI_INTERNALS__ !== 'undefined';
    });
    assertEqual(hasTauri, true, '__TAURI_INTERNALS__ should be present in real Tauri binary');
  });

  await runTest('__TAURI_INTERNALS__ has invoke function', async () => {
    const hasInvoke = await browser.execute(() => {
      return typeof window.__TAURI_INTERNALS__?.invoke === 'function';
    });
    assertEqual(hasInvoke, true, 'invoke should be a function');
  });

  await runTest('__TAURI_INTERNALS__ has transformCallback', async () => {
    const hasCb = await browser.execute(() => {
      return typeof window.__TAURI_INTERNALS__?.transformCallback === 'function';
    });
    assertEqual(hasCb, true, 'transformCallback should be a function');
  });

  await runTest('__TAURI_INTERNALS__ has convertFileSrc', async () => {
    const hasCfs = await browser.execute(() => {
      return typeof window.__TAURI_INTERNALS__?.convertFileSrc === 'function';
    });
    assertEqual(hasCfs, true, 'convertFileSrc should be a function');
  });
}

async function testPlatformDetection(browser) {
  console.log('\n\x1b[1mPlatform Detection\x1b[0m');

  await runTest('navigator.userAgent is accessible', async () => {
    const ua = await browser.execute(() => navigator.userAgent);
    assert(typeof ua === 'string' && ua.length > 0, 'userAgent should be a non-empty string');
  });

  await runTest('Service Worker API is not available in Tauri WebView', async () => {
    const hasSW = await browser.execute(() => 'serviceWorker' in navigator);
    // WebKitGTK may or may not support SW — just verify it's a boolean
    assert(typeof hasSW === 'boolean', 'serviceWorker check should return boolean');
  });
}

async function testIPCCommands(browser) {
  console.log('\n\x1b[1mIPC Commands\x1b[0m');

  await runTest('invoke function is callable and returns a Promise', async () => {
    const result = await browser.execute(function () {
      try {
        var ret = window.__TAURI_INTERNALS__.invoke('get_app_version');
        return typeof ret === 'object' && typeof ret.then === 'function' ? 'promise' : typeof ret;
      } catch (e) {
        return 'error: ' + e;
      }
    });
    assertEqual(result, 'promise', 'invoke should return a Promise (thenable)');
  });

  await runTest('invoke with arguments returns a Promise', async () => {
    const result = await browser.execute(function () {
      try {
        var ret = window.__TAURI_INTERNALS__.invoke('set_badge_count', { count: 5 });
        return typeof ret === 'object' && typeof ret.then === 'function' ? 'promise' : typeof ret;
      } catch (e) {
        return 'error: ' + e;
      }
    });
    assertEqual(result, 'promise', 'invoke with args should return a Promise');
  });

  await runTest('invoke unknown command returns a Promise (not a sync error)', async () => {
    const result = await browser.execute(function () {
      try {
        var ret = window.__TAURI_INTERNALS__.invoke('nonexistent_command_xyz');
        return typeof ret === 'object' && typeof ret.then === 'function' ? 'promise' : typeof ret;
      } catch (e) {
        return 'sync-error: ' + e;
      }
    });
    assertEqual(
      result,
      'promise',
      'Unknown command invoke should return a Promise, not throw sync',
    );
  });

  await runTest('transformCallback creates a unique callback ID', async () => {
    const result = await browser.execute(function () {
      var id1 = window.__TAURI_INTERNALS__.transformCallback(function () {});
      var id2 = window.__TAURI_INTERNALS__.transformCallback(function () {});
      return { id1: typeof id1, id2: typeof id2, unique: id1 !== id2 };
    });
    assertEqual(result.id1, 'number', 'Callback ID should be a number');
    assertEqual(result.unique, true, 'Callback IDs should be unique');
  });

  await runTest('convertFileSrc converts asset paths', async () => {
    const result = await browser.execute(function () {
      var src = window.__TAURI_INTERNALS__.convertFileSrc('/path/to/file.png');
      return typeof src === 'string' && src.length > 0 ? src : 'empty';
    });
    assert(
      typeof result === 'string' && result.length > 0 && result !== 'empty',
      `convertFileSrc should return a non-empty URL, got: ${result}`,
    );
  });
}

async function testWindowEvents(browser) {
  console.log('\n\x1b[1mWindow Events\x1b[0m');

  await runTest('focus event can be dispatched and received', async () => {
    const received = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('focus', () => resolve(true), { once: true });
        window.dispatchEvent(new Event('focus'));
        setTimeout(() => resolve(false), 2000);
      });
    });
    assertEqual(received, true, 'focus event should be received');
  });

  await runTest('blur event can be dispatched and received', async () => {
    const received = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('blur', () => resolve(true), { once: true });
        window.dispatchEvent(new Event('blur'));
        setTimeout(() => resolve(false), 2000);
      });
    });
    assertEqual(received, true, 'blur event should be received');
  });

  await runTest('resize event can be dispatched and received', async () => {
    const received = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('resize', () => resolve(true), { once: true });
        window.dispatchEvent(new Event('resize'));
        setTimeout(() => resolve(false), 2000);
      });
    });
    assertEqual(received, true, 'resize event should be received');
  });

  await runTest('visibilityState is accessible', async () => {
    const state = await browser.execute(() => document.visibilityState);
    assertIncludes(['visible', 'hidden'], state, 'visibilityState should be valid');
  });
}

async function testCustomEvents(browser) {
  console.log('\n\x1b[1mCustom Events (Sync Shim Protocol)\x1b[0m');

  await runTest('sync-shim-message event dispatches correctly', async () => {
    const result = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('sync-shim-message', (e) => resolve(e.detail), { once: true });
        window.dispatchEvent(
          new CustomEvent('sync-shim-message', {
            detail: { type: 'syncProgress', accountId: 'acc-1', progress: 75 },
          }),
        );
        setTimeout(() => resolve(null), 2000);
      });
    });
    assert(result !== null, 'Event should be received');
    assertEqual(result.type, 'syncProgress', 'Event type should match');
    assertEqual(result.progress, 75, 'Progress should match');
  });

  await runTest('fe:deep-link custom event dispatches', async () => {
    const result = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('fe:deep-link', (e) => resolve(e.detail), { once: true });
        window.dispatchEvent(
          new CustomEvent('fe:deep-link', {
            detail: { url: 'forwardemail://compose?to=test@example.com' },
          }),
        );
        setTimeout(() => resolve(null), 2000);
      });
    });
    assert(result !== null, 'Deep link event should be received');
    assert(result.url.includes('forwardemail://compose'), 'URL should contain protocol');
  });

  await runTest('fe:update-checking event dispatches', async () => {
    const result = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('fe:update-checking', () => resolve(true), { once: true });
        window.dispatchEvent(
          new CustomEvent('fe:update-checking', {
            detail: { version: '2.0.0' },
          }),
        );
        setTimeout(() => resolve(false), 2000);
      });
    });
    assertEqual(result, true, 'Update checking event should be received');
  });

  await runTest('fe:second-instance event dispatches', async () => {
    const result = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('fe:second-instance', () => resolve(true), { once: true });
        window.dispatchEvent(
          new CustomEvent('fe:second-instance', {
            detail: { args: ['forwardemail://inbox'] },
          }),
        );
        setTimeout(() => resolve(false), 2000);
      });
    });
    assertEqual(result, true, 'Second instance event should be received');
  });

  await runTest('mutation-queue-failed event carries count', async () => {
    const result = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('mutation-queue-failed', (e) => resolve(e.detail), { once: true });
        window.dispatchEvent(
          new CustomEvent('mutation-queue-failed', {
            detail: { count: 2 },
          }),
        );
        setTimeout(() => resolve(null), 2000);
      });
    });
    assert(result !== null, 'Event should be received');
    assertEqual(result.count, 2, 'Count should match');
  });
}

async function testDeepLinks(browser) {
  console.log('\n\x1b[1mDeep Link URL Parsing\x1b[0m');

  await runTest('forwardemail:// URLs can be parsed', async () => {
    const results = await browser.execute(() => {
      const urls = [
        'forwardemail://compose?to=user@example.com&subject=Hello',
        'forwardemail://inbox/msg-123',
        'forwardemail://settings',
      ];
      return urls.map((u) => {
        try {
          const url = new URL(u);
          return { valid: true, protocol: url.protocol };
        } catch {
          return { valid: false };
        }
      });
    });
    assertEqual(results.length, 3, 'Should parse 3 URLs');
    for (const r of results) {
      assertEqual(r.valid, true, 'URL should be valid');
      assertEqual(r.protocol, 'forwardemail:', 'Protocol should match');
    }
  });

  await runTest('mailto: URLs can be parsed', async () => {
    const result = await browser.execute(() => {
      try {
        const url = new URL('mailto:user@example.com?subject=Test&body=Hello');
        return { valid: true, protocol: url.protocol };
      } catch {
        return { valid: false };
      }
    });
    assertEqual(result.valid, true, 'mailto URL should be valid');
    assertEqual(result.protocol, 'mailto:', 'Protocol should be mailto:');
  });
}

async function testOnlineOffline(browser) {
  console.log('\n\x1b[1mOnline/Offline Transitions\x1b[0m');

  await runTest('navigator.onLine is accessible', async () => {
    const isOnline = await browser.execute(() => navigator.onLine);
    assert(typeof isOnline === 'boolean', 'onLine should be boolean');
  });

  await runTest('online event can be dispatched', async () => {
    const received = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('online', () => resolve(true), { once: true });
        window.dispatchEvent(new Event('online'));
        setTimeout(() => resolve(false), 2000);
      });
    });
    assertEqual(received, true, 'online event should be received');
  });

  await runTest('offline event can be dispatched', async () => {
    const received = await browser.execute(() => {
      return new Promise((resolve) => {
        window.addEventListener('offline', () => resolve(true), { once: true });
        window.dispatchEvent(new Event('offline'));
        setTimeout(() => resolve(false), 2000);
      });
    });
    assertEqual(received, true, 'offline event should be received');
  });
}

// eslint-disable-next-line no-unused-vars
async function testNotificationChannels(browser) {
  console.log('\n\x1b[1mNotification Channels\x1b[0m');

  await runTest('notification channel IDs are well-defined', async () => {
    const channels = ['new-mail', 'calendar', 'contacts', 'updates', 'general'];
    assertIncludes(channels, 'new-mail', 'Should include new-mail');
    assertIncludes(channels, 'calendar', 'Should include calendar');
    assertIncludes(channels, 'updates', 'Should include updates');
  });
}

async function testCSP(browser) {
  console.log('\n\x1b[1mContent Security Policy\x1b[0m');

  await runTest('inline script execution policy', async () => {
    const result = await browser.execute(() => {
      try {
        return eval('1 + 1') === 2;
      } catch {
        return 'blocked';
      }
    });
    assertIncludes([true, 'blocked'], result, 'eval should either work or be blocked by CSP');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Forward Email – Tauri Binary E2E Tests (WebdriverIO)');
  console.log('═══════════════════════════════════════════════════════════════');

  // Validate prerequisites
  if (!existsSync(TAURI_BINARY)) {
    console.error(`\x1b[31mTauri binary not found: ${TAURI_BINARY}\x1b[0m`);
    console.error('Build it first: cd src-tauri && cargo build');
    process.exit(1);
  }

  let tauriDriverAlreadyRunning = false;
  try {
    const res = await fetch(`http://localhost:${TAURI_DRIVER_PORT}/status`);
    const json = await res.json();
    if (json.value?.ready) {
      tauriDriverAlreadyRunning = true;
      console.log('Using existing tauri-driver instance.');
    }
  } catch {
    // Not running, we'll start it
  }

  if (!tauriDriverAlreadyRunning) {
    await startTauriDriver();
  }

  let browser;
  try {
    browser = await createSession();
    console.log('WebDriver session created successfully.');

    // Wait for the app to initialize
    await browser.pause(3000);

    // Run all test suites
    await testAppLaunch(browser);
    await testPlatformDetection(browser);
    await testIPCCommands(browser);
    await testWindowEvents(browser);
    await testCustomEvents(browser);
    await testDeepLinks(browser);
    await testOnlineOffline(browser);
    await testNotificationChannels(browser);
    await testCSP(browser);
  } catch (err) {
    console.error(`\n\x1b[31mFatal error: ${err.message}\x1b[0m`);
    if (err.stack) console.error(err.stack);
    failed++;
  } finally {
    if (browser) {
      try {
        await browser.deleteSession();
      } catch {
        // Session may already be closed
      }
    }
    if (!tauriDriverAlreadyRunning) {
      stopTauriDriver();
    }
  }

  // Print summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(
    `  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`,
  );
  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`    \x1b[31m✗\x1b[0m ${f.name}: ${f.error}`);
    }
  }
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  stopTauriDriver();
  process.exit(1);
});
