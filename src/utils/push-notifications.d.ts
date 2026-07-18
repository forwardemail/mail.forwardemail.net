export type PushProvider = 'apns' | 'fcm' | 'unified-push';
export type PushPlatform = 'ios' | 'android';
export type PushPermissionStatus = 'granted' | 'not-granted' | 'unknown' | 'unsupported';
export type PushHealth =
  | 'active'
  | 'not-registered'
  | 'needs-repair'
  | 'permission-not-granted'
  | 'needs-distributor'
  | 'server-unavailable'
  | 'unsupported';

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

export interface PushRegistrationStatus {
  id: string;
  platform: PushProvider;
  providerLabel: string;
  deviceName: string;
  tokenFingerprint: string;
  lastUsedAt: string | null;
  failureCount: number;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  isCurrentDevice: boolean;
}

export interface PushNotificationStatus {
  supported: boolean;
  authenticated: boolean;
  demo: boolean;
  platform: PushPlatform | null;
  provider: PushProvider | null;
  providerLabel: string;
  androidProviderMode: 'auto' | 'fcm' | 'unified-push' | null;
  providerPreference: 'fcm' | 'unified-push' | null;
  permission: PushPermissionStatus;
  initialized: boolean;
  localTokenPresent: boolean;
  localTokenFingerprint: string | null;
  serverReachable: boolean;
  currentRegistration: PushRegistrationStatus | null;
  otherRegistrations: PushRegistrationStatus[];
  unifiedPush: UnifiedPushProviderState | null;
  health: PushHealth;
}

export type PushManagementCode =
  | 'registered'
  | 'deregistered'
  | 'reregistered'
  | 'removed'
  | 'unsupported'
  | 'authentication-required'
  | 'demo-mode'
  | 'permission-denied'
  | 'distributor-required'
  | 'server-unavailable'
  | 'registration-failed'
  | 'registration-timeout'
  | 'deregistration-failed';

export interface PushManagementResult {
  ok: boolean;
  code: PushManagementCode;
  status: PushNotificationStatus;
}

export interface PushNavigationAction {
  action: 'navigate';
  path: string;
}

export function initPushNotifications(): Promise<boolean>;
export function syncPushNotifications(): Promise<boolean>;
export function cleanupPushNotifications(): Promise<boolean>;
export function getPushNotificationStatus(): Promise<PushNotificationStatus>;
export function subscribePushStatus(listener: () => void): () => void;
export function registerCurrentDevicePush(): Promise<PushManagementResult>;
export function deregisterCurrentDevicePush(): Promise<PushManagementResult>;
export function reregisterCurrentDevicePush(): Promise<PushManagementResult>;
export function removePushRegistration(registrationId: string): Promise<PushManagementResult>;
export function getStoredPushToken(): string | null;
export function getPushPlatform(): 'ios' | 'android' | PushProvider | null;
export function isPushInitialized(): boolean;
export function getAndroidPushProviderPreference(): 'fcm' | 'unified-push';
export function selectFcmPushProvider(): Promise<boolean>;
export function selectUnifiedPushDistributor(): Promise<boolean>;
export function getUnifiedPushProviderState(): Promise<UnifiedPushProviderState | null>;
export function handlePushPayload(payload: unknown): PushNavigationAction | null;
