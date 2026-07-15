/**
 * Forward Email – Native Push Notification Manager
 *
 * Uses direct APNs device tokens through tauri-plugin-mobile-push on iOS,
 * and either FCM or Google-free UnifiedPush subscriptions on Android.
 * Desktop builds intentionally do not initialize a mobile remote-push plugin;
 * they receive real-time events over WebSocket and may display local system
 * notifications through notification-manager.js.
 */

import { isTauriMobile } from './platform.js';
import { Local } from './storage';
import { registerPushToken, unregisterPushToken } from './background-service.js';
import { requestPermission as requestNotificationPermission } from './notification-bridge.js';
import {
  drainUnifiedPushMessages,
  getUnifiedPushState,
  getUnifiedPushVapidPublicKey,
  isUnifiedPushSupported,
  listenForUnifiedPush,
  pickUnifiedPushDistributor,
  registerUnifiedPush,
  removeUnifiedPushListeners,
  serializeUnifiedPushSubscription,
  unregisterUnifiedPush,
} from './unified-push.js';

const TOKEN_STORAGE_KEY = 'push_notification_token';
const TOKEN_PLATFORM_KEY = 'push_notification_platform';
const REGISTRATION_ID_STORAGE_KEY = 'push_notification_registration_id';
const ANDROID_PROVIDER = (import.meta.env.VITE_ANDROID_PUSH_PROVIDER || 'auto').toLowerCase();

let initialized = false;
let activeNativeProvider = null;
let nativeListenerCleanups = [];

function getMobilePlatform() {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('android')) return 'android';
  if (/iphone|ipad|ipod/.test(userAgent)) return 'ios';
  return null;
}

function isValidNativeToken(token) {
  return typeof token === 'string' && token.length >= 16 && token.length <= 4096;
}

function dispatchPushPayload(notification, tapped = false, displayedBySystem = false) {
  const data = notification?.data;
  if (!data || typeof data !== 'object') return;

  const detail = {
    ...data,
    ...(tapped ? { notificationTapped: true } : {}),
    ...(displayedBySystem ? { displayedBySystem: true } : {}),
  };
  window.dispatchEvent(new CustomEvent('fe:push-notification', { detail }));
  window.dispatchEvent(new CustomEvent('fe:push', { detail }));
}

async function removeNativeListeners() {
  const listeners = nativeListenerCleanups;
  nativeListenerCleanups = [];

  await Promise.allSettled(
    listeners.map(async (listener) => {
      if (listener && typeof listener.unregister === 'function') {
        await listener.unregister();
      }
    }),
  );
}

async function replaceServerRegistration(token, platform) {
  const previousRegistrationId = Local.get(REGISTRATION_ID_STORAGE_KEY);
  const registrationId = await registerPushToken(token, platform);
  if (!registrationId) return false;

  Local.set(TOKEN_STORAGE_KEY, token);
  Local.set(TOKEN_PLATFORM_KEY, platform);
  Local.set(REGISTRATION_ID_STORAGE_KEY, registrationId);

  if (previousRegistrationId && previousRegistrationId !== registrationId) {
    await unregisterPushToken(previousRegistrationId);
  }

  return true;
}

async function registerNativeToken(getToken, platform) {
  const token = await getToken();
  if (!isValidNativeToken(token)) {
    console.warn('[push] Native push provider returned an invalid token');
    return false;
  }

  return replaceServerRegistration(token, platform);
}

async function initializeIosPush() {
  const {
    getToken,
    onNotificationReceived,
    onNotificationTapped,
    onTokenRefresh,
    requestPermission,
  } = await import('tauri-plugin-mobile-push-api');

  const permission = await requestPermission();
  if (!permission?.granted) {
    console.info('[push] iOS notification permission was not granted');
    return false;
  }

  if (!(await registerNativeToken(getToken, 'ios'))) return false;

  const tokenRefreshListener = await onTokenRefresh(async ({ token }) => {
    if (!isValidNativeToken(token)) {
      console.warn('[push] Ignoring invalid refreshed APNs token');
      return;
    }

    if (await replaceServerRegistration(token, 'ios')) {
      console.info('[push] Refreshed APNs token registration');
    }
  });
  const receivedListener = await onNotificationReceived((notification) => {
    dispatchPushPayload(notification, false);
  });
  const tappedListener = await onNotificationTapped((notification) => {
    // A tap can only follow a notification already rendered by the OS. Preserve
    // navigation/state delivery while preventing a second foreground visual.
    dispatchPushPayload(notification, true, true);
  });

  nativeListenerCleanups = [tokenRefreshListener, receivedListener, tappedListener];
  return true;
}

