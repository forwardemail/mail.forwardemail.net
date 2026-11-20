export interface DemoBlockedError {
  code?: string;
  isDemo?: boolean;
}

export interface DemoToastAction {
  callback: () => void;
  label: string;
}

export interface DemoToastOptions {
  action?: DemoToastAction;
  duration?: number;
}

export interface DemoToastHost {
  show: (message: string, type?: string, options?: DemoToastOptions) => void;
}

export interface DemoRequestOptions {
  demoAction?: string;
  pathOverride?: string;
  [key: string]: unknown;
}

export interface DemoInterceptResult {
  handled: boolean;
  result?: unknown;
}

export function isDemoMode(): boolean;
export function activateDemoMode(): void;
export function deactivateDemoMode(): void;
export function setDemoToasts(toasts: DemoToastHost | null): void;
export function isDemoBlockedError(error: unknown): error is DemoBlockedError;
export function showDemoBlockedToast(actionLabel?: string): void;
export function cleanupDemoAccount(options?: { preserveCredentials?: boolean }): Promise<void>;
export function exitDemoAndRedirect(options?: { openSignUp?: boolean }): void;
export function interceptDemoRequest(
  action: string,
  params?: Record<string, unknown>,
  options?: DemoRequestOptions,
): DemoInterceptResult;

export function demoBlockedError(): Error & DemoBlockedError;

/** The demo mailbox, for the demo mail backend (src/backends/demo.ts). */
export const demoMail: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  folders(): Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  folder(id: unknown): Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages(query?: Record<string, unknown>): Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message(id: unknown, folder?: string): Record<string, any> | null;
  setRead(id: unknown, read?: boolean): void;
  block(label?: string): never;
};
