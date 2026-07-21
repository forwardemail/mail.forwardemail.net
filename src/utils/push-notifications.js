/**
 * Forward Email – Native Push Notification Manager
 *
 * Uses direct APNs device tokens through tauri-plugin-mobile-push on iOS,
 * and either FCM or Google-free UnifiedPush subscriptions on Android.
 * Desktop builds intentionally do not initialize a mobile remote-push plugin;
 * they receive real-time events over WebSocket and may display local system
 * notifications through notification-manager.js.
 */

import { isDemoMode } from './demo-mode.js';
import { isTauriMobile } from './platform.js';
import { Local } from './storage';
import { listPushTokens, registerPushToken, unregisterPushToken } from './background-service.js';
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

// Timeout for native push bridge calls such as token retrieval and listener
// setup. If one hangs (common on Android when Google Play Services is
// unavailable), the UI should recover gracefully instead of freezing.
const NATIVE_PUSH_TIMEOUT_MS = 15_000;

// Permission prompts show a system dialog and wait on a human decision, so
// they get a much longer budget. This only guards against a hung bridge call,
// not against a user taking their time with the dialog.
const PERMISSION_PROMPT_TIMEOUT_MS = 120_000;

class PushTimeoutError extends Error {
  constructor(operation, ms) {
    super(`${operation} timed out after ${ms}ms`);
    this.name = 'PushTimeoutError';
  }
}

function withTimeout(promise, ms, operation = 'Operation') {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new PushTimeoutError(operation, ms));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

const TOKEN_STORAGE_KEY = 'push_notification_token';
const TOKEN_PLATFORM_KEY = 'push_notification_platform';
const REGISTRATION_ID_STORAGE_KEY = 'push_notification_registration_id';
const ANDROID_PREFERRED_PROVIDER_KEY = 'push_notification_preferred_provider';
const ANDROID_PROVIDER = (import.meta.env.VITE_ANDROID_PUSH_PROVIDER || 'auto').toLowerCase();

let initialized = false;
let initializationPromise = null;
let activeNativeProvider = null;
let nativeListenerCleanups = [];
let managementPromise = null;
const pushStatusListeners = new Set();

function getMobilePlatform() {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('android')) return 'android';
  if (/iphone|ipad|ipod/.test(userAgent)) return 'ios';
  return null;
}

function isValidNativeToken(token) {
  return typeof token === 'string' && token.length >= 16 && token.length <= 4096;
}

function normalizePushProvider(platform) {
  if (platform === 'ios' || platform === 'apns') return 'apns';
  if (platform === 'android' || platform === 'fcm') return 'fcm';
  if (platform === 'unified-push') return 'unified-push';
  return null;
}

function getPushProviderLabel(provider) {
  if (provider === 'apns') return 'Apple Push Notification Service';
  if (provider === 'fcm') return 'Firebase Cloud Messaging';
  if (provider === 'unified-push') return 'UnifiedPush';
  return 'Not selected';
}

function notifyPushStatusChanged() {
  for (const listener of pushStatusListeners) {
    try {
      listener();
    } catch {
      // A Settings subscriber must not interrupt native push processing.
    }
  }
}

export function subscribePushStatus(listener) {
  if (typeof listener !== 'function') return () => {};
  pushStatusListeners.add(listener);
  return () => pushStatusListeners.delete(listener);
}

function normalizePushTokenForComparison(provider, token) {
  if (typeof token !== 'string') return '';
  return provider === 'apns' ? token.toLowerCase() : token;
}

