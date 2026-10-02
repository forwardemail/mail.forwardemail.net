export interface StoreBuildEnv {
  tauri?: boolean;
  platform?: string | null;
  androidPushProvider?: string;
}

export function isAppStoreBuild(env?: StoreBuildEnv): boolean;
export function shouldHidePurchaseLinks(): boolean;
