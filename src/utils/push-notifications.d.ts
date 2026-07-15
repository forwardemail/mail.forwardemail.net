export interface UnifiedPushProviderState {
  availableDistributors: string[];
  distributor: string | null;
  selectionRequired: boolean;
  instance: string | null;
  subscription: {
    endpoint: string;
    p256dh: string;
    auth: string;
  } | null;
}

export interface PushNavigationAction {
  action: 'navigate';
  path: string;
}

export function initPushNotifications(): Promise<boolean>;
export function cleanupPushNotifications(): Promise<void>;
export function getStoredPushToken(): string | null;
export function getPushPlatform(): 'ios' | 'android' | 'apns' | 'fcm' | 'unified-push' | null;
export function isPushInitialized(): boolean;
export function selectUnifiedPushDistributor(): Promise<boolean>;
export function getUnifiedPushProviderState(): Promise<UnifiedPushProviderState | null>;
export function handlePushPayload(payload: unknown): PushNavigationAction | null;
