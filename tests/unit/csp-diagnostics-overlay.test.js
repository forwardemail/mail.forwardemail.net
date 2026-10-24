import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = process.cwd();
const diagnostics = readFileSync(path.join(root, 'src/utils/diagnostics.ts'), 'utf8');
const index = readFileSync(path.join(root, 'index.html'), 'utf8');

const probeUrl = 'https://example.invalid/csp-probe';

// Run the inline code from index.html as it ships, rather than matching its
// source text.
function loadHelpers(origin = 'tauri://localhost') {
  const start = index.indexOf('function isExtensionViolation(e)');
  const end = index.indexOf('function showFatal(detail)', start);
  if (start === -1 || end === -1) throw new Error('CSP helpers not found in index.html');
  return new Function(
    'location',
    `${index.slice(start, end)}; return { isIgnorableCspViolation };`,
  )({ origin });
}

// The fatal-overlay IIFE, which registers the securitypolicyviolation listener
function installOverlayScript() {
  const start = index.indexOf('(function () {\n        var SHOWN = false;');
  const end = index.indexOf('})();', index.indexOf("'securitypolicyviolation'", start));
  if (start === -1 || end === -1) throw new Error('overlay script not found in index.html');
  new Function(index.slice(start, end + '})();'.length))();
}

// Reported by one of our own bundles (same origin as the page)
const violation = (fields, origin = 'tauri://localhost') => ({
  effectiveDirective: 'connect-src',
  violatedDirective: 'connect-src',
  blockedURI: '',
  sourceFile: `${origin}/assets/index.js`,
  lineNumber: 1,
  columnNumber: 1,
  sample: '',
  ...fields,
});

function dispatchViolation(fields) {
  const event = new Event('securitypolicyviolation');
  Object.assign(event, violation(fields, location.origin));
  document.dispatchEvent(event);
}

describe('diagnostics CSP overlay contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.getElementById('fe-fatal-error')?.remove();
  });

  it('the diagnostics probe still targets the URL the overlay ignores', () => {
    expect(diagnostics).toContain(`const blocked = '${probeUrl}'`);
  });

  it('ignores the diagnostics probe as Chromium and Firefox report it (full URL)', () => {
    const { isIgnorableCspViolation } = loadHelpers();
    expect(isIgnorableCspViolation(violation({ blockedURI: probeUrl }))).toBe(true);
  });

  it('ignores the diagnostics probe as WebKit reports it (cross-origin URL stripped to its origin)', () => {
    const { isIgnorableCspViolation } = loadHelpers();
    expect(isIgnorableCspViolation(violation({ blockedURI: 'https://example.invalid' }))).toBe(
      true,
    );
  });

  it('still surfaces other connect-src violations from our own bundle', () => {
    const { isIgnorableCspViolation } = loadHelpers();
    expect(isIgnorableCspViolation(violation({ blockedURI: 'https://api.example.com' }))).toBe(
      false,
    );
    expect(
      isIgnorableCspViolation(violation({ blockedURI: 'https://example.invalid/other' })),
    ).toBe(false);
    expect(
      isIgnorableCspViolation(
        violation({ effectiveDirective: 'script-src', blockedURI: 'https://example.invalid' }),
      ),
    ).toBe(false);
  });

  it('logs the expected probe as a warning with its fields, not as an app error', () => {
    installOverlayScript();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    dispatchViolation({ blockedURI: 'https://example.invalid' });

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = warn.mock.calls[0];
    expect(typeof line).toBe('string');
    expect(line).toContain('blockedURI: https://example.invalid');
    expect(document.getElementById('fe-fatal-error')).toBeNull();
  });

  it('logs a real violation as a readable error line', () => {
    installOverlayScript();
    window.__appBootstrapped = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    dispatchViolation({ blockedURI: 'https://tracker.example.com' });

    const lines = error.mock.calls.map(([line]) => line);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(typeof line).toBe('string');
    expect(lines.join('\n')).toContain('blockedURI: https://tracker.example.com');
    expect(lines.join('\n')).not.toContain('[object');
    delete window.__appBootstrapped;
  });
});
