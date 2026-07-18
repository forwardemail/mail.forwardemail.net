import { config } from '../config.js';
import { isTauriMobile } from './platform.js';

const PLUGIN_NAME = 'unified-push';
const INSTANCE = 'forward-email';
const DISTRIBUTOR_MESSAGE = 'Forward Email';
const P256_PUBLIC_KEY_PATTERN = /^B[A-Za-z0-9_-]{86}$/;
const AUTH_SECRET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

let listenerCleanups = [];
let tauriCorePromise = null;

// Loaded lazily so this module can sit in the web entry graph. A top-level
// import of @tauri-apps/api/core is external in web builds and crashes the
// page with an unresolvable bare module specifier.
function getTauriCore() {
  tauriCorePromise ||= import('@tauri-apps/api/core');
  return tauriCorePromise;
}

export function isUnifiedPushSupported() {
  return (
    isTauriMobile &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.toLowerCase().includes('android')
  );
}

export function getUnifiedPushVapidPublicKey() {
  const publicKey = config.unifiedPushVapidPublicKey.trim().replace(/=+$/g, '');
  return P256_PUBLIC_KEY_PATTERN.test(publicKey) ? publicKey : '';
}

export function serializeUnifiedPushSubscription(subscription) {
  if (
    !subscription ||
    typeof subscription.endpoint !== 'string' ||
    !subscription.endpoint.startsWith('https://') ||
    typeof subscription.p256dh !== 'string' ||
    !P256_PUBLIC_KEY_PATTERN.test(subscription.p256dh) ||
    typeof subscription.auth !== 'string' ||
    !AUTH_SECRET_PATTERN.test(subscription.auth)
  ) {
    return null;
  }

  return JSON.stringify({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  });
}

async function invokeUnifiedPush(command, args = {}) {
  const { invoke } = await getTauriCore();
  return invoke(`plugin:${PLUGIN_NAME}|${command}`, args);
}

export async function getUnifiedPushState() {
  if (!isUnifiedPushSupported()) return null;
  return invokeUnifiedPush('get_state');
}

export async function registerUnifiedPush() {
  const vapidPublicKey = getUnifiedPushVapidPublicKey();
  if (!vapidPublicKey) throw new Error('unifiedpush_vapid_public_key_required');

  await invokeUnifiedPush('register', {
    instance: INSTANCE,
    messageForDistributor: DISTRIBUTOR_MESSAGE,
    vapidPublicKey,
  });
}

/**
 * Open the system UnifiedPush distributor picker.
 * This must only be called from an explicit user action.
 */
export async function pickUnifiedPushDistributor() {
  const vapidPublicKey = getUnifiedPushVapidPublicKey();
  if (!vapidPublicKey) throw new Error('unifiedpush_vapid_public_key_required');

  await invokeUnifiedPush('pick_distributor', {
    instance: INSTANCE,
    messageForDistributor: DISTRIBUTOR_MESSAGE,
    vapidPublicKey,
  });
}

export async function drainUnifiedPushMessages() {
  if (!isUnifiedPushSupported()) return [];
  const result = await invokeUnifiedPush('drain_messages');
  return Array.isArray(result?.messages) ? result.messages : [];
}

export async function unregisterUnifiedPush() {
  if (!isUnifiedPushSupported()) return;
  await invokeUnifiedPush('unregister', { instance: INSTANCE });
}

export async function removeUnifiedPushListeners() {
  const listeners = listenerCleanups;
  listenerCleanups = [];
  await Promise.allSettled(listeners.map((listener) => listener.unregister()));
}

export async function listenForUnifiedPush({
  onSubscription,
  onMessage,
  onRegistrationFailed,
  onUnregistered,
  onTemporaryUnavailable,
} = {}) {
  if (!isUnifiedPushSupported()) return false;
  await removeUnifiedPushListeners();

  const { addPluginListener } = await getTauriCore();
  const registrations = await Promise.all([
    addPluginListener(PLUGIN_NAME, 'subscription-changed', (event) => {
      if (event?.instance === INSTANCE) onSubscription?.(event.subscription);
    }),
    addPluginListener(PLUGIN_NAME, 'message-received', (event) => {
      if (event?.instance === INSTANCE) onMessage?.(event);
    }),
    addPluginListener(PLUGIN_NAME, 'registration-failed', (event) => {
      if (event?.instance === INSTANCE) onRegistrationFailed?.(event.reason);
    }),
    addPluginListener(PLUGIN_NAME, 'unregistered', (event) => {
      if (event?.instance === INSTANCE) onUnregistered?.();
    }),
    addPluginListener(PLUGIN_NAME, 'temporary-unavailable', (event) => {
      if (event?.instance === INSTANCE) onTemporaryUnavailable?.();
    }),
  ]);

  listenerCleanups = registrations;
  return true;
}
