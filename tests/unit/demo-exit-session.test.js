import { beforeEach, describe, expect, it, vi } from 'vitest';

// Leaving demo mode used to clear all of sessionStorage, which also signed out
// every account in the tab that was kept only for this session.
describe('leaving demo mode', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('keeps the other session-only accounts in the tab', async () => {
    const { Accounts } = await import('../../src/utils/storage.js');
    Accounts.add('work@example.com', { aliasAuth: 'work@example.com:pw' }, false);
    const before = Object.keys(sessionStorage).filter((k) => !/demo/i.test(k));
    expect(before.length).toBeGreaterThan(0);

    const demo = await import('../../src/utils/demo-mode.js');
    Object.defineProperty(window, 'location', {
      value: { ...window.location, replace: vi.fn() },
      configurable: true,
    });
    vi.spyOn(window, 'open').mockImplementation(() => null);
    demo.exitDemoAndRedirect({ openSignUp: false });

    const accounts = Accounts.getAll().map((a) => a.email);
    expect(accounts).toContain('work@example.com');
  });
});