async function initializeAndroidFcmPush() {
  const {
    getToken,
    onNotificationReceived,
    onNotificationTapped,
    onTokenRefresh,
    requestPermission,
  } = await import('tauri-plugin-remote-push-api');

  const permission = await requestPermission();
  if (!permission?.granted) {
    console.info('[push] Android notification permission was not granted');
    return false;
  }

  if (!(await registerNativeToken(getToken, 'android'))) return false;

  const tokenRefreshListener = await onTokenRefresh(async (token) => {
    if (!isValidNativeToken(token)) {
      console.warn('[push] Ignoring invalid refreshed FCM token');
      return;
    }

    if (await replaceServerRegistration(token, 'android')) {
      console.info('[push] Refreshed FCM token registration');
    }
  });
  const receivedListener = await onNotificationReceived((notification) => {
    dispatchPushPayload(notification, false);
  });
  const tappedListener = await onNotificationTapped((notification) => {
    // A tap can only follow a notification already rendered by the OS. Preserve
    // navigation/state delivery while preventing a second foreground visual.
    dispatchPushPayload(notification, true, true);
  });

  nativeListenerCleanups = [tokenRefreshListener, receivedListener, tappedListener];
  activeNativeProvider = 'fcm';
  return true;
}

async function registerUnifiedPushSubscription(subscription) {
  const serialized = serializeUnifiedPushSubscription(subscription);
  if (!serialized) {
    console.warn('[push] UnifiedPush returned an invalid Web Push subscription');
    return false;
  }

  return replaceServerRegistration(serialized, 'unified-push');
}

async function initializeUnifiedPushListeners() {
  return listenForUnifiedPush({
    onSubscription: async (subscription) => {
      if (await registerUnifiedPushSubscription(subscription)) {
        initialized = true;
        activeNativeProvider = 'unified-push';
        console.info('[push] Registered rotated UnifiedPush subscription');
      }
    },
    onMessage: ({ payload, displayedBySystem }) => {
      dispatchPushPayload({ data: payload }, false, displayedBySystem === true);
    },
    onRegistrationFailed: (reason) => {
      console.warn('[push] UnifiedPush registration failed:', reason);
    },
    onUnregistered: async () => {
      const registrationId = Local.get(REGISTRATION_ID_STORAGE_KEY);
      if (registrationId) await unregisterPushToken(registrationId);
      Local.remove(TOKEN_STORAGE_KEY);
      Local.remove(TOKEN_PLATFORM_KEY);
      Local.remove(REGISTRATION_ID_STORAGE_KEY);
      initialized = false;
      activeNativeProvider = null;
    },
    onTemporaryUnavailable: () => {
      console.info('[push] UnifiedPush distributor is temporarily unavailable');
    },
  });
}

async function initializeUnifiedPush() {
  if (!isUnifiedPushSupported()) return false;
  if (!getUnifiedPushVapidPublicKey()) {
    console.warn('[push] VAPID_PUBLIC_KEY is not configured');
    return false;
  }

  const permission = await requestNotificationPermission();
  if (permission !== 'granted') {
    // Keep the subscription active even when display permission is declined:
    // queued data messages can still refresh the app when it is opened.
    console.info('[push] Android notification permission was not granted');
  }

  await initializeUnifiedPushListeners();
  const state = await getUnifiedPushState();
  let registered = false;

  if (state?.subscription) {
    registered = await registerUnifiedPushSubscription(state.subscription);
  }

  const queuedMessages = await drainUnifiedPushMessages();
  for (const message of queuedMessages) {
    dispatchPushPayload({ data: message.payload }, false, message.displayedBySystem === true);
  }

  try {
    await registerUnifiedPush();
  } catch (error) {
    const reason = String(error?.message || error);
    if (reason.includes('distributor_selection_required')) {
      console.info('[push] UnifiedPush distributor selection requires a user action');
    } else if (reason.includes('no_unifiedpush_distributor_available')) {
      console.info('[push] No UnifiedPush distributor is installed');
    } else {
      throw error;
    }
  }

  if (registered || state?.distributor) {
    activeNativeProvider = 'unified-push';
    return true;
  }

  return false;
}

