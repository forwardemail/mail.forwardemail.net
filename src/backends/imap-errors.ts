/** What to tell the user when signing in to a custom mail server fails. */

const TEXT: Record<string, string> = {
  auth: 'The server did not accept that username and password.',
  tls: 'A secure connection to the server could not be made. Check the security setting and the port.',
  timeout: 'The server did not answer in time. Check the server name and the port.',
  network: 'The server could not be reached. Check the server name and the port.',
  closed: 'The server closed the connection. Check the security setting and the port.',
  local:
    'That server is on this computer or your local network. Tick "This server is on my own network" to use it.',
  rate: 'Too many sign-in attempts. Wait a minute and try again.',
  input: 'Check the server name, port, username and password.',
  unsupported: 'The server does not offer sign-in with a password.',
  denied: 'The sign-in was not completed.',
  rejected: 'The server refused the connection.',
  busy: 'The server is busy. Try again in a moment.',
};

export function imapSignInErrorText(error: unknown): string {
  const e = (error || {}) as { kind?: unknown; message?: unknown };
  const kind = typeof e.kind === 'string' ? e.kind : '';
  const detail = typeof e.message === 'string' ? e.message.trim() : '';
  const lead = TEXT[kind];
  if (!lead) return detail || 'Sign in failed. Please try again.';
  // The server's own words help with a wrong password or an odd TLS setup.
  return detail && ['auth', 'tls', 'rejected', 'busy'].includes(kind)
    ? `${lead} (${detail})`
    : lead;
}
