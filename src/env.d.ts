/// <reference types="vite/client" />

// Extend Vite's ImportMetaEnv with our custom variables
declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION: string;
    readonly VITE_BUILD_HASH: string;
    readonly VITE_PKG_VERSION: string;
    /**
     * Set only by `pnpm build:e2e`. Gates the pairing-scanner decoder
     * injection point so a shipped build cannot be steered into a fake
     * decoder. See device-sync/scanner.ts.
     */
    readonly VITE_E2E?: string;
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
    /**
     * E2E-only: supplies a decoder to the pairing scanner so the flow can be
     * driven without a physical camera. Honoured only in VITE_E2E builds.
     */
    __feDeviceSyncDecoder?: () => Promise<unknown>;
  }
}

export {};
