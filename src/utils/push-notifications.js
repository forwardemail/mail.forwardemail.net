/**
 * Forward Email – Native Push Notification Manager
 *
 * Uses direct APNs device tokens through tauri-plugin-mobile-push on iOS and
 * macOS, and either FCM or Google-free UnifiedPush subscriptions on Android.
 * macOS registers only when the build is signed for APNs (the plugin answers
 * "unsupported" otherwise). Windows and Linux do not use remote push; like
 * macOS while the app is running, they receive real-time events over
 * WebSocket and display local system notifications through
 * notification-manager.js.
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
import { isTauri, isTauriMacOS, isTauriMobile } from './platform.js';
import { Local, Accounts } from './storage';
import {
  getLastTokenRegistrationError,
  listPushTokens,
  registerPushToken,
  registerPushTokenForAccount,
  unregisterPushToken,
  unregisterPushTokenForAccount,
} from './background-service.js';
import {
  getPermissionState as getBrowserPermissionState,
  requestPermission as requestNotificationPermission,
} from './notification-bridge.js';
import { openNotificationTarget, pushDataToTarget } from './notification-open.ts';
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
import {
  getWebPushPermission,
  getWebPushSubscription,
  isWebPushSupported,
  requestWebPushPermission,
  shareAccountsWithServiceWorker,
  subscribeWebPush,
  unsubscribeWebPush,
} from './web-push.js';

// Platforms whose native layer can register for remote push. The macOS
// plugin still answers "unsupported" when the build is not signed for APNs.
const isNativePushPlatform = isTauriMobile || isTauriMacOS;

// The browser build registers a Web Push subscription instead (web-push.js).
// Evaluated lazily: the service worker and Notification API are only known
// once the page runs.
function isWebPushPlatform() {
  return !isNativePushPlatform && isWebPushSupported();
}

// Timeout for native push bridge calls such as token retrieval and listener
// setup. If one hangs (common on Android when Google Play Services is
// unavailable), the UI should recover gracefully instead of freezing.
const NATIVE_PUSH_TIMEOUT_MS = 15_000;

// Permission prompts show a system dialog and wait on a human decision, so
// they get a much longer budget. This only guards against a hung bridge call,
// not against a user taking their time with the dialog. The iOS and macOS
// native sides give up at 110 seconds, so their answer always arrives first.
const PERMISSION_PROMPT_TIMEOUT_MS = 120_000;

// APNs token retrieval (iOS and macOS). iOS waits up to 25 seconds for the
// APNs callback. macOS waits up to 40 (after 15 it registers again once) and
// then spends up to 4 more on the main thread explaining a failure
// (macos.rs). This budget is longer than all of it so the native reason
// reaches the UI instead of a bare JS timeout racing it.
const APNS_TOKEN_TIMEOUT_MS = 60_000;

class PushTimeoutError extends Error {
  constructor(operation, ms) {
    super(`${operation} timed out after ${ms}ms`);
    this.name = 'PushTimeoutError';
  }
}

/**
 * A registration step failed for a reason worth showing the user: the
 * permission was refused, APNs rejected the app, the server declined the
 * token. `code` is a PushManagementCode, `detail` is human-readable.
 */
class PushRegistrationError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.name = 'PushRegistrationError';
    this.code = code;
    this.detail = detail || '';
  }
}

// Why the most recent native registration attempt failed. Cleared at the
// start of every attempt; read by the Settings management actions so they can
// say more than "did not complete".
let lastRegistrationFailure = null;

function recordRegistrationFailure(code, detail) {
  lastRegistrationFailure = { code, detail: typeof detail === 'string' ? detail : '' };
}

