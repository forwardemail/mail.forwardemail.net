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
export function exitDemoAndRedirect(): void;
export function interceptDemoRequest(
  action: string,
  params?: Record<string, unknown>,
  options?: DemoRequestOptions,
): DemoInterceptResult;