async function initializeAndroidPush() {
  if (ANDROID_PROVIDER === 'unified-push') return initializeUnifiedPush();
  if (ANDROID_PROVIDER === 'fcm') return initializeAndroidFcmPush();

  try {
    if (await initializeAndroidFcmPush()) return true;
  } catch (error) {
    console.info('[push] FCM unavailable; trying UnifiedPush:', error);
  }

  return initializeUnifiedPush();
}

/**
 * Initialize remote push for the active mobile account.
 *
 * @returns {Promise<boolean>} true when APNs or FCM registered
 */
export async function initPushNotifications() {
  if (!isTauriMobile) return false;
  if (initialized) return true;

  const platform = getMobilePlatform();
  if (!platform) {
    console.warn('[push] Unable to determine mobile platform');
    return false;
  }

  try {
    const initializedNative =
      platform === 'ios' ? await initializeIosPush() : await initializeAndroidPush();
    if (initializedNative) {
      initialized = true;
      activeNativeProvider = platform === 'ios' ? 'apns' : activeNativeProvider;
      console.info(`[push] Initialized native ${activeNativeProvider} push`);
      return true;
    }
  } catch (error) {
    console.warn('[push] Native push initialization failed:', error);
  }

  return false;
}

/**
 * Remove provider listeners and the active account's server registration.
 * Must run before sign-out clears credentials.
 */
export async function cleanupPushNotifications() {
  await removeNativeListeners();
  await removeUnifiedPushListeners();

  const registrationId = Local.get(REGISTRATION_ID_STORAGE_KEY);
  if (registrationId) await unregisterPushToken(registrationId);

  if (activeNativeProvider === 'unified-push') {
    try {
      await unregisterUnifiedPush();
    } catch (error) {
      console.warn('[push] UnifiedPush distributor cleanup failed:', error);
    }
  }

  Local.remove(TOKEN_STORAGE_KEY);
  Local.remove(TOKEN_PLATFORM_KEY);
  Local.remove(REGISTRATION_ID_STORAGE_KEY);
  initialized = false;
  activeNativeProvider = null;
}

export function getStoredPushToken() {
  return Local.get(TOKEN_STORAGE_KEY) || null;
}

export function getPushPlatform() {
  return Local.get(TOKEN_PLATFORM_KEY) || getMobilePlatform();
}

export function isPushInitialized() {
  return initialized;
}

/**
 * Open the UnifiedPush distributor picker after an explicit settings action.
 */
export async function selectUnifiedPushDistributor() {
  if (!isUnifiedPushSupported()) return false;
  await initializeUnifiedPushListeners();
  await pickUnifiedPushDistributor();
  activeNativeProvider = 'unified-push';
  return true;
}

export async function getUnifiedPushProviderState() {
  return getUnifiedPushState();
}

/**
 * Convert an incoming push payload into the app navigation action it represents.
 */
export function handlePushPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const type = payload.type || data.type;
  if (typeof type !== 'string') return null;

  const firstNonEmpty = (...values) => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }

    return '';
  };

  switch (type) {
    case 'new-message': {
      const uid = payload.uid || data.uid;
      const mailbox = payload.mailbox || data.mailbox || 'INBOX';
      if (uid) return { action: 'navigate', path: `#${mailbox}/${uid}` };
      return { action: 'navigate', path: '#INBOX' };
    }

    case 'calendar-event':
    case 'calendar-task': {
      const itemId = firstNonEmpty(payload.id, payload.uid, data.id, data.uid, data.event_id);
      const hash = itemId
        ? `${type === 'calendar-task' ? '#task=' : '#event='}${encodeURIComponent(itemId)}`
        : '';
      return { action: 'navigate', path: `/calendar${hash}` };
    }

    case 'contact-update':
    case 'contact-created': {
      const contactId = firstNonEmpty(payload.id, payload.uid, data.id, data.uid, data.contact_id);
      const hash = contactId ? `#contact=${encodeURIComponent(contactId)}` : '';
      return { action: 'navigate', path: `/contacts${hash}` };
    }

    case 'note-update':
    case 'note-created':
      return { action: 'navigate', path: '#notes' };

    default:
      return null;
  }
}