function describeError(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  try {
    return String(error);
  } catch {
    return '';
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

/**
 * The native platform push registers from: 'android' | 'ios' | 'macos', or null.
 * macOS comes only from the Tauri OS plugin: iPadOS also reports a Macintosh
 * user agent, so the user-agent fallback never answers 'macos'.
 */
function getNativePushPlatform() {
  const nativePlatform = globalThis.window?.__TAURI_OS_PLUGIN_INTERNALS__?.platform;
  if (nativePlatform === 'android' || nativePlatform === 'ios' || nativePlatform === 'macos') {
    return nativePlatform;
  }

  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('android')) return 'android';
  if (/iphone|ipad|ipod/.test(userAgent)) return 'ios';
  return null;
}

function isValidNativeToken(token) {
  return typeof token === 'string' && token.length >= 16 && token.length <= 4096;
}

function normalizePushProvider(platform) {
  if (platform === 'ios' || platform === 'macos' || platform === 'apns') return 'apns';
  if (platform === 'android' || platform === 'fcm') return 'fcm';
  if (platform === 'unified-push') return 'unified-push';
  if (platform === 'web' || platform === 'web-push') return 'web-push';
  return null;
}

function getPushProviderLabel(provider) {
  if (provider === 'apns') return 'Apple Push Notification Service';
  if (provider === 'fcm') return 'Firebase Cloud Messaging';
  if (provider === 'unified-push') return 'UnifiedPush';
  if (provider === 'web-push') return 'Web Push (this browser)';
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

/**
 * Tell Settings to read the status again after a change made outside this
 * module: the browser notification permission, granted from the New mail
 * notifications row or the Turn on toast.
 */
export function refreshPushStatus() {
  notifyPushStatusChanged();
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
  if (isWebPushPlatform()) return 'web-push';
  const storedProvider = normalizePushProvider(Local.get(TOKEN_PLATFORM_KEY));
  if (storedProvider) return storedProvider;
  if (activeNativeProvider) return activeNativeProvider;

  const platform = getNativePushPlatform();
  if (platform === 'ios' || platform === 'macos') return 'apns';
  if (platform !== 'android') return null;
  if (ANDROID_PROVIDER === 'fcm' || ANDROID_PROVIDER === 'unified-push') return ANDROID_PROVIDER;
  return getAndroidPushProviderPreference();
}

/**
 * macOS notification authorization, read without prompting. The plugin
 * answers "unsupported" when the build is not signed for APNs.
 * tauri-plugin-notification cannot be asked here: on desktop it always
 * reports granted.
 */
async function getMacOSPermissionState() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await withTimeout(
      invoke('plugin:mobile-push|permission_state'),
      NATIVE_PUSH_TIMEOUT_MS,
      'macOS permission_state',
    );
    return typeof result?.state === 'string' ? result.state : 'unknown';
  } catch {
    // An older native build without the command cannot register either.
    return 'unsupported';
  }
}

async function getNotificationPermissionStatus() {
  if (isWebPushPlatform()) {
    const permission = getWebPushPermission();
    if (permission === 'granted') return 'granted';
    if (permission === 'unsupported') return 'unsupported';
    return 'not-granted';
  }

  if (isTauriMacOS) {
    const state = await getMacOSPermissionState();
    if (state === 'granted') return 'granted';
    if (state === 'denied' || state === 'prompt') return 'not-granted';
    if (state === 'unsupported') return 'unsupported';
    return 'unknown';
  }

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

  // A tap opens what the notification is about, in its own account. Before,
  // the tap only fed the data pipeline above and nothing navigated, so every
  // tapped push landed wherever the app happened to be (usually the inbox).
  if (tapped) {
    const target = pushDataToTarget(data, account);
    if (target) openNotificationTarget(target);
  }
}

// ── Notification taps ─────────────────────────────────────────────────────
//
// A tap can arrive before any of the registration code below has run: it is
// what launches the app on a cold start, and registration waits for boot, the
// permission prompt and the token (seconds, or never when the user is signed
// out or the app is locked). So taps are handled from boot, independently of
// registration. The native side keeps every tap in a queue until the page
// takes it (take_pending_taps) and fires an event as a wake-up; the page
// always drains the queue rather than trusting the event, so a tap is handled
// once whether the page was listening at the time or not.

const MAX_TAPS_PER_DRAIN = 10;
let tapHandlingInstalled = false;
let tapDrainInFlight = null;
let iosTapListener = null;

function handleTappedPayloads(list) {
  const taps = Array.isArray(list) ? list.slice(-MAX_TAPS_PER_DRAIN) : [];
  // The window gains focus because of this tap; notification-bridge's focus
  // fallback must not also open the app's own last notification.
  if (taps.length) window.dispatchEvent(new CustomEvent('fe:push-tap'));
  for (const tap of taps) {
    const data = tap && typeof tap === 'object' && tap.data ? tap.data : tap;
    if (data && typeof data === 'object') dispatchPushPayload({ data }, true, true);
  }
}

async function takePendingTaps(plugin) {
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke(`plugin:${plugin}|take_pending_taps`);
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.taps) ? result.taps : [];
}

function drainTaps(plugin, fallback = null) {
  if (tapDrainInFlight) {
    // Drain again once the current one finishes: the event that got us here
    // may be for a tap the running drain did not see.
    tapDrainInFlight = tapDrainInFlight.then(() => drainTaps(plugin, fallback));
    return tapDrainInFlight;
  }
  tapDrainInFlight = takePendingTaps(plugin)
    .then(handleTappedPayloads)
    .catch((error) => {
      // A native build from before take_pending_taps: use what the event
      // carried, which is all an older build offers.
      if (fallback) handleTappedPayloads([fallback]);
      else console.warn('[push] Could not read pending notification taps:', error);
    })
    .finally(() => {
      tapDrainInFlight = null;
    });
  return tapDrainInFlight;
}

