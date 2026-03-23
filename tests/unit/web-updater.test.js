import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compareSemver, handleWsNewRelease, start, stop } from '../../src/utils/web-updater.js';

// ── compareSemver ─────────────────────────────────────────────────────────

describe('compareSemver', () => {
  it('returns 1 when a > b (major)', () => {
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1);
  });

  it('returns 1 when a > b (minor)', () => {
    expect(compareSemver('1.2.0', '1.1.0')).toBe(1);
  });

  it('returns 1 when a > b (patch)', () => {
    expect(compareSemver('1.0.2', '1.0.1')).toBe(1);
  });

  it('returns -1 when a < b', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
  });

  it('returns 0 when equal', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('strips leading v prefix', () => {
    expect(compareSemver('v2.0.0', 'v1.0.0')).toBe(1);
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
  });

  it('handles pre-release suffixes (compares only major.minor.patch)', () => {
    expect(compareSemver('1.2.3-beta.1', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.4-rc.1', '1.2.3')).toBe(1);
  });

  it('returns 0 for invalid inputs', () => {
    expect(compareSemver(null, '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', null)).toBe(0);
    expect(compareSemver('', '')).toBe(0);
    expect(compareSemver('abc', '1.0.0')).toBe(0);
  });
});

// ── handleWsNewRelease ────────────────────────────────────────────────────

describe('handleWsNewRelease', () => {
  let updateCallback;

  beforeEach(() => {
    // Set a known current version via meta tag
    const meta = document.createElement('meta');
    meta.name = 'app-version';
    meta.content = '1.0.0';
    document.head.appendChild(meta);

    updateCallback = vi.fn();

    // Stub fetch to prevent real GitHub API calls
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });

    start({ onUpdateAvailable: updateCallback });
  });

  afterEach(() => {
    stop();
    // Clean up meta tag
    const meta = document.querySelector('meta[name="app-version"]');
    if (meta) meta.remove();
    // Clear localStorage
    localStorage.removeItem('webmail_current_version');
    localStorage.removeItem('webmail_dismissed_version');
    vi.restoreAllMocks();
  });

  it('handles nested payload shape: { release: { tagName } }', () => {
    handleWsNewRelease({
      release: {
        tagName: 'v2.0.0',
        htmlUrl: 'https://github.com/example/releases/v2.0.0',
        name: 'Version 2.0.0',
        body: 'Release notes',
        publishedAt: '2026-01-01T00:00:00Z',
      },
    });

    expect(updateCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        newVersion: '2.0.0',
        currentVersion: '1.0.0',
      }),
    );
  });

  it('handles nested payload with tag_name (snake_case)', () => {
    handleWsNewRelease({
      release: {
        tag_name: 'v3.0.0',
        html_url: 'https://example.com',
        name: 'v3',
      },
    });

    expect(updateCallback).toHaveBeenCalledWith(expect.objectContaining({ newVersion: '3.0.0' }));
  });

  it('handles nested payload with version field', () => {
    handleWsNewRelease({
      release: {
        version: '4.0.0',
      },
    });

    expect(updateCallback).toHaveBeenCalledWith(expect.objectContaining({ newVersion: '4.0.0' }));
  });

  it('handles flattened payload shape (forward-compat)', () => {
    handleWsNewRelease({
      version: '5.0.0',
      url: 'https://example.com',
      name: 'v5',
    });

    expect(updateCallback).toHaveBeenCalledWith(expect.objectContaining({ newVersion: '5.0.0' }));
  });

  it('handles flattened payload with tagName', () => {
    handleWsNewRelease({
      tagName: 'v6.0.0',
    });

    expect(updateCallback).toHaveBeenCalledWith(expect.objectContaining({ newVersion: '6.0.0' }));
  });

  it('strips v prefix from version', () => {
    handleWsNewRelease({
      release: { tagName: 'v7.0.0' },
    });

    expect(updateCallback).toHaveBeenCalledWith(expect.objectContaining({ newVersion: '7.0.0' }));
  });

  it('ignores null/undefined data', () => {
    handleWsNewRelease(null);
    handleWsNewRelease(undefined);
    expect(updateCallback).not.toHaveBeenCalled();
  });

  it('ignores data with no extractable version', () => {
    handleWsNewRelease({});
    handleWsNewRelease({ release: {} });
    handleWsNewRelease({ foo: 'bar' });
    expect(updateCallback).not.toHaveBeenCalled();
  });

  it('ignores versions older than or equal to current', () => {
    handleWsNewRelease({ release: { tagName: 'v0.9.0' } });
    expect(updateCallback).not.toHaveBeenCalled();

    handleWsNewRelease({ release: { tagName: 'v1.0.0' } });
    expect(updateCallback).not.toHaveBeenCalled();
  });
});

// ── start / stop lifecycle ────────────────────────────────────────────────

describe('start and stop lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
  });

  afterEach(() => {
    stop();
    vi.restoreAllMocks();
  });

  it('subscribes to wsClient.on("newRelease") when wsClient is provided', () => {
    const mockOn = vi.fn(() => vi.fn()); // returns unsub
    const wsClient = { on: mockOn };

    start({ wsClient });

    expect(mockOn).toHaveBeenCalledWith('newRelease', expect.any(Function));
  });

  it('does not throw when wsClient is not provided', () => {
    expect(() => start({})).not.toThrow();
  });

  it('calls unsubscribe on stop when wsClient was provided', () => {
    const unsub = vi.fn();
    const mockOn = vi.fn(() => unsub);
    const wsClient = { on: mockOn };

    start({ wsClient });
    stop();

    expect(unsub).toHaveBeenCalled();
  });
});
