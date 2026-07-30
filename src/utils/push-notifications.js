/**
 * Forward Email – Native Push Notification Manager
 *
 * Uses direct APNs device tokens through tauri-plugin-mobile-push on iOS,
 * and either FCM or Google-free UnifiedPush subscriptions on Android.
 * Desktop builds intentionally do not initialize a mobile remote-push plugin;
 * they receive real-time events over WebSocket and may display local system
 * notifications through notification-manager.js.
 *
 * ## Per-Account Push Registration Model
 *
 * Each signed-in account independently maintains its own server-side push
 * registration. The device token (APNs/FCM) is shared (one physical device),
 * but every account gets its own registration so push notifications arrive
 * regardless of which account is currently "active" in the UI.
 *
 * Storage layout:
 *   push_registrations = JSON { [email]: { regId, token, platform } }
 *   push_notification_token = current device token (shared)
 *   push_notification_platform = current platform (shared)
 *
 * Lifecycle:
 *   - On boot/resume: reconcile ALL signed-in accounts against current token
 *   - On account add: automatically register push for the new account
 *   - On account switch: NO push teardown (all registrations stay alive)
 *   - On sign-out: remove ONLY that account's registration
 *   - On token refresh: update ALL accounts with the new token
 */

import { isDemoMode } from './demo-mode.js';
import { isTauriMobile } from './platform.js';
import { Local, Accounts } from './storage';
import {
  listPushTokens,
  registerPushToken,
  registerPushTokenForAccount,
  unregisterPushToken,
  unregisterPushTokenForAccount,
} from './background-service.js';
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
const REGISTRATIONS_KEY = 'push_registrations';
const ANDROID_PREFERRED_PROVIDER_KEY = 'push_notification_preferred_provider';
const ANDROID_PROVIDER = (import.meta.env.VITE_ANDROID_PUSH_PROVIDER || 'auto').toLowerCase();

// Legacy key — read during migration, then removed
const LEGACY_REGISTRATION_ID_KEY = 'push_notification_registration_id';
const LEGACY_MULTI_ACCOUNT_KEY = 'push_notification_multi_account';

let initialized = false;
let initializationPromise = null;
let activeNativeProvider = null;
let nativeListenerCleanups = [];
let managementPromise = null;
const pushStatusListeners = new Set();

// ── Per-Account Registration Storage ──────────────────────────────────────

/**
 * Get the per-account registrations map.
 * Returns { [email]: { regId, token, platform } }
 */
