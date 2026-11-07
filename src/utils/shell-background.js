import { isTauriMobile, nativePlatform } from './platform.js';
import { setShellBackground } from './tauri-bridge.js';

// Up to this width the sign-in screen is the light card edge to edge (base.css).
const PHONE_MAX_WIDTH = 640;

let lastDark;
let pending = Promise.resolve();

/**
 * Colours the native strips around the iOS webview (status bar and home
 * indicator, lib.rs) for the screen they frame: the theme's canvas, except on
 * the sign-in screen wider than a phone, whose ground is dark in both themes.
 * There the light canvas made a light band above and below an iPad's sign-in.
 *
 * @param {{ themeDark: boolean, route: string, width: number }} screen
 */
export function syncShellBackground({ themeDark, route, width }) {
  if (!isTauriMobile || nativePlatform !== 'ios') return;
  const dark = Boolean(themeDark) || (route === 'login' && width > PHONE_MAX_WIDTH);
  if (dark === lastDark) return;
  lastDark = dark;
  // One call at a time, so an earlier colour never lands after a later one.
  pending = pending
    .then(() => setShellBackground(dark))
    .catch(() => {
      // try again on the next change
      if (lastDark === dark) lastDark = undefined;
    });
}
