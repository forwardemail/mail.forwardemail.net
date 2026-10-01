import { spawn } from 'node:child_process';

/**
 * Opens a web link in the system browser, as window.open() does in a tab.
 * Only http(s) links are handed to the OS; each opener takes the URL as a
 * single argument, with no shell in between.
 */
export function openInBrowser(url: unknown): boolean {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const href = parsed.href;
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [href]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', href]]
        : ['xdg-open', [href]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
