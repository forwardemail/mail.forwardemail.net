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

// ── running version vs persisted state ────────────────────────────────────

describe('running version detection', () => {
  let updater;
  let updateCallback;

  async function load(running) {
    vi.resetModules();
    const meta = document.createElement('meta');
    meta.name = 'app-version';
    meta.content = running;
    document.head.appendChild(meta);
    updater = await import('../../src/utils/web-updater.js');
    updateCallback = vi.fn();
    updater.start({ onUpdateAvailable: updateCallback });
  }

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => ({}) });
  });

  afterEach(() => {
    updater?.stop();
    document.querySelector('meta[name="app-version"]')?.remove();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('still offers the update when an older build stored the new version as current', async () => {
    // A reload that came back on the old bundle used to leave this behind and
    // the stale tab then believed it was already up to date.
    localStorage.setItem('webmail_current_version', '2.0.0');
    await load('1.0.0');

    updater.handleWsNewRelease({ release: { tagName: 'v2.0.0' } });

    expect(updateCallback).toHaveBeenCalledWith(
      expect.objectContaining({ currentVersion: '1.0.0', newVersion: '2.0.0' }),
    );
    expect(localStorage.getItem('webmail_current_version')).toBeNull();
  });

  it('does not reload again for the same release within the cooldown', async () => {
    localStorage.setItem(
      'webmail_update_attempt',
      JSON.stringify({ version: '2.0.0', at: Date.now() - 60_000 }),
    );
    await load('1.0.0');

    updater.handleWsNewRelease({ release: { tagName: 'v2.0.0' } });

    expect(updateCallback).not.toHaveBeenCalled();
  });

  it('retries the same release once the cooldown has passed', async () => {
    localStorage.setItem(
      'webmail_update_attempt',
      JSON.stringify({ version: '2.0.0', at: Date.now() - 11 * 60_000 }),
    );
    await load('1.0.0');

    updater.handleWsNewRelease({ release: { tagName: 'v2.0.0' } });

    expect(updateCallback).toHaveBeenCalledTimes(1);
  });

  it('clears the attempt once the new bundle is running', async () => {
    localStorage.setItem(
      'webmail_update_attempt',
      JSON.stringify({ version: '2.0.0', at: Date.now() }),
    );
    await load('2.0.0');

    expect(localStorage.getItem('webmail_update_attempt')).toBeNull();
  });

  it('manual check reports the running version and retries inside the cooldown', async () => {
    localStorage.setItem(
      'webmail_update_attempt',
      JSON.stringify({ version: '2.0.0', at: Date.now() }),
    );
    await load('1.0.0');
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v2.0.0' }),
    });

    const result = await updater.checkNow();

    expect(result).toMatchObject({ upToDate: false, currentVersion: '1.0.0' });
    expect(updateCallback).toHaveBeenCalledTimes(1);
  });
});

// ── waitForServiceWorkerUpdate ────────────────────────────────────────────

describe('waitForServiceWorkerUpdate', () => {
  function fakeWorker(state) {
    const listeners = new Set();
    return {
      state,
      postMessage: vi.fn(),
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
      go(next) {
        this.state = next;
        for (const fn of listeners) fn();
      },
    };
  }

  it('resolves false when there is no new worker', async () => {
    const { waitForServiceWorkerUpdate } = await import('../../src/utils/web-updater.js');
    const reg = { update: vi.fn().mockResolvedValue(undefined), installing: null, waiting: null };

    await expect(waitForServiceWorkerUpdate(reg)).resolves.toBe(false);
    expect(reg.update).toHaveBeenCalled();
  });

  it('waits for the installing worker to activate, asking it to skip waiting', async () => {
    const { waitForServiceWorkerUpdate } = await import('../../src/utils/web-updater.js');
    const worker = fakeWorker('installing');
    const reg = { update: vi.fn().mockResolvedValue(undefined), installing: worker, waiting: null };

    let settled = false;
    const pending = waitForServiceWorkerUpdate(reg).then((v) => {
      settled = true;
      return v;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.go('installed');
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    worker.go('activated');

    await expect(pending).resolves.toBe(true);
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    const { waitForServiceWorkerUpdate } = await import('../../src/utils/web-updater.js');
    const worker = fakeWorker('installing');
    const reg = { update: vi.fn().mockResolvedValue(undefined), installing: worker, waiting: null };

    const pending = waitForServiceWorkerUpdate(reg, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toBe(false);
    vi.useRealTimers();
  });
});

// ── terminal client ───────────────────────────────────────────────────────

describe('in the terminal client', () => {
  let updater;

  // A running 1.0.0 bundle and a GitHub that has 9.9.9.
  async function load() {
    vi.resetModules();
    const meta = document.createElement('meta');
    meta.name = 'app-version';
    meta.content = '1.0.0';
    document.head.appendChild(meta);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://example.test/release' }),
    });
    updater = await import('../../src/utils/web-updater.js');
    return fetchSpy;
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    updater?.stop();
    delete globalThis.__FORWARDEMAIL_TERMINAL__;
    document.querySelector('meta[name="app-version"]')?.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('finds the update in a browser (the control for the test below)', async () => {
    const fetchSpy = await load();
    const onUpdateAvailable = vi.fn();
    updater.start({ onUpdateAvailable });
    await settle();
    expect(fetchSpy).toHaveBeenCalled();
    expect(onUpdateAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ currentVersion: '1.0.0', newVersion: '9.9.9' }),
    );
  });

  it('neither checks for nor announces web updates, which would reload the same code', async () => {
    const fetchSpy = await load();
    globalThis.__FORWARDEMAIL_TERMINAL__ = true;
    const onUpdateAvailable = vi.fn();
    const on = vi.fn(() => vi.fn());
    updater.start({ onUpdateAvailable, wsClient: { on } });
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    expect(onUpdateAvailable).not.toHaveBeenCalled();
  });
});