async function getTokenFingerprint(provider, token) {
  const normalizedToken = normalizePushTokenForComparison(provider, token);
  if (!normalizedToken || typeof TextEncoder === 'undefined' || !globalThis.crypto?.subtle) {
    return null;
  }

  try {
    const input = new TextEncoder().encode(`${provider || 'unknown'}:${normalizedToken}`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
    const prefix = [...new Uint8Array(digest)]
      .slice(0, 4)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    return `${prefix.slice(0, 4)}-${prefix.slice(4)}`;
  } catch {
    return null;
  }
}

function normalizeIsoDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function sanitizePushRegistration(record, localRegistrationId, localProvider, localToken) {
  if (!record || typeof record !== 'object') return null;

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const provider = normalizePushProvider(record.platform);
  const token = typeof record.token === 'string' ? record.token : '';
  if (!id || !provider || !token) return null;

  const isCurrentDevice =
    id === localRegistrationId ||
    (provider === localProvider &&
      normalizePushTokenForComparison(provider, token) ===
        normalizePushTokenForComparison(localProvider, localToken));
  const failureCount = Number(record.failure_count);

  return {
    id,
    platform: provider,
    providerLabel: getPushProviderLabel(provider),
    deviceName:
      typeof record.device_name === 'string' && record.device_name.trim()
        ? record.device_name.trim().slice(0, 255)
        : 'Unnamed device',
    tokenFingerprint: (await getTokenFingerprint(provider, token)) || 'Unavailable',
    lastUsedAt: normalizeIsoDate(record.last_used_at),
    failureCount: Number.isFinite(failureCount) && failureCount > 0 ? Math.floor(failureCount) : 0,
    expiresAt: normalizeIsoDate(record.expires_at),
    createdAt: normalizeIsoDate(record.created_at),
    updatedAt: normalizeIsoDate(record.updated_at),
    isCurrentDevice,
  };
}

function getCurrentPushProvider() {
  const storedProvider = normalizePushProvider(Local.get(TOKEN_PLATFORM_KEY));
  if (storedProvider) return storedProvider;
  if (activeNativeProvider) return activeNativeProvider;

  const platform = getMobilePlatform();
  if (platform === 'ios') return 'apns';
  if (platform !== 'android') return null;
  if (ANDROID_PROVIDER === 'fcm' || ANDROID_PROVIDER === 'unified-push') return ANDROID_PROVIDER;
  return getAndroidPushProviderPreference();
}

async function getNotificationPermissionStatus() {
  if (!isTauriMobile) return 'unsupported';

  try {
    const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
    return (await isPermissionGranted()) ? 'granted' : 'not-granted';
  } catch {
    return 'unknown';
  }
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

  notifyPushStatusChanged();
  return true;
}

async function registerNativeToken(getToken, platform) {
  const token = await withTimeout(getToken(), NATIVE_PUSH_TIMEOUT_MS, 'getToken');
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

  const permission = await withTimeout(
    requestPermission(),
    PERMISSION_PROMPT_TIMEOUT_MS,
    'iOS requestPermission',
  );
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

  const permission = await withTimeout(
    requestPermission(),
    PERMISSION_PROMPT_TIMEOUT_MS,
    'Android requestPermission',
  );
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
      notifyPushStatusChanged();
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

  // A dual-provider build defaults to FCM, but an explicit UnifiedPush
  // distributor choice is a durable device preference and must survive restarts.
  if (Local.get(ANDROID_PREFERRED_PROVIDER_KEY) === 'unified-push') {
    try {
      if (await initializeUnifiedPush()) return true;
    } catch (error) {
      console.info('[push] Preferred UnifiedPush unavailable; trying FCM:', error);
    }

    return initializeAndroidFcmPush();
  }

  try {
    if (await initializeAndroidFcmPush()) return true;
  } catch (error) {
    console.info('[push] FCM unavailable; trying UnifiedPush:', error);
  }

  return initializeUnifiedPush();
}

async function initializePushNotifications() {
  await removeNativeListeners();
  await removeUnifiedPushListeners();

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
    const isTimeout = error instanceof PushTimeoutError;
    console.warn(`[push] Native push initialization ${isTimeout ? 'timed out' : 'failed'}:`, error);
    // Re-throw timeouts so callers (e.g. registerCurrentDevicePush) can surface
    // a specific 'registration-timeout' code to the UI for retry guidance.
    if (isTimeout) throw error;
  }

  return false;
}

/**
 * Initialize remote push for the active mobile account.
 * Concurrent lifecycle triggers share one native registration attempt.
 *
 * @returns {Promise<boolean>} true when APNs, FCM, or UnifiedPush registered
 */
export async function initPushNotifications() {
  if (!isTauriMobile) return false;
  if (initialized) return true;
  if (initializationPromise) return initializationPromise;

  initializationPromise = initializePushNotifications();
  try {
    return await initializationPromise;
  } finally {
    initializationPromise = null;
  }
}

/**
 * Synchronize remote push when a real alias-authenticated mobile account is active.
 * Safe to invoke after login, during bootstrap, and whenever the app resumes.
 */
export async function syncPushNotifications() {
  if (!isTauriMobile || isDemoMode() || !Local.get('alias_auth')) return false;
  return initPushNotifications();
}

/**
 * Remove provider listeners and the active account's server registration.
 * Must run before sign-out clears credentials.
 */
