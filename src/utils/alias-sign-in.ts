import { Remote } from './remote';
import { buildAliasAuthHeader } from './auth.ts';
import { Local, Session, Accounts } from './storage';
import { isDemoMode, cleanupDemoAccount } from './demo-mode';
import { cleanImapSettings, type ImapSettings } from '../backends/imap-account';
import { closeMailAccount, testImapSettings } from '../backends/imap-engine';
import { closeSmtpAccount, testSmtpSettings } from '../backends/smtp-engine';
import { cleanSmtpSettings, type SmtpSettings } from '../backends/smtp-account';
import {
  OAUTH_SERVERS,
  rememberAccessToken,
  startOAuthSignIn,
  type OAuthProvider,
} from '../backends/oauth';
import { resetMailBackend } from '../backends';

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

const SMTP_CHECK_MAX_MS = 10_000;

/**
 * Whether a suggested outgoing server takes the same sign-in. It was found by
 * a lookup, not typed by the user, so a failure only means it is not saved:
 * the user sets one in Settings instead.
 */
async function outgoingServerWorks(smtp: SmtpSettings): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tooSlow = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), SMTP_CHECK_MAX_MS);
  });
  try {
    return await Promise.race([testSmtpSettings(smtp).then(() => true), tooSlow]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sign in to an account on a custom IMAP server. The settings are checked by
 * signing in to the server, then stored on the account record. Throws the
 * engine's error (a MailEngineError with a `kind`) when the check fails.
 *
 * `suggestedSmtp` is an outgoing server a lookup found for the address. It is
 * tried with the same password and saved only when that works.
 */
export async function signInWithImap(
  email: string,
  settings: ImapSettings,
  {
    staySignedIn,
    suggestedSmtp,
  }: {
    staySignedIn: boolean;
    suggestedSmtp?: Pick<SmtpSettings, 'host' | 'port' | 'security'> & { username?: string };
  },
): Promise<void> {
  const imap = cleanImapSettings(settings);
  if (!email || !imap) throw new Error('Fill in the server, port, username and password.');

  await testImapSettings(imap);

  const smtpCandidate = suggestedSmtp
    ? cleanSmtpSettings({
        ...suggestedSmtp,
        username: suggestedSmtp.username || imap.username,
        password: imap.password,
        allowLocal: imap.allowLocal,
      })
    : null;
  const smtp = smtpCandidate && (await outgoingServerWorks(smtpCandidate)) ? smtpCandidate : null;

  if (isDemoMode()) {
    await cleanupDemoAccount();
  }

  // A connection opened with older settings for this address must not be reused.
  await closeMailAccount(email);
  await closeSmtpAccount(email);
  resetMailBackend(email);

  Accounts.init();
  if (!Accounts.add(email, { kind: 'imap', imap, ...(smtp ? { smtp } : {}) }, staySignedIn)) {
    throw new Error('The account could not be saved. Unlock the app and try again.');
  }
  Accounts.setActive(email);

  Local.set('signMe', staySignedIn ? '1' : '0');
  const store = staySignedIn ? Local : Session;
  store.set('email', email);
  Local.remove('locale');
}

/**
 * Sign in to Gmail or Microsoft 365 through the provider's own sign-in page.
 * The page opens in the user's browser and this waits for them to finish
 * there. Throws the engine's error (a MailEngineError with a `kind`) when the
 * sign-in is declined, times out, or the mail server refuses the token.
 */
export async function signInWithOAuth(
  provider: OAuthProvider,
  { staySignedIn }: { staySignedIn: boolean },
): Promise<string> {
  const tokens = await startOAuthSignIn(provider);
  const email = String(tokens.email || '').trim();
  if (!email || !tokens.refreshToken) {
    throw new Error(`${OAUTH_SERVERS[provider].label} did not say which account signed in.`);
  }
  const servers = OAUTH_SERVERS[provider];
  const signIn = { username: email, password: '', auth: 'xoauth2' as const };
  const imap = { ...servers.imap, ...signIn };
  const smtp = { ...servers.smtp, ...signIn };

  // Checked against the mail server with the token just issued.
  await testImapSettings({ ...imap, password: tokens.accessToken });

  if (isDemoMode()) {
    await cleanupDemoAccount();
  }

  await closeMailAccount(email);
  await closeSmtpAccount(email);
  resetMailBackend(email);

  Accounts.init();
  const saved = Accounts.add(
    email,
    { kind: 'imap', imap, smtp, oauth: { provider, refreshToken: tokens.refreshToken } },
    staySignedIn,
  );
  if (!saved) throw new Error('The account could not be saved. Unlock the app and try again.');
  rememberAccessToken(email, tokens);
  Accounts.setActive(email);

  Local.set('signMe', staySignedIn ? '1' : '0');
  const store = staySignedIn ? Local : Session;
  store.set('email', email);
  Local.remove('locale');
  return email;
}
