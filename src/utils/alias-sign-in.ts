import { Remote } from './remote';
import { buildAliasAuthHeader } from './auth.ts';
import { Local, Session, Accounts } from './storage';
import { isDemoMode, cleanupDemoAccount } from './demo-mode';

const LOGIN_FOLDERS_TIMEOUT_MS = 120_000;

/**
 * The address with an internationalized domain in its ASCII form
 * (user@præstehaven.dk becomes user@xn--prstehaven-e6a.dk), which is the
 * name the API knows the domain by. Chromium's email field already hands
 * over this form and WebKit's does not, so without this the same mailbox
 * signed in under two names depending on the browser, each with its own
 * cache and settings. The part before the @ is left alone.
 */
export const withAsciiDomain = (email: string): string => {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return email;
  const domain = email.slice(at + 1);
  if (!/[^\u0020-\u007E]/.test(domain)) return email;
  try {
    const host = new URL(`http://${domain}`).hostname;
    return host ? `${email.slice(0, at)}@${host}` : email;
  } catch {
    return email;
  }
};

/**
 * Verify an alias email and password against the API, then store them as the
 * active account. Shared by the sign-in form and the account setup QR codes so
 * both go through one credential check and one storage path. Throws the
 * request error when the credentials are rejected.
 */
export async function signInWithAliasPassword(
  typedEmail: string,
  password: string,
  { staySignedIn }: { staySignedIn: boolean },
): Promise<void> {
  const email = withAsciiDomain(typedEmail);
  // Bound to the account being signed in, so a wrong password or a sign-in
  // rate limit is not taken as the signed-in account's session ending or as
  // the backend struggling.
  const result = await Remote.request(
    'Folders',
    {},
    {
      method: 'GET',
      authHeader: buildAliasAuthHeader(`${email}:${password}`),
      bypassCircuit: true,
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
  // setActive already placed the credentials. Writing them again here keeps
  // the API layer working if the account list could not be updated, but
  // without "Stay signed in" the password must stay in this tab only.
  const store = staySignedIn ? Local : Session;
  store.set('email', email);
  store.set('alias_auth', `${email}:${password}`);
  Local.remove('api_token');
  Local.remove('locale');
}