export async function cleanupPushNotifications() {
  const pendingInitialization = initializationPromise;
  if (pendingInitialization) await pendingInitialization.catch(() => {});

  await removeNativeListeners();
  await removeUnifiedPushListeners();

  const registrationId = Local.get(REGISTRATION_ID_STORAGE_KEY);
  const serverRegistrationRemoved = registrationId
    ? await unregisterPushToken(registrationId)
    : true;

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
  notifyPushStatusChanged();
  return serverRegistrationRemoved;
}

function createBasePushStatus() {
  const platform = getMobilePlatform();
  const supported = isTauriMobile && (platform === 'ios' || platform === 'android');
  const authenticated = Boolean(Local.get('alias_auth'));
  const demo = isDemoMode();
  const provider = supported ? getCurrentPushProvider() : null;

  return {
    supported,
    authenticated,
    demo,
    platform: supported ? platform : null,
    provider,
    providerLabel: getPushProviderLabel(provider),
    androidProviderMode: supported && platform === 'android' ? ANDROID_PROVIDER : null,
    providerPreference:
      supported && platform === 'android' ? getAndroidPushProviderPreference() : null,
    permission: supported ? 'unknown' : 'unsupported',
    initialized,
    localTokenPresent: false,
    localTokenFingerprint: null,
    serverReachable: false,
    currentRegistration: null,
    otherRegistrations: [],
    unifiedPush: null,
    health: 'unsupported',
  };
}

/**
 * Return a side-effect-free, privacy-preserving push status snapshot for Settings.
 * This function never requests permission or starts native registration.
 */
export async function getPushNotificationStatus() {
  const status = createBasePushStatus();
  if (!status.supported) return status;

  const localToken = Local.get(TOKEN_STORAGE_KEY);
  const localRegistrationId = Local.get(REGISTRATION_ID_STORAGE_KEY);
  const localProvider = normalizePushProvider(Local.get(TOKEN_PLATFORM_KEY)) || status.provider;
  status.localTokenPresent = typeof localToken === 'string' && Boolean(localToken);
  status.localTokenFingerprint = status.localTokenPresent
    ? await getTokenFingerprint(localProvider, localToken)
    : null;
  status.permission = await getNotificationPermissionStatus();

  if (status.platform === 'android' && isUnifiedPushSupported()) {
    try {
      status.unifiedPush = await getUnifiedPushState();
    } catch {
      status.unifiedPush = null;
    }
  }

  if (!status.authenticated || status.demo) {
    status.health = 'not-registered';
    return status;
  }

  const serverRecords = await listPushTokens();
  if (!serverRecords) {
    status.health = 'server-unavailable';
    return status;
  }

  status.serverReachable = true;
  const registrations = (
    await Promise.all(
      serverRecords.map((record) =>
        sanitizePushRegistration(record, localRegistrationId, localProvider, localToken),
      ),
    )
  ).filter(Boolean);
  status.currentRegistration =
    registrations.find((registration) => registration.isCurrentDevice) || null;
  status.otherRegistrations = registrations.filter(
    (registration) => registration.id !== status.currentRegistration?.id,
  );

  if (
    status.provider === 'unified-push' &&
    (!status.unifiedPush?.distributor || status.unifiedPush?.selectionRequired)
  ) {
    status.health = 'needs-distributor';
  } else if (status.provider !== 'unified-push' && status.permission === 'not-granted') {
    status.health = 'permission-not-granted';
  } else if (
    status.currentRegistration &&
    status.localTokenPresent &&
    status.currentRegistration.failureCount < 3
  ) {
    status.health = 'active';
  } else if (status.currentRegistration || status.localTokenPresent || initialized) {
    status.health = 'needs-repair';
  } else {
    status.health = 'not-registered';
  }

  return status;
}

function runPushManagement(operation) {
  if (managementPromise) return managementPromise;

  managementPromise = Promise.resolve()
    .then(operation)
    .finally(() => {
      managementPromise = null;
    });
  return managementPromise;
}

function getManagementGuardCode(status) {
  if (!status.supported) return 'unsupported';
  if (!status.authenticated) return 'authentication-required';
  if (status.demo) return 'demo-mode';
  return null;
}

function getRegistrationFailureCode(status) {
  if (status.health === 'needs-distributor') return 'distributor-required';
  if (status.provider !== 'unified-push' && status.permission === 'not-granted') {
    return 'permission-denied';
  }

  if (!status.serverReachable) return 'server-unavailable';
  return 'registration-failed';
}

async function removeCurrentPushRegistration(initialStatus) {
  const localRegistrationId = Local.get(REGISTRATION_ID_STORAGE_KEY);
  let removed = await cleanupPushNotifications();
  const matchedRegistrationId = initialStatus.currentRegistration?.id;

  if (matchedRegistrationId && matchedRegistrationId !== localRegistrationId) {
    removed = (await unregisterPushToken(matchedRegistrationId)) && removed;
  }

  return removed;
}