function getAccountRegistrations() {
  try {
    const raw = Local.get(REGISTRATIONS_KEY);
    if (!raw) {
      // Migrate from legacy single-registration storage
      return migrateLegacyRegistrations();
    }

    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Migrate from the old single-registration model to per-account.
 */
function migrateLegacyRegistrations() {
  const registrations = {};
  const legacyRegId = Local.get(LEGACY_REGISTRATION_ID_KEY);
  const legacyMulti = Local.get(LEGACY_MULTI_ACCOUNT_KEY);
  const activeEmail = Local.get('email');
  const token = Local.get(TOKEN_STORAGE_KEY);
  const platform = Local.get(TOKEN_PLATFORM_KEY);

  // Migrate the active account's registration
  if (legacyRegId && activeEmail) {
    registrations[activeEmail] = {
      regId: legacyRegId,
      token: token || '',
      platform: platform || '',
    };
  }

  // Migrate multi-account registrations
  if (legacyMulti) {
    try {
      const multi = JSON.parse(legacyMulti);
      for (const [email, regId] of Object.entries(multi)) {
        if (regId && typeof regId === 'string') {
          registrations[email] = { regId, token: token || '', platform: platform || '' };
        }
      }
    } catch {
      // ignore corrupt data
    }
  }

  // Clean up legacy keys
  Local.remove(LEGACY_REGISTRATION_ID_KEY);
  Local.remove(LEGACY_MULTI_ACCOUNT_KEY);

  if (Object.keys(registrations).length > 0) {
    setAccountRegistrations(registrations);
  }

  return registrations;
}

function setAccountRegistrations(registrations) {
  Local.set(REGISTRATIONS_KEY, JSON.stringify(registrations));
}

/**
 * Get the registration for a specific account.
 */
function getAccountRegistration(email) {
  const registrations = getAccountRegistrations();
  return registrations[email] || null;
}

/**
 * Set the registration for a specific account.
 *
 * `aliasId` is the server-side alias this account maps to. Inbound push
 * payloads identify their account only by `alias_id`, so without this stored
 * association the device cannot tell which mailbox a notification is for and
 * has to assume it is the one on screen.
 */
function setAccountRegistration(email, regId, token, platform, aliasId = '') {
  const registrations = getAccountRegistrations();
  registrations[email] = { regId, token, platform, aliasId };
  setAccountRegistrations(registrations);
}

/**
 * Resolve the account email that owns a server-side alias ID.
 *
 * Returns '' when no signed-in account claims it. That is a meaningful answer,
 * not a failure: it means the notification belongs to an account this device is
 * no longer signed into (a registration the server has not pruned yet), and the
 * caller should drop it rather than attribute it to the active account.
 */
export function resolveAccountForAliasId(aliasId) {
  if (typeof aliasId !== 'string' || !aliasId) return '';
  const registrations = getAccountRegistrations();
  for (const [email, reg] of Object.entries(registrations || {})) {
    // The signed-out sentinel is a registration, not an account: returning it
    // as an "email" would feed a non-address into every _account comparison
    // downstream, all of which would then read as "not the active account" and
    // drop the notification.
    if (email === '__active_session__') continue;
    if (reg?.aliasId && reg.aliasId === aliasId) return email;
  }
  return '';
}

/**
 * Whether EVERY signed-in account has a known alias ID.
 *
 * This is what makes "I do not recognise this alias" a safe conclusion. A
 * partial map cannot support it: if one account's re-registration failed on a
 * flaky network, its pushes carry an alias nothing matches, and dropping them
 * would silently suppress that mailbox's notifications until the next
 * reconcile. Requiring completeness means an unknown alias can only be a
 * registration for an account this device is no longer signed into.
 */
export function hasCompleteAliasIdMap() {
  const registrations = getAccountRegistrations() || {};

  const accounts = Accounts.getAll() || [];
  if (accounts.length) {
    return accounts.every((account) => Boolean(registrations[account.email]?.aliasId));
  }

  // No accounts list means only the signed-out sentinel can be registered, and
  // the sentinel is excluded from attribution (see resolveAccountForAliasId).
  // With nothing to resolve against, "unknown alias" proves nothing — stay
  // permissive rather than dropping a signed-out session's own notifications.
  return false;
}

/**
 * Remove the registration for a specific account.
 */
function removeAccountRegistration(email) {
  const registrations = getAccountRegistrations();
  delete registrations[email];
  setAccountRegistrations(registrations);
}

/**
 * Get the active account's registration ID (for status/health checks).
 */
function getActiveRegistrationId() {
  const email = Local.get('email');
  if (!email) return null;
  const reg = getAccountRegistration(email);
  return reg?.regId || null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getMobilePlatform() {
  const nativePlatform = globalThis.window?.__TAURI_OS_PLUGIN_INTERNALS__?.platform;
  if (nativePlatform === 'android' || nativePlatform === 'ios') return nativePlatform;

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

  // Push payloads name their account with `alias_id` and nothing else, while
  // every downstream consumer scopes on `_account` (the email the WebSocket
  // manager tags). Resolve it here, at the single point where push enters the
  // app, so the rest of the pipeline sees one shape regardless of transport.
  //
  // An alias we cannot resolve is dropped rather than passed through untagged.
  // Untagged used to mean "assume active", which let another mailbox's delivery
  // drive the on-screen account's refresh and notification. Dropping is only
  // sound once every signed-in account is mapped — see hasCompleteAliasIdMap —
  // so a legacy install, or one mid-way through filling the map in, keeps the
  // old permissive behaviour rather than losing notifications.
  const aliasId = typeof data.alias_id === 'string' ? data.alias_id : '';
  const account = resolveAccountForAliasId(aliasId);
  if (!account && aliasId && hasCompleteAliasIdMap()) {
    console.warn('[push] Dropping notification for unknown alias:', aliasId);
    return;
  }

  const detail = {
    ...data,
    ...(account ? { _account: account } : {}),
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

// ── Per-Account Registration Logic ────────────────────────────────────────

/**
 * Register the device token with the server for a specific account.
 * If the account already has a registration with the same token, skip it.
 * If the token changed (refresh), unregister the old one and register the new one.
 *
 * @param {string} email - Account email
 * @param {string} aliasAuth - Account credentials (email:password)
 * @param {string} token - Device token
 * @param {string} platform - 'ios' | 'android' | 'unified-push'
 * @returns {Promise<boolean>} true if registration succeeded or was already current
 */
async function registerForAccount(email, aliasAuth, token, platform) {
  const existing = getAccountRegistration(email);

  // If already registered with the same token, no action needed — unless the
  // stored record predates alias-ID capture. POST /v1/push-tokens upserts on
  // (alias, platform, token), so re-registering is idempotent and is the only
  // way an install upgraded from an older build learns its alias mapping.
  if (
    existing &&
    existing.regId &&
    existing.token === token &&
    existing.platform === platform &&
    existing.aliasId
  ) {
    return true;
  }

  // If token changed, unregister the old registration first
  if (existing && existing.regId && existing.token !== token) {
    try {
      await unregisterPushTokenForAccount(existing.regId, aliasAuth);
    } catch {
      // Best effort — old registration may already be expired
    }
  }

  // Register with the new token
  const registration = await registerPushTokenForAccount(token, platform, aliasAuth);
  if (registration?.id) {
    setAccountRegistration(email, registration.id, token, platform, registration.aliasId);
    return true;
  }

  return false;
}

/**
 * Register the device token for the active account using the active session auth.
 * This is the "primary" registration that uses getAuthHeader().
 */
async function registerForActiveAccount(token, platform) {
  const email = Local.get('email');
  if (!email) return false;

  const existing = getAccountRegistration(email);

  // Same token AND a known alias ID means nothing to do. A record without the
  // alias ID is re-registered so the account becomes attributable — see
  // registerForAccount for why that POST is safe to repeat.
  if (
    existing &&
    existing.regId &&
    existing.token === token &&
    existing.platform === platform &&
    existing.aliasId
  ) {
    return true;
  }

  // If token changed, unregister the old registration first
  if (existing && existing.regId && existing.token !== token) {
    await unregisterPushToken(existing.regId);
  }

  const registration = await registerPushToken(token, platform);
  if (registration?.id) {
    setAccountRegistration(email, registration.id, token, platform, registration.aliasId);
    Local.set(TOKEN_STORAGE_KEY, token);
    Local.set(TOKEN_PLATFORM_KEY, platform);
    return true;
  }

  return false;
}

/**
 * Reconcile push registrations for ALL signed-in accounts.
 * Called on boot, resume, and token refresh. This is the core of the
 * "dummy-proof" design: it ensures every account is registered with
 * the current device token, regardless of which account is active.
 *
 * @param {string} token - Current device token
 * @param {string} platform - 'ios' | 'android' | 'unified-push'
 */
async function reconcileAllAccounts(token, platform) {
  const accounts = Accounts.getAll();
  const activeEmail = Local.get('email');

  // Fallback: if no multi-account list exists but we have active session auth,
  // register using the active session (legacy/single-account mode).
  if ((!accounts || accounts.length === 0) && !activeEmail) {
    // No accounts and no active email — register via active session auth
    // (registerPushToken uses getAuthHeader which reads alias_auth directly)
    const existing = getAccountRegistration('__active_session__');
    // If already registered with the same token, no action needed
    if (existing && existing.regId && existing.token === token && existing.platform === platform) {
      return;
    }
    // If token changed, unregister the old registration first
    if (existing && existing.regId && existing.token !== token) {
      await unregisterPushToken(existing.regId);
    }
    const registration = await registerPushToken(token, platform);
    if (registration?.id) {
      Local.set(TOKEN_STORAGE_KEY, token);
      Local.set(TOKEN_PLATFORM_KEY, platform);
      // Store under a sentinel key so cleanup can find it
      setAccountRegistration(
        '__active_session__',
        registration.id,
        token,
        platform,
        registration.aliasId,
      );
    }
    return;
  }

  if ((!accounts || accounts.length === 0) && activeEmail) {
    // Active email set but Accounts list empty — register for active session
    await registerForActiveAccount(token, platform);
    return;
  }

  // Register for the active account first (uses session auth)
  if (activeEmail) {
    await registerForActiveAccount(token, platform);
  } else {
    // No active email but accounts exist — register via session auth fallback
    const registration = await registerPushToken(token, platform);
    if (registration?.id) {
      Local.set(TOKEN_STORAGE_KEY, token);
      Local.set(TOKEN_PLATFORM_KEY, platform);
    }
  }

  // Register for all other accounts using their stored credentials
  const otherAccounts = accounts.filter(
    (account) => account.email !== activeEmail && account.aliasAuth,
  );

  if (otherAccounts.length > 0) {
    await Promise.allSettled(
      otherAccounts.map(async (account) => {
        try {
          await registerForAccount(account.email, account.aliasAuth, token, platform);
        } catch (err) {
          console.warn(`[push] Registration failed for ${account.email}:`, err);
        }
      }),
    );
  }

  // Clean up registrations for accounts that are no longer signed in
  pruneStaleRegistrations(accounts);

  notifyPushStatusChanged();
}

/**
 * Remove stored registrations for accounts that are no longer in the accounts list.
 */
function pruneStaleRegistrations(currentAccounts) {
  const registrations = getAccountRegistrations();
  const activeEmails = new Set(currentAccounts.map((a) => a.email));
  let changed = false;

  for (const email of Object.keys(registrations)) {
    if (!activeEmails.has(email)) {
      delete registrations[email];
      changed = true;
    }
  }

  if (changed) setAccountRegistrations(registrations);
}

// ── Token Acquisition & Registration ──────────────────────────────────────

async function registerNativeToken(getToken, platform) {
  const token = await withTimeout(getToken(), NATIVE_PUSH_TIMEOUT_MS, 'getToken');
  if (!isValidNativeToken(token)) {
    console.warn('[push] Native push provider returned an invalid token');
    return false;
  }

  // Register for ALL accounts, not just the active one
  await reconcileAllAccounts(token, platform);

  // Consider registration successful if the token was stored (at least one account registered)
  return Local.get(TOKEN_STORAGE_KEY) === token;
}

async function handleTokenRefresh(token, platform) {
  if (!isValidNativeToken(token)) {
    console.warn(`[push] Ignoring invalid refreshed ${platform} token`);
    return;
  }

  // Token changed — update ALL accounts
  await reconcileAllAccounts(token, platform);
  console.info(`[push] Refreshed ${platform} token for all accounts`);
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
    await handleTokenRefresh(token, 'ios');
  });
  // displayedBySystem=true: APNs alert field causes iOS to auto-display
  // the notification, so the client must not show a duplicate.
  const receivedListener = await onNotificationReceived((notification) => {
    dispatchPushPayload(notification, false, true);
  });
  const tappedListener = await onNotificationTapped((notification) => {
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
    await handleTokenRefresh(token, 'android');
  });
  // displayedBySystem=true: FCM notification field causes Android to
  // auto-display the notification, so the client must not show a duplicate.
  const receivedListener = await onNotificationReceived((notification) => {
    dispatchPushPayload(notification, false, true);
  });
  const tappedListener = await onNotificationTapped((notification) => {
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

  await reconcileAllAccounts(serialized, 'unified-push');
  return true;
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
      // UnifiedPush distributor revoked — clear all registrations
      const registrations = getAccountRegistrations();
      for (const email of Object.keys(registrations)) {
        removeAccountRegistration(email);
      }

      Local.remove(TOKEN_STORAGE_KEY);
      Local.remove(TOKEN_PLATFORM_KEY);
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
    if (isTimeout) throw error;
  }

  return false;
}

/**
 * Initialize remote push for all signed-in accounts.
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
 * Registers push for ALL signed-in accounts, not just the active one.
 */
export async function syncPushNotifications() {
  if (!isTauriMobile || isDemoMode() || !Local.get('alias_auth')) return false;
  return initPushNotifications();
}

/**
 * Remove push registration for a SINGLE account (used during sign-out).
 * Does NOT tear down native listeners or affect other accounts.
 *
 * @param {string} email - The account email to deregister
 * @param {string} [aliasAuth] - Account credentials for server-side DELETE
 */
export async function deregisterAccountPush(email, aliasAuth) {
  if (!email) return true;

  const reg = getAccountRegistration(email);
  if (!reg || !reg.regId) {
    removeAccountRegistration(email);
    return true;
  }

  let removed = false;
  try {
    if (aliasAuth) {
      removed = await unregisterPushTokenForAccount(reg.regId, aliasAuth);
    } else {
      // Fall back to active session auth (works if this IS the active account)
      removed = await unregisterPushToken(reg.regId);
    }
  } catch {
    // Best effort
  }

  removeAccountRegistration(email);
  notifyPushStatusChanged();
  return removed;
}

/**
 * Full cleanup: remove ALL registrations and native listeners.
 * Used only when the LAST account signs out (full app reset).
 */
export async function cleanupPushNotifications() {
  const pendingInitialization = initializationPromise;
  if (pendingInitialization) await pendingInitialization.catch(() => {});

  await removeNativeListeners();
  await removeUnifiedPushListeners();

  // Unregister all per-account registrations
  const registrations = getAccountRegistrations();
  const accounts = Accounts.getAll();
  const accountMap = new Map(accounts.map((a) => [a.email, a]));

  await Promise.allSettled(
    Object.entries(registrations).map(async ([email, reg]) => {
      if (!reg.regId) return;
      try {
        const account = accountMap.get(email);
        if (account?.aliasAuth) {
          await unregisterPushTokenForAccount(reg.regId, account.aliasAuth);
        } else {
          await unregisterPushToken(reg.regId);
        }
      } catch {
        // Best effort
      }
    }),
  );

  if (activeNativeProvider === 'unified-push') {
    try {
      await unregisterUnifiedPush();
    } catch (error) {
      console.warn('[push] UnifiedPush distributor cleanup failed:', error);
    }
  }

  // Clear all push storage
  Local.remove(REGISTRATIONS_KEY);
  Local.remove(TOKEN_STORAGE_KEY);
  Local.remove(TOKEN_PLATFORM_KEY);
  initialized = false;
  activeNativeProvider = null;
  notifyPushStatusChanged();
}

// ── Status & Health ───────────────────────────────────────────────────────

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
    registeredAccounts: [],
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
  const localRegistrationId = getActiveRegistrationId();
  const localProvider = normalizePushProvider(Local.get(TOKEN_PLATFORM_KEY)) || status.provider;
  status.localTokenPresent = typeof localToken === 'string' && Boolean(localToken);
  status.localTokenFingerprint = status.localTokenPresent
    ? await getTokenFingerprint(localProvider, localToken)
    : null;
  status.permission = await getNotificationPermissionStatus();

  // Show which accounts have active registrations
  const registrations = getAccountRegistrations();
  status.registeredAccounts = Object.keys(registrations).filter(
    (email) => registrations[email]?.regId,
  );

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
  const sanitized = (
    await Promise.all(
      serverRecords.map((record) =>
        sanitizePushRegistration(record, localRegistrationId, localProvider, localToken),
      ),
    )
  ).filter(Boolean);
  status.currentRegistration =
    sanitized.find((registration) => registration.isCurrentDevice) || null;
  status.otherRegistrations = sanitized.filter(
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

// ── Management Actions ────────────────────────────────────────────────────

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
  const activeEmail = Local.get('email');
  const localRegistrationId = getActiveRegistrationId();
  let removed = false;

  // Remove the active account's registration
  if (activeEmail) {
    removed = await deregisterAccountPush(activeEmail);
  } else if (localRegistrationId) {
    removed = await unregisterPushToken(localRegistrationId);
  }

  const matchedRegistrationId = initialStatus.currentRegistration?.id;
  if (matchedRegistrationId && matchedRegistrationId !== localRegistrationId) {
    removed = (await unregisterPushToken(matchedRegistrationId)) && removed;
  }

  // Clear local token state so status reports 'not-registered' instead of 'needs-repair'
  Local.remove(TOKEN_STORAGE_KEY);
  Local.remove(TOKEN_PLATFORM_KEY);
  initialized = false;
  notifyPushStatusChanged();

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
      id === getActiveRegistrationId() || id === initialStatus.currentRegistration?.id;
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

// ── Public Getters ────────────────────────────────────────────────────────

export function getStoredPushToken() {
  return Local.get(TOKEN_STORAGE_KEY) || null;
}

export function getPushPlatform() {
  return Local.get(TOKEN_PLATFORM_KEY) || getMobilePlatform();
}

export function isPushInitialized() {
  return initialized;
}

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
      const itemId = firstNonEmpty(payload.id, payload.uid, data.id, data.uid, data.item_id);
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