/**
 * Start handling notification taps. Called once at boot on iOS, Android and
 * macOS, before and regardless of push registration.
 */
export async function initPushTapHandling() {
  if (!isNativePushPlatform || tapHandlingInstalled) return;
  const platform = getNativePushPlatform();
  if (platform !== 'ios' && platform !== 'android' && platform !== 'macos') return;
  tapHandlingInstalled = true;

  if (platform === 'ios' || platform === 'macos') {
    // MobilePushPlugin.swift (iOS) and macos.rs dispatch DOM events (see
    // initializeApnsPush). On a macOS build that is not signed for APNs the
    // queue is simply always empty.
    iosTapListener = (event) => {
      void drainTaps('mobile-push', event?.detail || null);
    };
    window.addEventListener('mobile-push:notification-tapped', iosTapListener);
    await drainTaps('mobile-push');
    return;
  }

  // Android: FCM tray notifications and UnifiedPush notifications both open
  // the app with the payload on the launch intent; the unified-push plugin
  // (present in every Android build) collects it.
  try {
    const { addPluginListener } = await import('@tauri-apps/api/core');
    await addPluginListener('unified-push', 'notification-tapped', () => {
      void drainTaps('unified-push');
    });
  } catch (error) {
    console.warn('[push] Could not listen for notification taps:', error);
  }
  await drainTaps('unified-push');
}

/** Test helper: undo initPushTapHandling. */
export function __resetPushTapHandlingForTests() {
  if (iosTapListener) window.removeEventListener('mobile-push:notification-tapped', iosTapListener);
  iosTapListener = null;
  tapHandlingInstalled = false;
  tapDrainInFlight = null;
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
  // A record marked by a sign-in is registered again too (see
  // refreshAccountPushOnNextSync).
  if (
    existing &&
    existing.regId &&
    existing.token === token &&
    existing.platform === platform &&
    existing.aliasId &&
    !existing.reregister
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
  // registerForAccount for why that POST is safe to repeat — and so is a
  // record marked by a sign-in (refreshAccountPushOnNextSync).
  if (
    existing &&
    existing.regId &&
    existing.token === token &&
    existing.platform === platform &&
    existing.aliasId &&
    !existing.reregister
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
      // Deleting only the local record orphans a live server row, which then
      // keeps receiving (duplicate) pushes for this device. Attempt the
      // server-side delete too. It is best-effort: the account's aliasAuth is
      // already gone, so this only succeeds when the current session is
      // allowed to manage that row. The reliable cleanup path remains
      // deregisterAccountPush at sign-out time.
      const regId = registrations[email]?.regId;
      if (regId) {
        unregisterPushToken(regId).catch(() => {});
      }

      delete registrations[email];
      changed = true;
    }
  }

  if (changed) setAccountRegistrations(registrations);
}

// ── Token Acquisition & Registration ──────────────────────────────────────

