/**
 * App Store and Google Play builds may not send people to outside purchases
 * or sign-up (App Review Guidelines 3.1.1 and 3.1.3(f), Google Play Payments
 * policy). These tests load the real modules under stubbed Tauri globals, the
 * same way the app boots inside each native shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppStoreBuild } from '../../src/utils/store-policy.js';

function stubTauri(platform) {
  window.__TAURI_INTERNALS__ = {};
  window.__TAURI_OS_PLUGIN_INTERNALS__ = { platform };
}

function clearTauri() {
  delete window.__TAURI_INTERNALS__;
  delete window.__TAURI_OS_PLUGIN_INTERNALS__;
}

describe('isAppStoreBuild', () => {
  it.each([
    ['web app', { tauri: false, platform: null }, false],
    ['iOS app', { tauri: true, platform: 'ios' }, true],
    [
      'Google Play build (FCM and UnifiedPush)',
      { tauri: true, platform: 'android', androidPushProvider: 'auto' },
      true,
    ],
    [
      'Google Play build (FCM only)',
      { tauri: true, platform: 'android', androidPushProvider: 'fcm' },
      true,
    ],
    [
      'F-Droid and direct-download build',
      { tauri: true, platform: 'android', androidPushProvider: 'unified-push' },
      false,
    ],
    ['macOS app', { tauri: true, platform: 'macos' }, false],
    ['Windows app', { tauri: true, platform: 'windows' }, false],
    ['Linux app', { tauri: true, platform: 'linux' }, false],
  ])('%s → %s', (_name, env, expected) => {
    expect(isAppStoreBuild(env)).toBe(expected);
  });
});

describe('shouldHidePurchaseLinks inside each app', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    clearTauri();
  });

  it('is on inside the iOS app', async () => {
    stubTauri('ios');
    const { shouldHidePurchaseLinks } = await import('../../src/utils/store-policy.js');
    expect(shouldHidePurchaseLinks()).toBe(true);
  });

  it('is off in the web app and the desktop apps', async () => {
    clearTauri();
    expect((await import('../../src/utils/store-policy.js')).shouldHidePurchaseLinks()).toBe(false);

    vi.resetModules();
    stubTauri('macos');
    expect((await import('../../src/utils/store-policy.js')).shouldHidePurchaseLinks()).toBe(false);
  });
});

describe('demo mode in a store build', () => {
  let show;
  let open;

  beforeEach(() => {
    vi.resetModules();
    show = vi.fn();
    open = vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    open.mockRestore();
    clearTauri();
  });

  async function blockedDelete() {
    const demo = await import('../../src/utils/demo-mode.js');
    demo.setDemoToasts({ show });
    demo.activateDemoMode();
    demo.interceptDemoRequest('MessageDelete');
    demo.deactivateDemoMode();
    demo.setDemoToasts(null);
    return show.mock.calls[0];
  }

  it('offers Sign In instead of Create Account and opens no sign-up page', async () => {
    stubTauri('ios');
    const [message, type, options] = await blockedDelete();

    expect(message).toBe(
      'Delete message isn’t available in the demo. Sign in with your Forward Email account to make changes.',
    );
    expect(type).toBe('warning');
    expect(options.action.label).toBe('Sign In');

    options.action.callback();
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps Create Account and the sign-up page in the web app', async () => {
    clearTauri();
    const [message, , options] = await blockedDelete();

    expect(message).toBe(
      'Delete message isn’t available in the demo. Create an account to make changes.',
    );
    expect(options.action.label).toBe('Create Account');

    options.action.callback();
    expect(open).toHaveBeenCalledWith('https://forwardemail.net', '_blank', 'noopener,noreferrer');
  });
});

describe('demo welcome message', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    clearTauri();
  });

  async function welcome() {
    const { generateMessages } = await import('../../src/utils/demo-data.js');
    return generateMessages('INBOX').find((m) => m.subject === 'Welcome to Forward Email!');
  }

  it('asks App Store users to sign in and links to no sign-up page', async () => {
    stubTauri('ios');
    const message = await welcome();

    expect(message.text).toContain(
      'To use your own account, sign out of the demo and sign in with your Forward Email address.',
    );
    expect(message.text).not.toContain('https://forwardemail.net');
    expect(message.html).not.toContain('<a ');
  });

  it('keeps the sign-up link in the web app', async () => {
    clearTauri();
    const message = await welcome();

    expect(message.text).toContain(
      'To get started with your own account, visit https://forwardemail.net',
    );
    expect(message.html).toContain('<a href="https://forwardemail.net">forwardemail.net</a>');
  });
});
