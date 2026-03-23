/// <reference types="vite/client" />

// Extend Vite's ImportMetaEnv with our custom variables
declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string;
    readonly VITE_BUILD_HASH: string;
    readonly VITE_PKG_VERSION: string;
  }

  interface Window {
    __swRegistration?: ServiceWorkerRegistration;
    __performAppUpdate?: (version?: string) => Promise<void>;
    __checkForWebUpdates?: () => Promise<{
      upToDate: boolean;
      currentVersion: string | null;
      latestVersion: string | null;
    }>;
    gtag?: (...args: unknown[]) => void;
  }
}

export {};
