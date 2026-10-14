/**
 * An account that authenticates only by API key (QR pairing can import one)
 * has neither `authToken` nor `alias_auth`. main.ts already recognises it in
 * hasReadableCredentials(), but the navigation guard and the readiness check
 * that notification taps wait on asked only for the other two. Such an account
 * was bounced to the login page by every in-app navigation, and a tapped
 * notification waited forever for a "ready" that never came.
 *
 * main.ts runs the whole app on import, so these checks read its source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSrc = readFileSync(join(__dirname, '../../src/main.ts'), 'utf-8');

function slice(from, to) {
  const start = mainSrc.indexOf(from);
  expect(start, `missing: ${from}`).toBeGreaterThan(-1);
  const end = mainSrc.indexOf(to, start + from.length);
  expect(end, `missing: ${to}`).toBeGreaterThan(-1);
  return mainSrc.slice(start, end);
}

describe('main.ts credential checks', () => {
  it('counts an API key as a credential', () => {
    const helper = slice('const hasReadableCredentials', ';\n');
    expect(helper).toContain("Local.get('api_key')");
  });

  it('guards protected routes on any readable credential', () => {
    const guard = slice("targetRoute === 'contacts') &&", "routeStore.set('login')");
    expect(guard).toContain('hasReadableCredentials()');
    expect(guard).not.toContain("Local.get('alias_auth')");
  });

  it('lets notification taps open once any readable credential is present', () => {
    const ready = slice('configureNotificationOpen({', 'switchAccount:');
    expect(ready).toContain('hasReadableCredentials()');
    expect(ready).not.toContain("Local.get('alias_auth')");
  });

  it('never checks for a signed-in session by alias_auth and authToken alone', () => {
    // Every other spelling of the check left API-key accounts out.
    const pairs = mainSrc.match(/Local\.get\('authToken'\)\s*\|\|\s*Local\.get\('alias_auth'\)/g);
    expect(pairs).toHaveLength(1);
    expect(slice('const hasReadableCredentials', ';\n')).toMatch(
      /Local\.get\('authToken'\)\s*\|\|\s*Local\.get\('alias_auth'\)/,
    );
  });
});
