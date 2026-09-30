/**
 * Web Push for the browser build (mail.forwardemail.net and installed PWAs).
 *
 * The browser's push service (FCM for Chromium browsers, Mozilla autopush,
 * Apple Web Push for Safari) delivers RFC 8291 encrypted messages that the
 * service worker (public/sw-sync.js) shows as notifications, including when
 * no tab is open. Subscriptions use the same VAPID key pair as UnifiedPush;
 * the server registers them with platform "web-push".
 *
 * Desktop and mobile apps do not use this: their WebViews either lack the
 * Push API or cannot receive pushes, and they have APNs/FCM/UnifiedPush.
 */

import { isTauri } from './platform.js';
import { getUnifiedPushVapidPublicKey } from './unified-push.js';

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

/**
 * Whether this browser can receive Web Push for the app. False inside the
 * Tauri apps, on insecure origins, without a VAPID key in the build, and on
 * iOS/iPadOS Safari outside an installed home-screen app (where the Push API
 * is absent).
 */
export function isWebPushSupported() {
  if (isTauri || typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return Boolean(
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    getUnifiedPushVapidPublicKey(),
  );
}

/** Whether this build carries the VAPID key Web Push needs. */
export function hasWebPushKey() {
  return Boolean(getUnifiedPushVapidPublicKey());
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function getWebPushPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * Ask for notification permission. Call it directly from a click handler:
 * Safari and Firefox ignore a prompt that is not tied to a user gesture.
 */
export async function requestWebPushPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    // Older Safari only supports the callback form.
    return new Promise((resolve) => {
      Notification.requestPermission(resolve);
    });
  }
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A subscription made with another key (a rotated VAPID pair) must be
// replaced. Browsers that do not expose the key keep their subscription.
function madeWithOtherKey(subscription, expected) {
  const key = subscription?.options?.applicationServerKey;
  if (!key) return false;
  return bytesToBase64Url(key) !== bytesToBase64Url(expected);
}

// Without waiting for activation: resolves at once (undefined) when no worker
// is registered, so sign-out and startup never wait on one.
async function getExistingRegistration() {
  try {
    return (await navigator.serviceWorker.getRegistration()) || null;
  } catch {
    return null;
  }
}

async function getServiceWorkerRegistration() {
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((resolve) => setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS)),
  ]);
  if (!registration?.pushManager) {
    throw new Error('The service worker is not active yet. Reload the page and try again.');
  }
  return registration;
}

/**
 * Serialize a PushSubscription the way the server stores it:
 * {"endpoint": "...", "keys": {"p256dh": "...", "auth": "..."}}
 */
export function serializeWebPushSubscription(subscription) {
  const json = typeof subscription?.toJSON === 'function' ? subscription.toJSON() : subscription;
  const endpoint = json?.endpoint;
  const p256dh = json?.keys?.p256dh;
  const auth = json?.keys?.auth;
  if (
    typeof endpoint !== 'string' ||
    !endpoint.startsWith('https://') ||
    typeof p256dh !== 'string' ||
    typeof auth !== 'string'
  ) {
    return null;
  }
  const clean = (value) => value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return JSON.stringify({ endpoint, keys: { p256dh: clean(p256dh), auth: clean(auth) } });
}

/**
 * Subscribe this browser (or reuse its subscription) and return it serialized.
 * Permission must already be granted. A subscription made with another
 * application server key (a rotated VAPID pair) is replaced.
 */
export async function subscribeWebPush() {
  const vapidPublicKey = getUnifiedPushVapidPublicKey();
  if (!vapidPublicKey) throw new Error('This build has no Web Push key.');
  const applicationServerKey = base64UrlToBytes(vapidPublicKey);

  const registration = await getServiceWorkerRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && madeWithOtherKey(subscription, applicationServerKey)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  const serialized = serializeWebPushSubscription(subscription);
  if (!serialized) throw new Error('The browser returned an incomplete push subscription.');
  return serialized;
}

/** The current subscription serialized, or null. Never prompts. */
export async function getWebPushSubscription() {
  try {
    const registration = await getExistingRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    return subscription ? serializeWebPushSubscription(subscription) : null;
  } catch {
    return null;
  }
}

/** Unsubscribe this browser. Resolves true when nothing is left subscribed. */
export async function unsubscribeWebPush() {
  try {
    const registration = await getExistingRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    return subscription ? await subscription.unsubscribe() : true;
  } catch {
    return false;
  }
}

/**
 * Tell the service worker which account each alias ID belongs to, so a push
 * (which names only the alias) opens the right mailbox when clicked.
 *
 * @param {Record<string, string>} accountsByAliasId
 */
export async function shareAccountsWithServiceWorker(accountsByAliasId) {
  try {
    const registration = await getExistingRegistration();
    registration?.active?.postMessage({ type: 'push-accounts', accounts: accountsByAliasId });
  } catch {
    // The worker falls back to opening the mailbox without an account.
  }
}
