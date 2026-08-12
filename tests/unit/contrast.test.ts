import { describe, it, expect } from 'vitest';
import { relativeLuminance, contrastRatio, readableForeground } from '../../src/utils/contrast';

describe('contrast helper', () => {
  it('computes known relative luminances', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('expands three-digit hex', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(relativeLuminance('#ffffff'), 5);
  });

  it('computes the canonical black-on-white ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is order independent', () => {
    expect(contrastRatio('#2563eb', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#2563eb'), 5);
  });

  it('picks dark text on pale backgrounds and light text on dark ones', () => {
    // The bug this fixes: a pale label chip previously forced white text.
    expect(readableForeground('#fef08a')).toBe('#070b16');
    expect(readableForeground('#ffffff')).toBe('#070b16');
    expect(readableForeground('#0e1628')).toBe('#e2e8f0');
  });

  it('escalates off-palette when the palette neutral misses AA', () => {
    // Primary blue reaches only 4.19:1 against --fe-n-700, so the choice has to
    // fall back to pure white (5.17:1). Staying on palette is preferred but not
    // at the cost of legibility over a colour the user chose.
    expect(readableForeground('#2563eb')).toBe('#ffffff');
    expect(readableForeground('#d6336c')).toBe('#ffffff');
    // A background with headroom keeps the palette neutral.
    expect(readableForeground('#5f3dc4')).toBe('#e2e8f0');
  });

  it('whatever it picks clears AA for body text', () => {
    // Sweep the label palette plus the extremes; every choice must pass 4.5:1.
    const swatches = [
      '#fef08a',
      '#ffffff',
      '#000000',
      '#0e1628',
      '#2563eb',
      '#34d399',
      '#f59e0b',
      '#d6336c',
      '#5f3dc4',
      '#0ca678',
      '#1c7ed6',
      '#84cc16',
      '#a855f7',
      '#14b8a6',
    ];
    for (const bg of swatches) {
      expect(contrastRatio(readableForeground(bg), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('falls back to a light foreground when no colour is set', () => {
    expect(readableForeground(null)).toBe('#e2e8f0');
    expect(readableForeground(undefined)).toBe('#e2e8f0');
    expect(readableForeground('')).toBe('#e2e8f0');
  });
});
