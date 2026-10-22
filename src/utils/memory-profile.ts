/**
 * True on a phone or tablet, where the web content process (and on iOS every
 * worker with it) runs under a memory limit that ends the page when crossed:
 * the app goes blank and reloads. The OS plugin's platform is read when the
 * Tauri app has it; iPadOS reports a desktop Safari user agent, so a Mac
 * with a touch screen counts too. Main thread only: workers are told by
 * their init message.
 *
 * Kept apart from platform.js, which tests replace wholesale.
 */
const nativePlatform: unknown =
  typeof window !== 'undefined'
    ? (window as { __TAURI_OS_PLUGIN_INTERNALS__?: { platform?: unknown } })
        .__TAURI_OS_PLUGIN_INTERNALS__?.platform
    : undefined;
const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0;

export const isMemoryConstrained: boolean =
  nativePlatform === 'ios' ||
  nativePlatform === 'android' ||
  /android|iphone|ipad|ipod/i.test(userAgent) ||
  (/macintosh/i.test(userAgent) && touchPoints > 1);
