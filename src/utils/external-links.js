import { getEffectiveSettingValue } from '../stores/settingsStore';
import { isTauri, isTauriDesktop } from './platform.js';

export const EXTERNAL_BROWSER_OVERRIDE_SETTING = 'external_browser_override';

export const normalizeExternalBrowserOverride = (value) =>
  value === null || value === undefined ? '' : String(value).trim();

export const isWindowsUserAgent = (
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
) =>
  String(userAgent || '')
    .toLowerCase()
    .includes('windows');

export const supportsExternalBrowserOverride = ({
  tauriDesktop = isTauriDesktop,
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
} = {}) => Boolean(tauriDesktop && isWindowsUserAgent(userAgent));

export const getExternalBrowserOverride = ({
  account,
  storedValue,
  tauriDesktop = isTauriDesktop,
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
} = {}) => {
  if (!supportsExternalBrowserOverride({ tauriDesktop, userAgent })) {
    return '';
  }

  const nextValue =
    storedValue === undefined
      ? getEffectiveSettingValue(EXTERNAL_BROWSER_OVERRIDE_SETTING, { account })
      : storedValue;

  return normalizeExternalBrowserOverride(nextValue);
};

export async function openExternalUrl(
  url,
  {
    account,
    browserOverride,
    tauri = isTauri,
    tauriDesktop = isTauriDesktop,
    userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
    openUrl,
    windowOpen = globalThis.window?.open?.bind(globalThis.window),
    log = console.warn,
  } = {},
) {
  if (!tauri) {
    windowOpen?.(url, '_blank', 'noopener,noreferrer');
    return { mode: 'window-open' };
  }

  const openerModule = openUrl ? null : await import('@tauri-apps/plugin-opener');
  const openUrlImpl = openUrl || openerModule.openUrl;
  const override =
    browserOverride === undefined
      ? getExternalBrowserOverride({ account, tauriDesktop, userAgent })
      : normalizeExternalBrowserOverride(browserOverride);

  if (override && supportsExternalBrowserOverride({ tauriDesktop, userAgent })) {
    try {
      await openUrlImpl(url, override);
      return { mode: 'tauri-override', app: override };
    } catch (error) {
      log?.('[external-links] preferred browser failed, falling back to system default:', error);
    }
  }

  await openUrlImpl(url);
  return { mode: 'tauri-default' };
}

export const bindExternalLinkInterceptor = ({
  root = globalThis.document || null,
  currentLocation = globalThis.window?.location || null,
  navigate,
  openExternal = openExternalUrl,
  log = console.warn,
} = {}) => {
  if (!root?.addEventListener) {
    return () => {
      // No-op cleanup when there is no DOM root to attach to.
    };
  }

  const handler = (event) => {
    const link = event.target?.closest?.('a');
    if (!link || event.defaultPrevented || link.hasAttribute('download')) {
      return;
    }

    let url;
    try {
      url = new URL(link.href, currentLocation?.href || globalThis.window?.location?.href);
    } catch {
      return;
    }

    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
    if (!isHttp) {
      return;
    }

    const nextPath = `${url.pathname}${url.search}${url.hash}`;
    const currentPath = currentLocation
      ? `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}`
      : '';

    if (currentLocation && url.origin === currentLocation.origin) {
      event.preventDefault();
      event.stopPropagation();
      if (nextPath !== currentPath) {
        navigate?.(nextPath);
      }

      return;
    }

    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(openExternal(url.toString())).catch((error) => {
      log?.('[external-links] Failed to open URL:', error);
    });
  };

  root.addEventListener('click', handler, true);
  return () => root.removeEventListener('click', handler, true);
};
