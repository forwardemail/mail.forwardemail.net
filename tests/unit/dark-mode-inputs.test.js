/**
 * Tests for native form control styling across themes.
 *
 * Native radio buttons, checkboxes and range inputs take their tick and fill
 * from the CSS accent-color property. The bug this guards against is a checked
 * state that is indistinguishable from unchecked.
 *
 * History matters for reading these assertions. Dark mode used to resolve
 * --primary to a near-white grey (oklch 0.929), which made accent-color
 * useless, so main.css carried per-theme overrides pinned to a hardcoded vivid
 * blue. The design system gives --primary a real Primary blue in both themes,
 * so a single token-driven rule now covers both and the overrides are gone.
 * These tests assert the outcome (a visible checked state from a token) rather
 * than the old mechanism.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mainCss = readFileSync(resolve(__dirname, '../../src/styles/main.css'), 'utf-8');
const feTokens = readFileSync(resolve(__dirname, '../../src/styles/fe-tokens.css'), 'utf-8');

describe('native form control accent-color', () => {
  it('sets accent-color for radio, checkbox and range inputs', () => {
    const rule = mainCss.match(
      /input\[type='radio'\],\s*input\[type='checkbox'\],\s*input\[type='range'\]\s*\{([^}]*)\}/,
    );
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/accent-color:\s*var\(--action-primary-bg\)/);
  });

  it('drives accent-color from a token rather than a literal colour', () => {
    // A hardcoded accent could not follow a palette change, which is how the
    // old dark-mode override drifted from the rest of the app.
    const accents = [...mainCss.matchAll(/accent-color:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(accents.length).toBeGreaterThan(0);
    for (const value of accents) {
      expect(value).toMatch(/^var\(--/);
    }
  });

  it('resolves the accent to a real Primary blue in both themes', () => {
    // The original defect: a near-white --primary in dark mode. --action-primary-bg
    // must be Primary in both themes, never a neutral from the grey ramp.
    expect(feTokens).toContain('--fe-primary: #2563eb;');
    const light = feTokens.match(/:root\s*\{([\s\S]*?)\n\}/);
    const dark = feTokens.match(/\.dark\s*\{([\s\S]*?)\n\}/);
    expect(light).not.toBeNull();
    expect(dark).not.toBeNull();
    expect(light[1]).toMatch(/--action-primary-bg:\s*var\(--fe-primary\)/);
    expect(dark[1]).toMatch(/--action-primary-bg:\s*var\(--fe-primary\)/);
  });

  it('no longer carries per-theme accent-color overrides', () => {
    // Their only reason for existing was the near-white --primary.
    expect(mainCss).not.toMatch(/\.dark\s+input\[type='radio'\]/);
    expect(mainCss).not.toMatch(/:root:not\(\.dark\)\s+input\[type='radio'\]/);
  });

  it('sets color-scheme so native date and time pickers render legibly', () => {
    // Unlike accent-color, this genuinely differs per theme: it tells the
    // platform which widget chrome to draw.
    expect(mainCss).toMatch(/\.dark\s+input\[type='date'\]/);
    expect(mainCss).toMatch(/color-scheme:\s*dark/);
    expect(mainCss).toMatch(/:root:not\(\.dark\)\s+input\[type='date'\]/);
    expect(mainCss).toMatch(/color-scheme:\s*light/);
  });

  it('keeps touch checkboxes high-contrast against their surface', () => {
    // Android WebView renders a 1px border at the default border token at
    // near-zero contrast at phone density, so this block raises both the
    // border weight and its contrast. It must stay token-driven.
    const coarse = mainCss.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}\n/);
    expect(coarse).not.toBeNull();
    expect(coarse[1]).toMatch(/border-width:\s*2px\s*!important/);
    expect(coarse[1]).toMatch(/background-color:\s*var\(--action-primary-bg\)\s*!important/);
  });
});
