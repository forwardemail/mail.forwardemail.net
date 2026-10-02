/**
 * Forward Email – App store distribution rules
 *
 * Builds sold through the App Store and Google Play may not send people to
 * purchases or account sign-up outside the store:
 *   - App Review Guidelines 3.1.3(f) lets an email service's free companion
 *     app skip in-app purchase only while the app has no purchase calls to
 *     action, and 3.1.1(a) bars links to outside purchases on every
 *     storefront except the US.
 *   - Google Play's Payments policy bars in-app links to other payment
 *     methods, sign-up flows included.
 * The Google-free Android build (F-Droid repository, Obtainium), the desktop
 * apps and the web app keep the links. The Android APK published next to the
 * Play bundle is built the same way (with Firebase), so it follows the Play
 * rules too. A Mac App Store build would need the same treatment; macOS
 * builds keep the links today.
 */
import { isTauri, nativePlatform } from './platform.js';

const ANDROID_PUSH_PROVIDER = String(
  import.meta.env.VITE_ANDROID_PUSH_PROVIDER || 'auto',
).toLowerCase();

/**
 * True for builds distributed through the App Store or Google Play.
 *
 * Every iOS build goes through the App Store. On Android, scripts/android-build.sh
 * builds the Play release with Firebase Cloud Messaging (provider `fcm` or
 * `auto`) and the Google-free release with UnifiedPush alone (`unified-push`).
 *
 * @param {object} [env] - overrides for tests
 * @param {boolean} [env.tauri]
 * @param {string|null} [env.platform] - 'ios' | 'android' | 'macos' | ...
 * @param {string} [env.androidPushProvider]
 * @returns {boolean}
 */
export function isAppStoreBuild(env = {}) {
  const tauri = 'tauri' in env ? env.tauri : isTauri;
  if (!tauri) return false;
  const platform = 'platform' in env ? env.platform : nativePlatform;
  if (platform === 'ios') return true;
  if (platform === 'android') {
    const provider = 'androidPushProvider' in env ? env.androidPushProvider : ANDROID_PUSH_PROVIDER;
    return provider !== 'unified-push';
  }
  return false;
}

/**
 * Whether this build hides billing, storage upgrade and sign-up links.
 * Checked when a screen or message needs it, not when the module loads.
 *
 * @returns {boolean}
 */
export function shouldHidePurchaseLinks() {
  return isAppStoreBuild();
}
