import { beforeEach, describe, expect, it, vi } from 'vitest';

// Credentials a build from before the account list wrote straight into
// localStorage, with no "Stay signed in" answer recorded. They are the user's
// real sign-in and must survive the upgrade.
describe('signing in from before the account list', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('webmail_email', 'test@example.com');
    localStorage.setItem('webmail_alias_auth', 'test@example.com:pw');
  });

  it('keeps the account signed in when no answer was recorded', async () => {
    const { Accounts, Local } = await import('../../src/utils/storage.js');
    Accounts.init();
    expect(Accounts.getAll().map((a) => a.email)).toEqual(['test@example.com']);
    expect(Local.get('alias_auth')).toBe('test@example.com:pw');
  });

  it('drops them when the sign-in said not to stay signed in', async () => {
    localStorage.setItem('webmail_signMe', '0');
    const { Accounts } = await import('../../src/utils/storage.js');
    Accounts.init();
    expect(localStorage.getItem('webmail_alias_auth')).toBeNull();
  });
});