export function registerCurrentDevicePush() {
  return runPushManagement(async () => {
    const initialStatus = await getPushNotificationStatus();
    const guardCode = getManagementGuardCode(initialStatus);
    if (guardCode) return { ok: false, code: guardCode, status: initialStatus };

    try {
      await syncPushNotifications();
    } catch (error) {
      if (error instanceof PushTimeoutError) {
        const status = await getPushNotificationStatus();
        return { ok: false, code: 'registration-timeout', status };
      }

      throw error;
    }

    const status = await getPushNotificationStatus();
    const ok = status.health === 'active';
    return {
      ok,
      code: ok ? 'registered' : getRegistrationFailureCode(status),
      status,
    };
  });
}

export function deregisterCurrentDevicePush() {
  return runPushManagement(async () => {
    const initialStatus = await getPushNotificationStatus();
    const guardCode = getManagementGuardCode(initialStatus);
    if (guardCode) return { ok: false, code: guardCode, status: initialStatus };

    const removed = await removeCurrentPushRegistration(initialStatus);
    const status = await getPushNotificationStatus();
    const ok = removed && status.serverReachable && !status.currentRegistration;
    return {
      ok,
      code: ok
        ? 'deregistered'
        : status.serverReachable
          ? 'deregistration-failed'
          : 'server-unavailable',
      status,
    };
  });
}

export function reregisterCurrentDevicePush() {
  return runPushManagement(async () => {
    const initialStatus = await getPushNotificationStatus();
    const guardCode = getManagementGuardCode(initialStatus);
    if (guardCode) return { ok: false, code: guardCode, status: initialStatus };

    if (!(await removeCurrentPushRegistration(initialStatus))) {
      const status = await getPushNotificationStatus();
      return { ok: false, code: 'deregistration-failed', status };
    }

    try {
      await syncPushNotifications();
    } catch (error) {
      if (error instanceof PushTimeoutError) {
        const status = await getPushNotificationStatus();
        return { ok: false, code: 'registration-timeout', status };
      }

      throw error;
    }

    const status = await getPushNotificationStatus();
    const ok = status.health === 'active';
    return {
      ok,
      code: ok ? 'reregistered' : getRegistrationFailureCode(status),
      status,
    };
  });
}

export function removePushRegistration(registrationId) {
  return runPushManagement(async () => {
    const initialStatus = await getPushNotificationStatus();
    const guardCode = getManagementGuardCode(initialStatus);
    if (guardCode) return { ok: false, code: guardCode, status: initialStatus };

    const id = typeof registrationId === 'string' ? registrationId.trim() : '';
    if (!id) return { ok: false, code: 'deregistration-failed', status: initialStatus };

    const isCurrentRegistration =
      id === Local.get(REGISTRATION_ID_STORAGE_KEY) || id === initialStatus.currentRegistration?.id;
    const removed = isCurrentRegistration
      ? await removeCurrentPushRegistration(initialStatus)
      : await unregisterPushToken(id);
    if (removed) notifyPushStatusChanged();

    const status = await getPushNotificationStatus();
    const registrationStillExists =
      status.currentRegistration?.id === id ||
      status.otherRegistrations.some((registration) => registration.id === id);
    const ok = removed && status.serverReachable && !registrationStillExists;
    return {
      ok,
      code: ok
        ? 'removed'
        : status.serverReachable
          ? 'deregistration-failed'
          : 'server-unavailable',
      status,
    };
  });
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
export function getAndroidPushProviderPreference() {
  return Local.get(ANDROID_PREFERRED_PROVIDER_KEY) === 'unified-push' ? 'unified-push' : 'fcm';
}

export async function selectUnifiedPushDistributor() {
  if (!isUnifiedPushSupported()) return false;
  await cleanupPushNotifications();
  await initializeUnifiedPushListeners();
  await pickUnifiedPushDistributor();
  Local.set(ANDROID_PREFERRED_PROVIDER_KEY, 'unified-push');
  activeNativeProvider = 'unified-push';
  notifyPushStatusChanged();
  return true;
}

export async function selectFcmPushProvider() {
  if (!isUnifiedPushSupported()) return false;
  Local.remove(ANDROID_PREFERRED_PROVIDER_KEY);
  await cleanupPushNotifications();
  notifyPushStatusChanged();
  return initPushNotifications();
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
