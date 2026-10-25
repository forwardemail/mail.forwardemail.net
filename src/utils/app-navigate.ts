/**
 * In-app navigation for modules that cannot import the router (main.ts hands
 * it over through mailboxActions.setNavigate). Setting location.href instead reloads the whole app: on iOS the page
 * goes blank and starts over, and with App Lock on it locks again.
 */
type Navigate = (path: string, options?: { replace?: boolean }) => void;

let navigateRef: Navigate | null = null;

export function setAppNavigate(fn: Navigate | null): void {
  navigateRef = fn;
}

export function navigateInApp(path: string): void {
  if (navigateRef) navigateRef(path);
  else globalThis.location.href = path;
}
