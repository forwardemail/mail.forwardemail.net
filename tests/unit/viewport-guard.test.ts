/**
 * The viewport guard (src/utils/viewport-guard.ts): on a phone whose layout
 * viewport came back wider than the screen (iOS, after the WebContent process
 * was killed and the page reloaded), the app rendered its desktop layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform.js', () => ({ isTauriMobile: true }));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));

const guard = await import('../../src/utils/viewport-guard');

const setViewport = ({ inner, screenW, screenH, portrait = true }) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: inner });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: portrait ? Math.max(inner * 2, 800) : Math.min(inner / 2, 400),
  });
  Object.defineProperty(window, 'screen', {
    configurable: true,
    value: { width: screenW, height: screenH },
  });
  window.matchMedia = vi.fn((query) => ({
    matches: query.includes('portrait') ? portrait : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
};

describe('viewport guard', () => {
  let meta;
  beforeEach(() => {
    guard.__resetViewportGuardForTests();
    meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    meta.setAttribute(
      'content',
      'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover',
    );
    document.head.appendChild(meta);
  });
  afterEach(() => {
    meta.remove();
  });

  it('reports a healthy phone viewport as is', () => {
    setViewport({ inner: 390, screenW: 390, screenH: 844 });
    expect(guard.isViewportBroken()).toBe(false);
    expect(guard.getLayoutWidth()).toBe(390);
  });

  it('detects a portrait phone laid out wider than its screen', () => {
    setViewport({ inner: 980, screenW: 390, screenH: 844 });
    expect(guard.isViewportBroken()).toBe(true);
    // layout code gets the phone width, so it renders the mobile layout
    expect(guard.getLayoutWidth()).toBe(390);
  });

  it('leaves landscape and tablets alone', () => {
    setViewport({ inner: 844, screenW: 390, screenH: 844, portrait: false });
    expect(guard.isViewportBroken()).toBe(false);
    expect(guard.getLayoutWidth()).toBe(844);

    setViewport({ inner: 820, screenW: 820, screenH: 1180 });
    expect(guard.isViewportBroken()).toBe(false);
    expect(guard.getLayoutWidth()).toBe(820);
  });

  it('re-applies the viewport meta, restores it and announces a resize', async () => {
    setViewport({ inner: 980, screenW: 390, screenH: 844 });
    const original = meta.getAttribute('content');
    const resized = vi.fn();
    window.addEventListener('resize', resized);

    expect(guard.repairViewport('test')).toBe(true);
    expect(meta.getAttribute('content')).toBe('width=device-width, initial-scale=1.0');

    // the engine recomputes the viewport; next frame restores the meta
    setViewport({ inner: 390, screenW: 390, screenH: 844 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(meta.getAttribute('content')).toBe(original);
    expect(resized).toHaveBeenCalled();
    window.removeEventListener('resize', resized);
  });

  it('does nothing when the viewport is healthy', () => {
    setViewport({ inner: 390, screenW: 390, screenH: 844 });
    expect(guard.repairViewport('test')).toBe(false);
  });

  it('tells listeners when the layout width changes on returning to the foreground', () => {
    setViewport({ inner: 390, screenW: 390, screenH: 844 });
    guard.installViewportGuard();
    const listener = vi.fn();
    guard.onLayoutWidthChange(listener);

    setViewport({ inner: 390, screenW: 390, screenH: 844, portrait: false });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 844 });
    window.dispatchEvent(new Event('fe:app-foreground'));
    expect(listener).toHaveBeenCalledWith(844);
  });
});

describe('viewport guard when the repair does not take', () => {
  it('stops after a few attempts instead of repairing every frame', async () => {
    guard.__resetViewportGuardForTests();
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0');
    document.head.appendChild(meta);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 980 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1960 });
    Object.defineProperty(window, 'screen', {
      configurable: true,
      value: { width: 390, height: 844 },
    });
    window.matchMedia = vi.fn((query) => ({
      matches: query.includes('portrait'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const setAttribute = vi.spyOn(meta, 'setAttribute');

    guard.installViewportGuard();
    // the viewport never recovers; give it plenty of frames
    await new Promise((resolve) => setTimeout(resolve, 300));

    // each repair writes the meta twice (toggle and restore)
    expect(setAttribute.mock.calls.length).toBeLessThanOrEqual(6);
    meta.remove();
  });
});
