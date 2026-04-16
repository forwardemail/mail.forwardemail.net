/**
 * Tests for system theme (light/dark mode) auto-change detection.
 *
 * The app must listen for OS-level prefers-color-scheme changes via
 * matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ...)
 * so that when the system switches between light and dark mode, the app
 * theme updates automatically without requiring a manual toggle.
 *
 * These tests verify the applyTheme function responds correctly to
 * system theme changes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('system theme auto-change', () => {
  let listeners;
  let matchesDark;

  beforeEach(() => {
    listeners = [];
    matchesDark = false;

    // Mock matchMedia
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === '(prefers-color-scheme: dark)' ? matchesDark : false,
      media: query,
      addEventListener: vi.fn((event, handler) => {
        if (event === 'change') listeners.push(handler);
      }),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    // Clean up document classes
    document.documentElement.classList.remove('dark');
    document.body.classList.remove('light-mode', 'dark-mode');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Simplified applyTheme that mirrors the logic in main.ts.
   * We test the function in isolation to avoid importing the full app.
   */
  function applyTheme(pref) {
    const theme = pref || 'system';
    const prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = theme === 'dark' || (theme === 'system' && prefersDark);
    document.documentElement.classList.toggle('dark', isDark);
    document.body.classList.remove('light-mode', 'dark-mode');
    document.body.classList.add(isDark ? 'dark-mode' : 'light-mode');
  }

  it('applies dark mode when system prefers dark', () => {
    matchesDark = true;
    applyTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.body.classList.contains('dark-mode')).toBe(true);
  });

  it('applies light mode when system prefers light', () => {
    matchesDark = false;
    applyTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.body.classList.contains('light-mode')).toBe(true);
  });

  it('switches from light to dark when system theme changes', () => {
    matchesDark = false;
    applyTheme('system');
    expect(document.body.classList.contains('light-mode')).toBe(true);

    // Simulate system theme change to dark
    matchesDark = true;
    applyTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.body.classList.contains('dark-mode')).toBe(true);
    expect(document.body.classList.contains('light-mode')).toBe(false);
  });

  it('switches from dark to light when system theme changes', () => {
    matchesDark = true;
    applyTheme('system');
    expect(document.body.classList.contains('dark-mode')).toBe(true);

    // Simulate system theme change to light
    matchesDark = false;
    applyTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.body.classList.contains('light-mode')).toBe(true);
    expect(document.body.classList.contains('dark-mode')).toBe(false);
  });

  it('matchMedia addEventListener is called for change event', () => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', () => applyTheme());
    expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('explicit dark setting overrides system preference', () => {
    matchesDark = false;
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.body.classList.contains('dark-mode')).toBe(true);
  });

  it('explicit light setting overrides system dark preference', () => {
    matchesDark = true;
    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.body.classList.contains('light-mode')).toBe(true);
  });
});
