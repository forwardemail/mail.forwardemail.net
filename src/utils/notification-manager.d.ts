export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface NotificationToastAction {
  label: string;
  callback: () => void;
}

export interface NotificationToastHost {
  show?: (
    message: string,
    type?: string,
    timeoutOrOptions?: number | Record<string, unknown>,
    action?: NotificationToastAction | null,
  ) => unknown;
}

export interface NotificationEventSource {
  on: (event: string, handler: (payload: unknown) => void) => () => void;
}

export function setNotificationToasts(toasts: NotificationToastHost | null | undefined): void;
export function requestNotificationPermission(): Promise<boolean>;
export function getNotificationPermissionState(): Promise<NotificationPermissionState>;
export function initNotificationPermission(): Promise<boolean>;
export function showTestNotification(): Promise<boolean>;
export function setBadgeCount(count: number): Promise<void>;
export function getBadgeCount(): number;
export function incrementBadge(delta: number): Promise<void>;
export function initBadgeFromStore(): Promise<void>;
export function connectNotifications(wsClient: NotificationEventSource): () => void;
export function connectMultiAccountNotifications(wsManager: NotificationEventSource): () => void;
