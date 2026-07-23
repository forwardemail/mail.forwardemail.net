import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('mobile viewport stability contract', () => {
  it('locks the mobile viewport width and disables accidental page scaling', () => {
    const html = readSource('index.html');

    expect(html).toContain('width=device-width');
    expect(html).toContain('initial-scale=1.0');
    expect(html).toContain('maximum-scale=1.0');
    expect(html).toContain('user-scalable=no');
    expect(html).toContain('viewport-fit=cover');
  });

  it('uses a 16 px iOS focus-zoom guard for every text-entry control', () => {
    const css = readSource('src/styles/base.css');

    const compactCss = css.replace(/\s+/g, '');
    expect(compactCss).toContain(
      "input:not([type='checkbox']):not([type='radio']):not([type='range']):not([type='button']):not([type='submit']):not([type='reset'])",
    );
    expect(css).toContain('textarea');
    expect(css).toContain('select');
    expect(css).toContain('font-size: 16px !important');
  });
});

describe('mobile safe-area and refresh feedback contract', () => {
  it.each([
    'src/svelte/Settings.svelte',
    'src/svelte/Profile.svelte',
    'src/svelte/Contacts.svelte',
    'src/svelte/Calendar.svelte',
  ])('keeps the bottom controls reachable in %s', (relativePath) => {
    expect(readSource(relativePath)).toContain('fe-mobile-page-scroll');
  });

  it('defines the shared route-scroll inset using the device bottom safe area', () => {
    const css = readSource('src/styles/base.css');

    expect(css).toContain('.fe-mobile-page-scroll');
    expect(css).toContain('var(--sai-bottom)');
  });

  it('shows pull, release, and active refresh states as an accessible live status', () => {
    const mailbox = readSource('src/svelte/Mailbox.svelte');

    expect(mailbox).toContain("'Pull to refresh'");
    expect(mailbox).toContain("'Release to refresh'");
    expect(mailbox).toContain("'Refreshing…'");
    expect(mailbox).toContain('role="status"');
    expect(mailbox).toContain('aria-live="polite"');
    expect(mailbox).toContain("isRefreshing ? 'animate-spin' : ''");
  });
});

describe('friendly demo mailbox mutation contract', () => {
  it('preserves action-specific wording for label mutations on the shared account endpoint', () => {
    const store = readSource('src/stores/settingsStore.ts');
    const demo = readSource('src/utils/demo-mode.js');

    expect(demo).toContain('options?.demoAction || getFriendlyActionName(action)');
    expect(store).toContain("demoAction: 'Create label'");
    expect(store).toContain("demoAction: 'Update label'");
    expect(store).toContain("demoAction: 'Delete label'");
  });

  it('preflights delete and archive intent before optimistic mailbox updates', () => {
    const store = readSource('src/stores/mailboxStore.ts');
    const mailbox = readSource('src/svelte/Mailbox.svelte');

    expect(store).toContain("demoAction: 'Delete message'");
    expect(store).toContain("demoAction: 'Archive'");
    expect(store).toContain('if (isDemoMode())');
    expect(store).toContain(
      'if (isDemoBlockedError(err)) return { success: false, blocked: true };',
    );
    expect(store).toContain('return { success: 0, failed: validMessages.length, blocked: true };');
    expect(mailbox).toContain('if (!isDemoMode()) {');
    expect(mailbox).toContain('if (result?.blocked) return result;');
  });
});

describe('mobile edge-back integration contract', () => {
  it('binds accepted global edge gestures to browser history navigation', () => {
    const main = readSource('src/main.ts');

    expect(main).toContain("import { bindEdgeSwipeBack } from './utils/mobile-edge-swipe';");
    expect(main).toContain('bindEdgeSwipeBack({');
    expect(main).toContain('history.back()');
  });

  it('routes edge gesture and Android native back through a shared mailbox fallback', () => {
    const main = readSource('src/main.ts');

    expect(main).toContain("import { onBackButton } from './utils/tauri-bridge.js';");
    expect(main).toContain('const navigateMobileBack = () =>');
    expect(main).toContain("viewModel.navigate('/mailbox', { replace: true })");
    expect(main).toContain('onBackButton(() =>');
    expect(main).toContain("if (currentRoute() !== 'mailbox') navigateMobileBack();");
  });

  it('keeps the Mailbox native back handler scoped to the mailbox route', () => {
    const mailbox = readSource('src/svelte/Mailbox.svelte');

    expect(mailbox).toContain(
      'if (!/^\\/mailbox\\/?$/.test(globalThis.location.pathname)) return;',
    );
    expect(mailbox).toContain('if (mobileBackUnlisten) mobileBackUnlisten();');
  });

  it('uses the SPA navigator for the Settings back control instead of history-only navigation', () => {
    const settings = readSource('src/svelte/Settings.svelte');

    expect(settings).toContain("onclick={() => navigate('/mailbox')}");
    expect(settings).not.toContain('onclick={() => window.history.back()}');
  });

  it('gives the left-edge gesture precedence over pull, row, reader, and iframe swipes', () => {
    const mailbox = readSource('src/svelte/Mailbox.svelte');

    expect(mailbox).toContain(
      "import { evaluateEdgeSwipe, isEdgeSwipeStart } from '../utils/mobile-edge-swipe'",
    );
    expect(mailbox.match(/isEdgeSwipeStart\(/g)?.length || 0).toBeGreaterThanOrEqual(4);
    expect(mailbox.match(/evaluateEdgeSwipe\(/g)?.length || 0).toBeGreaterThanOrEqual(2);
    expect(mailbox).toContain('iframeEdgeBackGesture');
  });
});