async function registerNativeToken(getToken, platform, timeoutMs = NATIVE_PUSH_TIMEOUT_MS) {
  let token;
  try {
    token = await withTimeout(getToken(), timeoutMs, 'getToken');
  } catch (error) {
    if (error instanceof PushTimeoutError) throw error;
    // Tauri rejects with the native reason as a plain string, for example
    // "APNs registration failed: no valid aps-environment entitlement string
    // found for application".
    throw new PushRegistrationError('token-unavailable', describeError(error));
  }

  if (!isValidNativeToken(token)) {
    console.warn('[push] Native push provider returned an invalid token');
    recordRegistrationFailure('token-unavailable', 'The device returned an invalid push token.');
    return false;
  }

  // Register for ALL accounts, not just the active one
  await reconcileAllAccounts(token, platform);

  // Consider registration successful if the token was stored (at least one account registered)
  if (Local.get(TOKEN_STORAGE_KEY) === token) return true;

  let serverError = null;
  try {
    serverError = getLastTokenRegistrationError();
  } catch {
    // Diagnostics only; fall back to the generic message.
  }
  let detail =
    'Forward Email did not accept this device token. Check the connection and try again.';
  if (serverError?.status) {
    detail = `Forward Email rejected the device token (HTTP ${serverError.status}${
      serverError.message ? `: ${serverError.message}` : ''
    }).`;
  } else if (serverError?.message) {
    detail = `Could not reach Forward Email to register this device (${serverError.message}).`;
  }
  recordRegistrationFailure('server-rejected', detail);
  return false;
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

/**
 * Register for APNs through tauri-plugin-mobile-push (iOS and macOS).
 *
 * The two platforms share the plugin's command and DOM-event contract. They
 * differ in what the token is stored as (iOS registrations keep the legacy
 * 'ios' platform key, which background-service maps to 'apns') and in who
 * draws an alert: on iOS the system always does; on macOS the native side
 * reports it per push in `displayedBySystem`, because while the user is in
 * the app the page shows its own notice instead.
 *
 * Taps are handled separately, from boot (initPushTapHandling).
 *
 * @param {'ios' | 'macos'} platform
 */
// APNs can answer after getToken has given up. The native side keeps that
// token (and answers the next getToken with it at once) and announces it with
// a mobile-push:token-received event. Until registration succeeds, that event
// finishes the registration instead of waiting for the user to try again.
let lateApnsTokenListener = null;

function watchForLateApnsToken(platform) {
  if (lateApnsTokenListener || typeof window === 'undefined') return;
  const onToken = (event) => {
    const token = event?.detail?.token;
    if (!token) return;
    // A registration is still running: look again once it has settled, or
    // this token would be dropped (the native side does not announce it
    // twice).
    if (initializationPromise) {
      const retry = () => setTimeout(() => onToken(event), 0);
      initializationPromise.then(retry, retry);
      return;
    }
    if (initialized) {
      // Registration finished with a different token than this later one.
      if (Local.get(TOKEN_STORAGE_KEY) !== token) {
        handleTokenRefresh(token, platform)
          .catch((error) => console.warn('[push] Late APNs token registration failed:', error))
          .finally(() => notifyPushStatusChanged());
      }
      return;
    }
    stopWatchingForLateApnsToken();
    console.info('[push] APNs answered after registration gave up; registering now');
    syncPushNotifications()
      .catch((error) => {
        console.warn('[push] Registration with the late APNs token failed:', error);
      })
      .finally(() => notifyPushStatusChanged());
  };
  lateApnsTokenListener = onToken;
  window.addEventListener('mobile-push:token-received', lateApnsTokenListener);
}

function stopWatchingForLateApnsToken() {
  if (!lateApnsTokenListener) return;
  window.removeEventListener('mobile-push:token-received', lateApnsTokenListener);
  lateApnsTokenListener = null;
}

async function initializeApnsPush(platform) {
  const isMac = platform === 'macos';
  const label = isMac ? 'macOS' : 'iOS';
  const registrationPlatform = isMac ? 'apns' : 'ios';
  const { getToken, requestPermission } = await import('tauri-plugin-mobile-push-api');

  const permission = await withTimeout(
    requestPermission(),
    PERMISSION_PROMPT_TIMEOUT_MS,
    `${label} requestPermission`,
  );
  if (!permission?.granted) {
    // `status` comes from MobilePushPlugin.swift (iOS) or macos.rs (macOS).
    // "previously-denied" is the case where the OS will never show the prompt
    // again, which used to look like a prompt that silently failed to appear.
    const status = typeof permission?.status === 'string' ? permission.status : 'denied';
    console.info(`[push] ${label} notification permission was not granted:`, status);
    if (status === 'unsupported') {
      throw new PushRegistrationError(
        'unsupported',
        isMac
          ? 'This build of Forward Email is not signed for Apple Push Notifications.'
          : 'Apple Push Notifications are not available on this device.',
      );
    }
    if (status === 'previously-denied') {
      throw new PushRegistrationError(
        'permission-blocked',
        isMac
          ? 'Notifications for Forward Email are turned off in System Settings.'
          : 'Notifications for Forward Email are turned off in iOS Settings.',
      );
    }
    if (status === 'denied') {
      throw new PushRegistrationError('permission-denied', 'Notification permission was declined.');
    }
    throw new PushRegistrationError(
      'registration-failed',
      permission?.error || `Notification permission request ended with status "${status}".`,
    );
  }

  // Permission is granted from here on, so a token APNs sends late is one
  // this device can use.
  watchForLateApnsToken(registrationPlatform);
  if (!(await registerNativeToken(getToken, registrationPlatform, APNS_TOKEN_TIMEOUT_MS))) {
    return false;
  }
  stopWatchingForLateApnsToken();

  // The Tauri plugin listener registry does not work for this plugin
  // (register_listener is a Rust no-op, so the Swift registry stays empty and
  // Plugin.trigger() never reaches JS). The native side dispatches DOM events
  // (evaluateJavaScript on iOS, eval on macOS) instead, and those are the only
  // delivery path. addPluginListener is deliberately not called: it only
  // created IPC channels that never fire.
  const handleReceived = (e) => {
    const displayedBySystem = isMac ? e.detail?.displayedBySystem === true : true;
    dispatchPushPayload(e.detail, false, displayedBySystem);
  };
  const handleTokenEvent = (e) => {
    const token = e.detail?.token;
    if (token) {
      handleTokenRefresh(token, registrationPlatform).catch((error) => {
        console.warn(`[push] ${label} token refresh registration failed:`, error);
      });
    }
  };
  window.addEventListener('mobile-push:notification-received', handleReceived);
  window.addEventListener('mobile-push:token-received', handleTokenEvent);

  nativeListenerCleanups = [
    {
      unregister() {
        window.removeEventListener('mobile-push:notification-received', handleReceived);
        window.removeEventListener('mobile-push:token-received', handleTokenEvent);
      },
    },
  ];
  return true;
}

/**
 * Open this app's notification settings (the iOS Settings app, or the
 * Notifications pane of System Settings on macOS), where notifications that
 * were turned off can be re-enabled. Resolves false where that is not
 * possible.
 */
export async function openNotificationSettings() {
  const platform = getNativePushPlatform();
  const supported = (isTauriMobile && platform === 'ios') || (isTauriMacOS && platform === 'macos');
  if (!supported) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return Boolean(await invoke('plugin:mobile-push|open_settings'));
  } catch (error) {
    console.warn('[push] Unable to open notification settings:', error);
    return false;
  }
}

