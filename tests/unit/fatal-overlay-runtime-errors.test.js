/**
 * Runs the index.html fatal-overlay script in a fresh JSDOM window per test
 * and drives it with real events, so the two rules added on 2026-09-15 are
 * exercised rather than string-matched:
 *
 * 1. A browser-sanitized cross-origin error ("Script error." at 0:0 with no
 *    error object) never shows the overlay. Firefox for iOS injects helper
 *    scripts whose faults arrive exactly like this and covered a working
 *    mailbox with the black panel.
 * 2. After main.ts marks the app bootstrapped, runtime errors and rejections
 *    no longer show the overlay either; the in-app logger and toast own them.
 *
 * Boot-time failures must still show the overlay, which the first test pins.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const index = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const marker = index.indexOf('// Fatal-error diagnostic overlay.');
const start = index.indexOf('(function () {', marker);
const end = index.indexOf('// Automatic chunk load error recovery.', start);
const overlayScript = index.slice(start, end);

function boot() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://mail.forwardemail.net/mailbox',
  });
  const { window } = dom;
  // The script logs every error it sees; keep test output quiet.
  window.console.error = () => {};
  window.console.warn = () => {};
  window.eval(overlayScript);
  return window;
}

function overlay(window) {
  return window.document.getElementById('fe-fatal-error');
}

function fireError(window, init) {
  window.dispatchEvent(new window.ErrorEvent('error', init));
}

function fireRejection(window, reason) {
  const event = new window.Event('unhandledrejection');
  event.reason = reason;
  window.dispatchEvent(event);
}

describe('index.html fatal overlay', () => {
  expect(marker).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  it('shows the overlay for a real boot-time error with its details', () => {
    const window = boot();
    fireError(window, {
      message: "Attempted to assign to readonly property 'x'",
      filename: 'https://mail.forwardemail.net/assets/index-abc123.js',
      lineno: 12,
      colno: 34,
      error: new window.Error("Attempted to assign to readonly property 'x'"),
    });
    const el = overlay(window);
    expect(el).not.toBeNull();
    expect(el.textContent).toContain('Fatal: app failed to load (error)');
    expect(el.textContent).toContain("Attempted to assign to readonly property 'x'");
  });

  it('ignores a browser-sanitized cross-origin "Script error." before boot', () => {
    const window = boot();
    fireError(window, { message: 'Script error.', filename: '', lineno: 0, colno: 0 });
    expect(overlay(window)).toBeNull();
  });

  it('still treats "Script error." as fatal when the browser did attach detail', () => {
    // A same-origin script can legitimately throw new Error('Script error.');
    // the sanitized case is identified by the missing file, line, and error
    // object, not by the text alone.
    const window = boot();
    fireError(window, {
      message: 'Script error.',
      filename: 'https://mail.forwardemail.net/assets/chunk.js',
      lineno: 7,
      colno: 1,
      error: new window.Error('Script error.'),
    });
    expect(overlay(window)).not.toBeNull();
  });

  it('does not show the overlay for runtime errors after the app has booted', () => {
    const window = boot();
    window.__appBootstrapped = true;
    fireError(window, {
      message: 'TypeError: cannot read properties of undefined',
      filename: 'https://mail.forwardemail.net/assets/Mailbox-def456.js',
      lineno: 900,
      colno: 5,
      error: new window.TypeError('cannot read properties of undefined'),
    });
    expect(overlay(window)).toBeNull();
  });

  it('does not show the overlay for unhandled rejections after boot, but does before', () => {
    const before = boot();
    fireRejection(before, new before.Error('boom during boot'));
    expect(overlay(before)).not.toBeNull();

    const after = boot();
    after.__appBootstrapped = true;
    fireRejection(after, new after.Error('boom at runtime'));
    expect(overlay(after)).toBeNull();
  });

  it('keeps ignoring resource-load errors so chunk recovery can handle them', () => {
    const window = boot();
    const script = window.document.createElement('script');
    window.document.body.appendChild(script);
    // Capture-phase listener sees the element as target; must return early.
    script.dispatchEvent(new window.Event('error', { bubbles: false }));
    expect(overlay(window)).toBeNull();
  });
});
