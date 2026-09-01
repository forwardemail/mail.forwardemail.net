import { describe, it, expect } from 'vitest';
import {
  isThemeChosen,
  resolveNotificationComplete,
  shouldShowGetStarted,
} from '../../src/utils/get-started';

describe('isThemeChosen', () => {
  it('treats an absent raw key as not chosen (the store falls back to the system default)', () => {
    expect(isThemeChosen(null)).toBe(false);
    expect(isThemeChosen('')).toBe(false);
  });

  it('counts any stored value as an explicit choice, including choosing system on purpose', () => {
    expect(isThemeChosen('dark')).toBe(true);
    expect(isThemeChosen('light')).toBe(true);
    expect(isThemeChosen('system')).toBe(true);
  });
});

describe('resolveNotificationComplete', () => {
  it('trusts a definite Tauri answer over the web API', () => {
    expect(resolveNotificationComplete('granted', 'denied')).toBe(true);
    expect(resolveNotificationComplete('not-granted', 'granted')).toBe(false);
  });

  it('falls back to the web permission when Tauri has no definite answer', () => {
    expect(resolveNotificationComplete(null, 'granted')).toBe(true);
    expect(resolveNotificationComplete('unknown', 'granted')).toBe(true);
    expect(resolveNotificationComplete('unsupported', 'granted')).toBe(true);
    expect(resolveNotificationComplete(null, 'default')).toBe(false);
    expect(resolveNotificationComplete('unsupported', 'denied')).toBe(false);
  });

  it('is incomplete when neither source can answer', () => {
    expect(resolveNotificationComplete(null, null)).toBe(false);
    expect(resolveNotificationComplete('unknown', null)).toBe(false);
  });
});

describe('shouldShowGetStarted', () => {
  const incomplete = [
    { id: 'notifications', complete: false },
    { id: 'appearance', complete: true },
  ];
  const allComplete = [
    { id: 'notifications', complete: true },
    { id: 'appearance', complete: true },
  ];

  it('shows while any item is left to do', () => {
    expect(shouldShowGetStarted({ dismissed: false, demoMode: false, items: incomplete })).toBe(
      true,
    );
  });

  it('retires itself once every item is complete', () => {
    expect(shouldShowGetStarted({ dismissed: false, demoMode: false, items: allComplete })).toBe(
      false,
    );
  });

  it('dismissal wins over incomplete items', () => {
    expect(shouldShowGetStarted({ dismissed: true, demoMode: false, items: incomplete })).toBe(
      false,
    );
  });

  it('never shows in demo mode, which has no real account to set up', () => {
    expect(shouldShowGetStarted({ dismissed: false, demoMode: true, items: incomplete })).toBe(
      false,
    );
  });

  it('does not show for an empty item list', () => {
    expect(shouldShowGetStarted({ dismissed: false, demoMode: false, items: [] })).toBe(false);
  });
});
