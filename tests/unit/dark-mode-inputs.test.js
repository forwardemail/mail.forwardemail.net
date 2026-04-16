/**
 * Tests for dark mode form input styling.
 *
 * Native radio buttons, checkboxes, and range inputs use the CSS
 * accent-color property.  In dark mode, the --primary variable resolves
 * to a very light gray that makes checked/unchecked states
 * indistinguishable.  The fix adds explicit accent-color overrides in
 * dark mode using a vivid blue (oklch 0.488 0.243 264.376).
 *
 * These tests verify that the main.css stylesheet contains the correct
 * dark-mode rules for all native form input types.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mainCss = readFileSync(resolve(__dirname, '../../src/styles/main.css'), 'utf-8');

describe('dark mode form input accent-color', () => {
  it('sets accent-color for radio buttons in dark mode', () => {
    expect(mainCss).toMatch(/\.dark\s+input\[type=['"]radio['"]\]/);
  });

  it('sets accent-color for checkboxes in dark mode', () => {
    expect(mainCss).toMatch(/\.dark\s+input\[type=['"]checkbox['"]\]/);
  });

  it('sets accent-color for range inputs in dark mode', () => {
    expect(mainCss).toMatch(/\.dark\s+input\[type=['"]range['"]\]/);
  });

  it('uses a vivid color (not the light gray --primary) for dark mode accent', () => {
    // The dark mode accent-color should NOT be the light gray primary
    // oklch(0.929 ...) but rather the vivid blue oklch(0.488 ...)
    const darkRadioRule = mainCss.match(
      /\.dark\s+input\[type=['"]radio['"]\][^}]*accent-color:\s*([^;]+)/,
    );
    expect(darkRadioRule).not.toBeNull();
    const accentValue = darkRadioRule[1].trim();
    // Should contain the vivid blue value, not the light gray
    expect(accentValue).toContain('0.488');
    expect(accentValue).not.toContain('0.929');
  });

  it('sets color-scheme: dark for date/time inputs in dark mode', () => {
    expect(mainCss).toMatch(/\.dark\s+input\[type=['"]date['"]\]/);
    expect(mainCss).toMatch(/color-scheme:\s*dark/);
  });

  it('sets accent-color for light mode inputs', () => {
    expect(mainCss).toMatch(/:root:not\(\.dark\)\s+input\[type=['"]radio['"]\]/);
  });

  it('sets color-scheme: light for date/time inputs in light mode', () => {
    expect(mainCss).toMatch(/:root:not\(\.dark\)\s+input\[type=['"]date['"]\]/);
    expect(mainCss).toMatch(/color-scheme:\s*light/);
  });
});
