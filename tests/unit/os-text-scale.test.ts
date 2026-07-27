import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// nativePlatform is read at module load, so the platform mock has to be in
// place before the module under test is imported. Each test re-imports with a
// fresh module registry.
const loadModule = async (platform: string | null) => {
  vi.resetModules();
  vi.doMock('../../src/utils/platform.js', () => ({ nativePlatform: platform }));
  return import('../../src/utils/os-text-scale');
};

// Stand in for WKWebView resolving `font: -apple-system-body`. jsdom returns ''
// for an unresolvable font shorthand, so computed font-size is faked instead.
const stubComputedFontSize = (px: string) => {
  const original = window.getComputedStyle;
  const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = original.call(window, el as Element, pseudo as string | undefined);
    return new Proxy(style, {
      get(target, prop) {
        if (prop === 'fontSize') return px;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as CSSStyleDeclaration;
  });
  return spy;
};

const readScaleVar = () => document.documentElement.style.getPropertyValue('--fe-text-scale');

describe('os-text-scale', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--fe-text-scale');
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('leaves the scale untouched at the iOS default of 17px', async () => {
    stubComputedFontSize('17px');
    const { initOsTextScale, getOsTextScale } = await loadModule('ios');
    initOsTextScale();
    expect(getOsTextScale()).toBe(1);
    // Nothing to publish when the value did not move off the CSS default.
    expect(readScaleVar()).toBe('');
  });

  it('scales up proportionally for a larger system text size', async () => {
    stubComputedFontSize('23px');
    const { initOsTextScale, getOsTextScale } = await loadModule('ios');
    initOsTextScale();
    expect(getOsTextScale()).toBeCloseTo(23 / 17, 5);
    expect(Number.parseFloat(readScaleVar())).toBeCloseTo(23 / 17, 5);
  });

  it('scales down for a smaller system text size', async () => {
    stubComputedFontSize('15px');
    const { initOsTextScale, getOsTextScale } = await loadModule('ios');
    initOsTextScale();
    expect(getOsTextScale()).toBeCloseTo(15 / 17, 5);
  });

  // The accessibility sizes reach ~53px, over 3x, which no mail layout absorbs.
  it('clamps the huge accessibility sizes to a layout-safe maximum', async () => {
    stubComputedFontSize('53px');
    const { initOsTextScale, getOsTextScale } = await loadModule('ios');
    initOsTextScale();
    expect(getOsTextScale()).toBe(1.6);
  });

  it('clamps absurdly small measurements to a readable minimum', async () => {
    stubComputedFontSize('4px');
    const { initOsTextScale, getOsTextScale } = await loadModule('ios');
    initOsTextScale();
    expect(getOsTextScale()).toBe(0.85);
  });

  // Android WebView already applies the system font scale to CSS text, so
  // scaling again here would compound it.
  it('does nothing off iOS', async () => {
    stubComputedFontSize('23px');
    const { initOsTextScale, getOsTextScale } = await loadModule('android');
    initOsTextScale();
    expect(getOsTextScale()).toBe(1);
    expect(readScaleVar()).toBe('');
    expect(document.body.querySelector('span')).toBeNull();
  });

  it('picks up a change on the next refresh', async () => {
    const spy = stubComputedFontSize('17px');
    const { initOsTextScale, refreshOsTextScale, getOsTextScale } = await loadModule('ios');
    initOsTextScale();
    expect(getOsTextScale()).toBe(1);

    spy.mockRestore();
    stubComputedFontSize('20px');
    refreshOsTextScale();
    expect(getOsTextScale()).toBeCloseTo(20 / 17, 5);
  });

  it('ignores an unusable measurement rather than zeroing out text', async () => {
    stubComputedFontSize('0px');
    const { initOsTextScale, getOsTextScale } = await loadModule('ios');
    initOsTextScale();
    expect(getOsTextScale()).toBe(1);
    expect(readScaleVar()).toBe('');
  });

  it('keeps the probe out of the accessibility tree', async () => {
    stubComputedFontSize('17px');
    const { initOsTextScale } = await loadModule('ios');
    initOsTextScale();
    const injected = document.body.querySelector('span');
    expect(injected?.getAttribute('aria-hidden')).toBe('true');
    expect(injected?.style.position).toBe('absolute');
  });
});
