import { Remote } from './remote';
import { buildAliasAuthHeader } from './auth.ts';
import { Local, Accounts } from './storage';
import { isDemoMode, cleanupDemoAccount } from './demo-mode';

const LOGIN_FOLDERS_TIMEOUT_MS = 120_000;

/**
 * Verify an alias email and password against the API, then store them as the
 * active account. Shared by the sign-in form and the account setup QR codes so
 * both go through one credential check and one storage path. Throws the
 * request error when the credentials are rejected.
 */
export async function signInWithAliasPassword(
  email: string,
  password: string,
  { staySignedIn }: { staySignedIn: boolean },
): Promise<void> {
  const authHeader = buildAliasAuthHeader(`${email}:${password}`);
  const result = await Remote.request(
    'Folders',
    {},
    {
      method: 'GET',
      skipAuth: true,
      headers: { Authorization: authHeader },
      timeout: LOGIN_FOLDERS_TIMEOUT_MS,
    },
  );

  if (!result) throw new Error('Login failed. Please try again.');

  // If the user was in demo mode, clean up all demo state before setting up
  // the real account, so the demo account and its cache do not linger.
  if (isDemoMode()) {
    await cleanupDemoAccount();
  }

  Accounts.init();
  Accounts.add(email, { aliasAuth: `${email}:${password}` }, staySignedIn);
  Accounts.setActive(email);

  // Store preference for next login
  Local.set('signMe', staySignedIn ? '1' : '0');
  // Always set email in Local for API compatibility
  Local.set('email', email);
  Local.set('alias_auth', `${email}:${password}`);
  Local.remove('api_token');
  Local.remove('locale');
}