async function initializeAndroidFcmPush() {
  const { getToken, onNotificationReceived, onTokenRefresh, requestPermission } =
    await import('tauri-plugin-remote-push-api');

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
  // The plugin only includes a `notification` object when the FCM message
  // carried one (the field that makes backgrounded Android auto-display it).
  // A data-only message displays nothing on its own, so marking it
  // displayedBySystem would wrongly suppress the client-drawn visual.
  const receivedListener = await onNotificationReceived((notification) => {
    dispatchPushPayload(notification, false, notification?.notification != null);
  });
  // Taps are handled from boot by initPushTapHandling (the tray notification
  // opens the app with the payload on its launch intent).

  nativeListenerCleanups = [tokenRefreshListener, receivedListener];
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

/**
 * Name why pushManager.subscribe() failed. Chromium browsers reject with an
 * AbortError ("Registration failed - push service error") when the browser
 * cannot register with its own push service: Brave with Google push messaging
 * turned off, Chromium builds without Google services, or a network, VPN or
 * blocker that stops the connection. Nothing the server or the key can fix.
 */
function classifyWebPushSubscribeError(error) {
  if (error instanceof PushTimeoutError || error instanceof PushRegistrationError) return error;
  const detail = describeError(error);
  if (error?.name === 'NotAllowedError')
    return new PushRegistrationError('permission-denied', detail);
  if (error?.name === 'AbortError' || /push service/i.test(detail)) {
    return new PushRegistrationError('push-service-unavailable', detail);
  }
  return error;
}

/**
 * Subscribe this browser and register the subscription for every signed-in
 * account. Never prompts: permission is asked for from the Settings click
 * (registerCurrentDevicePush), because browsers ignore a prompt that is not
 * tied to a user gesture.
 */
async function initializeWebPush() {
  if (getWebPushPermission() !== 'granted') {
    throw new PushRegistrationError(
      'permission-denied',
      getWebPushPermission() === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser site settings, then try again.'
        : 'Notification permission has not been granted.',
    );
  }

  let token;
  try {
    token = await withTimeout(subscribeWebPush(), NATIVE_PUSH_TIMEOUT_MS, 'Web Push subscription');
  } catch (error) {
    throw classifyWebPushSubscribeError(error);
  }
  await reconcileAllAccounts(token, 'web-push');
  if (!getActiveRegistrationId()) {
    throw new PushRegistrationError(
      'registration-failed',
      getLastTokenRegistrationError()?.message ||
        'The server did not accept this browser subscription.',
    );
  }
  shareWebPushAccounts();
  return true;
}

// The service worker names the account in a clicked notification from this map.
function shareWebPushAccounts() {
  const map = {};
  for (const [email, reg] of Object.entries(getAccountRegistrations() || {})) {
    if (email !== '__active_session__' && reg?.aliasId && reg.platform === 'web-push') {
      map[reg.aliasId] = email;
    }
  }
  shareAccountsWithServiceWorker(map);
}

async function initializePushNotifications() {
  lastRegistrationFailure = null;

  if (isWebPushPlatform()) {
    try {
      await initializeWebPush();
      initialized = true;
      activeNativeProvider = 'web-push';
      console.info('[push] Initialized Web Push');
      return true;
    } catch (error) {
      console.warn('[push] Web Push initialization failed:', error);
      // From here on the open app shows new mail itself (notification-manager
      // draws the WebSocket copy when Web Push cannot deliver); Settings says so.
      if (error instanceof PushTimeoutError) {
        recordRegistrationFailure('registration-timeout', describeError(error));
        notifyPushStatusChanged();
        throw error;
      }
      if (error instanceof PushRegistrationError) {
        recordRegistrationFailure(error.code, error.detail);
      } else {
        recordRegistrationFailure('registration-failed', describeError(error));
      }
      notifyPushStatusChanged();
      return false;
    }
  }

  await removeNativeListeners();
  await removeUnifiedPushListeners();

  const platform = getNativePushPlatform();
  if (!platform) {
    console.warn('[push] Unable to determine mobile platform');
    recordRegistrationFailure('unsupported', 'Unable to determine the mobile platform.');
    return false;
  }

  // A macOS build without the APNs entitlement (local, test, or a release
  // built without the Developer ID provisioning profile) is a normal state,
  // not a failure worth a warning on every launch.
  if (platform === 'macos' && (await getMacOSPermissionState()) === 'unsupported') {
    recordRegistrationFailure(
      'unsupported',
      'This build of Forward Email is not signed for Apple Push Notifications.',
    );
    return false;
  }

  try {
    const usesApns = platform === 'ios' || platform === 'macos';
    const initializedNative = usesApns
      ? await initializeApnsPush(platform)
      : await initializeAndroidPush();
    if (initializedNative) {
      initialized = true;
      activeNativeProvider = usesApns ? 'apns' : activeNativeProvider;
      console.info(`[push] Initialized native ${activeNativeProvider} push`);
      return true;
    }
  } catch (error) {
    const isTimeout = error instanceof PushTimeoutError;
    console.warn(`[push] Native push initialization ${isTimeout ? 'timed out' : 'failed'}:`, error);
    if (isTimeout) {
      recordRegistrationFailure('registration-timeout', describeError(error));
      throw error;
    }
    if (error instanceof PushRegistrationError) {
      recordRegistrationFailure(error.code, error.detail);
    } else {
      recordRegistrationFailure('registration-failed', describeError(error));
    }
  }

  return false;
}

/**
 * Why the most recent native registration attempt failed, or null.
 * @returns {{ code: string, detail: string } | null}
 */
export function getLastPushRegistrationFailure() {
  return lastRegistrationFailure ? { ...lastRegistrationFailure } : null;
}

/**
 * Initialize remote push for all signed-in accounts.
 * Concurrent lifecycle triggers share one native registration attempt.
 *
 * @returns {Promise<boolean>} true when APNs, FCM, or UnifiedPush registered
 */
export async function initPushNotifications() {
  if (!isNativePushPlatform && !isWebPushPlatform()) return false;
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
 * Synchronize remote push when a real alias-authenticated account is active in
 * the mobile or macOS app.
 * Safe to invoke after login, during bootstrap, and whenever the app resumes.
 * Registers push for ALL signed-in accounts, not just the active one.
 */
export async function syncPushNotifications() {
  if (isDemoMode() || !Local.get('alias_auth')) return false;
  if (isWebPushPlatform()) {
    // A browser only registers once the user has allowed notifications from
    // Settings; at boot it just keeps an existing registration current.
    if (getWebPushPermission() !== 'granted') return false;
  } else if (!isNativePushPlatform) {
    return false;
  }

  if (!(await initPushNotifications())) return false;
  return registerPendingAccounts();
}

function hasPendingRegistrations() {
  return Object.values(getAccountRegistrations() || {}).some((record) => record?.reregister);
}

/**
 * Register the accounts a sign-in marked (refreshAccountPushOnNextSync) with
 * the device token push was set up with, when the setup itself did not get to
 * them: push was already set up, or their registration failed. Nothing is set
 * up again, so no listener is removed and no permission is asked for.
 *
 * @returns {Promise<boolean>} false while an account is still waiting
 */
async function registerPendingAccounts() {
  if (!hasPendingRegistrations()) return true;
  const token = Local.get(TOKEN_STORAGE_KEY);
  const platform = Local.get(TOKEN_PLATFORM_KEY);
  if (token && platform) await reconcileAllAccounts(token, platform);
  return !hasPendingRegistrations();
}

/**
 * The service worker saw the browser rotate the push subscription
 * (pushsubscriptionchange). Register the new one for every account.
 */
export async function handleWebPushSubscriptionChange() {
  if (!isWebPushPlatform()) return false;
  initialized = false;
  return syncPushNotifications();
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
  // the service worker should no longer open this account's notifications
  if (isWebPushPlatform()) shareWebPushAccounts();
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

  stopWatchingForLateApnsToken();
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

  // Only a browser that allowed notifications can hold a subscription; skip
  // the service worker round trip otherwise so sign-out stays instant.
  if (isWebPushPlatform() && getWebPushPermission() === 'granted') {
    await unsubscribeWebPush();
    shareAccountsWithServiceWorker({});
  }

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
  const web = isWebPushPlatform();
  // The browser build reports "web" even when this browser cannot receive
  // push, so Settings can say why (the user-agent guess would say iOS).
  const platform = isTauri ? getNativePushPlatform() : 'web';
  const supported =
    web ||
    (isTauriMobile && (platform === 'ios' || platform === 'android')) ||
    (isTauriMacOS && platform === 'macos');
  const authenticated = Boolean(Local.get('alias_auth'));
  const demo = isDemoMode();
  const provider = supported ? getCurrentPushProvider() : null;

  return {
    supported,
    authenticated,
    demo,
    platform: supported || !isTauri ? platform : null,
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
    browserNotifications: null,
  };
}

/**
 * Whether Web Push delivers new-mail alerts for the active account in this
 * browser. The same test notification-manager.js makes before it leaves a
 * WebSocket alert to the service worker.
 */
async function isWebPushDelivering() {
  if (!isWebPushPlatform() || getActivePushProvider() !== 'web-push') return false;
  return canReceiveWebPush();
}

/**
 * How the browser build tells the user about new mail. Web Push reaches the
 * service worker even with the app closed. When it cannot (no Push API, the
 * push service is unreachable, the registration failed or was removed), the
 * open app shows each new message with the Notifications API itself
 * (notification-manager.js), which needs the same permission.
 *
 *   push              Web Push delivers the alerts.
 *   fallback          push does not; the open app shows them.
 *   needs-permission  nothing can show them until the user allows it.
 *   blocked           the user blocked notifications for this site.
 *   unavailable       no Notifications API here (iOS Safari outside the Home
 *                     Screen, a page served without HTTPS).
 *
 * null in the desktop and mobile apps, which have native notifications, and
 * in demo mode, which shows none.
 */
async function getBrowserNotificationState() {
  if (isTauri || isDemoMode()) return null;

  let permission = 'unsupported';
  try {
    permission = await getBrowserPermissionState();
  } catch {
    // Treated as unavailable.
  }

  let mode = 'needs-permission';
  if (permission === 'unsupported') mode = 'unavailable';
  else if (permission === 'denied') mode = 'blocked';
  else if (permission === 'granted') mode = (await isWebPushDelivering()) ? 'push' : 'fallback';

  return { mode, permission, pushFailure: lastRegistrationFailure?.code || null };
}

/**
 * Return a side-effect-free, privacy-preserving push status snapshot for Settings.
 * This function never requests permission or starts native registration.
 */
export async function getPushNotificationStatus() {
  const status = createBasePushStatus();
  status.browserNotifications = await getBrowserNotificationState();
  if (!status.supported) return status;

  // A macOS build that is not signed for APNs has nothing to manage. Keep the
  // platform so Settings can say why instead of implying an unsupported OS.
  const permission = await getNotificationPermissionStatus();
  if (status.platform === 'macos' && permission === 'unsupported') {
    status.supported = false;
    status.provider = null;
    status.providerLabel = getPushProviderLabel(null);
    status.permission = 'unsupported';
    return status;
  }

  const localToken = Local.get(TOKEN_STORAGE_KEY);
  const localRegistrationId = getActiveRegistrationId();
  const localProvider = normalizePushProvider(Local.get(TOKEN_PLATFORM_KEY)) || status.provider;
  status.localTokenPresent = typeof localToken === 'string' && Boolean(localToken);
  status.localTokenFingerprint = status.localTokenPresent
    ? await getTokenFingerprint(localProvider, localToken)
    : null;
  status.permission = permission;

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

/**
 * Pick the most specific failure: the native attempt's own reason when there
 * is one, otherwise what the status snapshot implies.
 */
function getRegistrationFailure(status) {
  const recorded = getLastPushRegistrationFailure();
  if (recorded && recorded.code !== 'registration-failed') {
    return { code: recorded.code, detail: recorded.detail };
  }
  const code = getRegistrationFailureCode(status);
  return { code, detail: recorded?.detail || '' };
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

/**
 * Ask this browser for notification permission. Call it from a click:
 * browsers ignore a prompt that no user action started. A site the user
 * blocked gets no prompt (only the browser's site settings can change that).
 * Once allowed, try Web Push; if it cannot register, the open app shows new
 * mail with the Notifications API.
 *
 * @returns {Promise<'granted' | 'denied' | 'default' | 'unsupported'>}
 */
export function allowBrowserNotifications() {
  if (isTauri || isDemoMode()) return Promise.resolve('unsupported');
  // Asked before anything is awaited, while the click still counts.
  const request = requestNotificationPermission();
  return request.then(async (permission) => {
    if (permission === 'granted') {
      try {
        await syncPushNotifications();
      } catch (error) {
        console.warn('[push] Web Push registration after allowing notifications failed:', error);
      }
    }
    notifyPushStatusChanged();
    return permission;
  });
}

export function registerCurrentDevicePush() {
  // Browsers only show the permission prompt for a user gesture, so ask
  // before anything else is awaited (this runs inside the Settings click).
  const permissionRequest =
    isWebPushPlatform() && getWebPushPermission() === 'default' ? requestWebPushPermission() : null;
  return runPushManagement(async () => {
    if (permissionRequest) await permissionRequest;
    const initialStatus = await getPushNotificationStatus();
    const guardCode = getManagementGuardCode(initialStatus);
    if (guardCode) return { ok: false, code: guardCode, status: initialStatus };

    try {
      await syncPushNotifications();
    } catch (error) {
      if (error instanceof PushTimeoutError) {
        const status = await getPushNotificationStatus();
        return {
          ok: false,
          code: 'registration-timeout',
          detail: getLastPushRegistrationFailure()?.detail || '',
          status,
        };
      }

      throw error;
    }

    const status = await getPushNotificationStatus();
    const ok = status.health === 'active';
    return ok
      ? { ok, code: 'registered', status }
      : { ok, ...getRegistrationFailure(status), status };
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
  const permissionRequest =
    isWebPushPlatform() && getWebPushPermission() === 'default' ? requestWebPushPermission() : null;
  return runPushManagement(async () => {
    if (permissionRequest) await permissionRequest;
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
        return {
          ok: false,
          code: 'registration-timeout',
          detail: getLastPushRegistrationFailure()?.detail || '',
          status,
        };
      }

      throw error;
    }

    const status = await getPushNotificationStatus();
    const ok = status.health === 'active';
    return ok
      ? { ok, code: 'reregistered', status }
      : { ok, ...getRegistrationFailure(status), status };
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
  return Local.get(TOKEN_PLATFORM_KEY) || getNativePushPlatform();
}

/**
 * Effective push provider ('fcm' | 'apns' | 'unified-push') for the active
 * account's registration, or null when the active account has none. Used by
 * notification-manager to decide whether backgrounded alerts are OS-drawn.
 */
export function getActivePushProvider() {
  const email = Local.get('email') || '';
  if (!email) return null;
  const record = getAccountRegistrations()[email];
  // (a registration waiting to be made again may be gone from the server, so
  // the app draws its own alerts until it is)
  if (!record || !record.regId || record.reregister) return null;
  return normalizePushProvider(record.platform);
}

/**
 * Whether an APNs copy of this realtime event is on its way and macOS may
 * draw it as a system alert. Only newMessage events are sent as alerts, and
 * only accounts registered on this Mac receive them. notification-manager
 * holds the WebSocket copy briefly when this is true, so the push can report
 * whether the system already showed it (see realtime-event-coalescer).
 *
 * @param {string} eventName
 * @param {Object} data - realtime payload, tagged with `_account`
 * @returns {boolean}
 */
export function isSystemPushAlertExpected(eventName, data) {
  if (!isTauriMacOS || !initialized || activeNativeProvider !== 'apns') return false;
  if (eventName !== 'newMessage') return false;
  const account = (typeof data?._account === 'string' && data._account) || Local.get('email') || '';
  if (!account) return false;
  const record = getAccountRegistrations()[account];
  return Boolean(record?.regId) && normalizePushProvider(record.platform) === 'apns';
}

export function isPushInitialized() {
  return initialized;
}

/**
 * Make the next sync register this device again for an account that just
 * signed in, instead of trusting the registration stored from before.
 *
 * The server can have deleted that registration: changing the alias password
 * deletes the alias's push tokens, and so do expiry, repeated delivery
 * failures and the alias moving to another owner. The device would otherwise
 * believe it is registered and get no notifications. POST /v1/push-tokens
 * upserts on (alias, platform, token), so registering again is harmless when
 * the server still has it. Every sync retries until it succeeds (see
 * registerPendingAccounts), and an account added this way that has no
 * registration yet gets one the same way.
 *
 * @param {string} email - The account that signed in
 */
export function refreshAccountPushOnNextSync(email) {
  if (!email || isDemoMode()) return;
  const registrations = getAccountRegistrations();
  registrations[email] = { ...registrations[email], reregister: true };
  setAccountRegistrations(registrations);
}

/**
 * Whether this browser's service worker can receive Web Push. False when the
 * browser reported that it cannot reach its push service, or when it holds
 * no subscription at all; then a stored registration is stale and the live
 * connection has to show new mail. Setup that is still running, or that
 * failed for another reason (the server, a timeout), does not count: the
 * existing subscription keeps delivering, and treating it as broken would
 * show every alert twice.
 */
export async function canReceiveWebPush() {
  if (lastRegistrationFailure?.code === 'push-service-unavailable') return false;
  return Boolean(await getWebPushSubscription());
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
