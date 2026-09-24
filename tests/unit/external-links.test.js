import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindExternalLinkInterceptor,
  getExternalBrowserOverride,
  normalizeExternalBrowserOverride,
  openExternalUrl,
  supportsExternalBrowserOverride,
} from '../../src/utils/external-links.js';

let mockIsTauri = false;
let mockIsTauriDesktop = false;
const getEffectiveSettingValueMock = vi.fn(() => '');

vi.mock('../../src/utils/platform.js', () => ({
  get isTauri() {
    return mockIsTauri;
  },
  get isTauriDesktop() {
    return mockIsTauriDesktop;
  },
}));

vi.mock('../../src/stores/settingsStore', () => ({
  getEffectiveSettingValue: (...args) => getEffectiveSettingValueMock(...args),
}));

describe('external-links', () => {
  beforeEach(() => {
    mockIsTauri = false;
    mockIsTauriDesktop = false;
    getEffectiveSettingValueMock.mockReset();
    getEffectiveSettingValueMock.mockReturnValue('');
    globalThis.document.body.innerHTML = '';
  });

  it('normalizes the browser override value', () => {
    expect(normalizeExternalBrowserOverride('  firefox  ')).toBe('firefox');
    expect(normalizeExternalBrowserOverride('')).toBe('');
    expect(normalizeExternalBrowserOverride(null)).toBe('');
  });

  it('only supports a browser override on Windows Tauri desktop', () => {
    expect(
      supportsExternalBrowserOverride({
        tauriDesktop: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }),
    ).toBe(true);

    expect(
      supportsExternalBrowserOverride({
        tauriDesktop: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      }),
    ).toBe(false);

    expect(
      supportsExternalBrowserOverride({
        tauriDesktop: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }),
    ).toBe(false);
  });

  it('returns the trimmed stored override only when the runtime supports it', () => {
    getEffectiveSettingValueMock.mockReturnValue('  firefox  ');

    expect(
      getExternalBrowserOverride({
        account: 'demo@example.com',
        tauriDesktop: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      }),
    ).toBe('firefox');
    expect(getEffectiveSettingValueMock).toHaveBeenCalledWith('external_browser_override', {
      account: 'demo@example.com',
    });

    expect(
      getExternalBrowserOverride({
        account: 'demo@example.com',
        tauriDesktop: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      }),
    ).toBe('');
  });

  it('opens links with window.open outside Tauri', async () => {
    const windowOpen = vi.fn();

    const result = await openExternalUrl('https://forwardemail.net/docs', {
      tauri: false,
      windowOpen,
    });

    expect(windowOpen).toHaveBeenCalledWith(
      'https://forwardemail.net/docs',
      '_blank',
      'noopener,noreferrer',
    );
    expect(result).toEqual({ mode: 'window-open' });
  });

  it('uses the configured browser override on Windows Tauri desktop', async () => {
    mockIsTauri = true;
    mockIsTauriDesktop = true;
    getEffectiveSettingValueMock.mockReturnValue('firefox');
    const openUrl = vi.fn().mockResolvedValue(undefined);

    const result = await openExternalUrl('https://forwardemail.net/docs', {
      account: 'demo@example.com',
      openUrl,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://forwardemail.net/docs', 'firefox');
    expect(result).toEqual({ mode: 'tauri-override', app: 'firefox' });
  });

  it('falls back to the system default browser if the configured override fails', async () => {
    mockIsTauri = true;
    mockIsTauriDesktop = true;
    getEffectiveSettingValueMock.mockReturnValue('firefox');
    const openUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error('browser missing'))
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();

    const result = await openExternalUrl('https://forwardemail.net/docs', {
      account: 'demo@example.com',
      openUrl,
      log,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });

    expect(openUrl).toHaveBeenNthCalledWith(1, 'https://forwardemail.net/docs', 'firefox');
    expect(openUrl).toHaveBeenNthCalledWith(2, 'https://forwardemail.net/docs');
    expect(log).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ mode: 'tauri-default' });
  });

  it('uses the system default browser on Tauri when no override is configured', async () => {
    mockIsTauri = true;
    mockIsTauriDesktop = true;
    getEffectiveSettingValueMock.mockReturnValue('');
    const openUrl = vi.fn().mockResolvedValue(undefined);

    const result = await openExternalUrl('https://forwardemail.net/docs', {
      account: 'demo@example.com',
      openUrl,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://forwardemail.net/docs');
    expect(result).toEqual({ mode: 'tauri-default' });
  });

  it('routes same-origin links through in-app navigation', () => {
    const root = globalThis.document.createElement('div');
    root.innerHTML = '<a href="https://app.forwardemail.net/settings?tab=privacy#links">Links</a>';
    globalThis.document.body.append(root);
    const navigate = vi.fn();
    const openExternal = vi.fn();

    const cleanup = bindExternalLinkInterceptor({
      root,
      currentLocation: new URL('https://app.forwardemail.net/settings'),
      navigate,
      openExternal,
    });

    const link = root.querySelector('a');
    const event = new globalThis.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/settings?tab=privacy#links');
    expect(openExternal).not.toHaveBeenCalled();

    cleanup();
  });

  it('routes external http links through the shared opener helper', async () => {
    const root = globalThis.document.createElement('div');
    root.innerHTML = '<a href="https://forwardemail.net/docs">Docs</a>';
    globalThis.document.body.append(root);
    const navigate = vi.fn();
    const openExternal = vi.fn().mockResolvedValue({ mode: 'tauri-default' });

    const cleanup = bindExternalLinkInterceptor({
      root,
      currentLocation: new URL('https://app.forwardemail.net/settings'),
      navigate,
      openExternal,
    });

    const link = root.querySelector('a');
    const event = new globalThis.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://forwardemail.net/docs');
    expect(navigate).not.toHaveBeenCalled();

    cleanup();
  });

  it('ignores non-http links so mailto handlers can keep working elsewhere', () => {
    const root = globalThis.document.createElement('div');
    root.innerHTML = '<a href="mailto:test@example.com">Email</a>';
    globalThis.document.body.append(root);
    const navigate = vi.fn();
    const openExternal = vi.fn();

    const cleanup = bindExternalLinkInterceptor({
      root,
      currentLocation: new URL('https://app.forwardemail.net/settings'),
      navigate,
      openExternal,
    });

    const link = root.querySelector('a');
    link.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
    });
    const event = new globalThis.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    cleanup();
  });
});

describe('openExternalUrl scheme allowlist', () => {
  it.each([
    'javascript:alert(document.cookie)',
    ' JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'ms-settings:privacy',
    'not a url',
    '',
  ])('refuses %j on the web and in Tauri', async (url) => {
    const { openExternalUrl } = await import('../../src/utils/external-links.js');
    const windowOpen = vi.fn();
    const openUrl = vi.fn();

    await expect(
      openExternalUrl(url, { tauri: false, windowOpen, log: () => {} }),
    ).resolves.toEqual({
      mode: 'blocked',
    });
    await expect(
      openExternalUrl(url, { tauri: true, openUrl, browserOverride: '', log: () => {} }),
    ).resolves.toEqual({ mode: 'blocked' });
    expect(windowOpen).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.com/a?b=c',
    'http://example.com',
    'mailto:a@example.com',
    'tel:+15555550100',
  ])('opens %j', async (url) => {
    const { openExternalUrl } = await import('../../src/utils/external-links.js');
    const windowOpen = vi.fn();
    await openExternalUrl(url, { tauri: false, windowOpen });
    expect(windowOpen).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
  });
});
