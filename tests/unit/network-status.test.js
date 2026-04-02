import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing the module
vi.mock('../../src/config', () => ({
  config: { apiBase: 'https://api.forwardemail.net' },
}));

// We need to test the module in isolation, so we'll import dynamically
let networkStatus;

describe('network-status', () => {
  let originalOnLine;
  let originalFetch;
  beforeEach(async () => {
    // Save originals
    originalOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    originalFetch = globalThis.fetch;

    // Reset module state by re-importing
    vi.resetModules();
    networkStatus = await import('../../src/utils/network-status');
    networkStatus.destroyNetworkStatus();
  });

  afterEach(() => {
    networkStatus.destroyNetworkStatus();
    // Restore originals
    if (originalOnLine) {
      Object.defineProperty(Navigator.prototype, 'onLine', originalOnLine);
    }
    globalThis.fetch = originalFetch;
  });

  describe('isOnline()', () => {
    it('returns true by default (optimistic)', () => {
      expect(networkStatus.isOnline()).toBe(true);
    });
  });

  describe('onlineStatus store', () => {
    it('is a Svelte store that defaults to true', () => {
      let value;
      const unsub = networkStatus.onlineStatus.subscribe((v) => {
        value = v;
      });
      expect(value).toBe(true);
      unsub();
    });
  });

  describe('checkConnectivity()', () => {
    it('returns true immediately when navigator.onLine is true', async () => {
      Object.defineProperty(Navigator.prototype, 'onLine', {
        get: () => true,
        configurable: true,
      });

      const result = await networkStatus.checkConnectivity();
      expect(result).toBe(true);
      expect(networkStatus.isOnline()).toBe(true);
    });

    it('probes the API when navigator.onLine is false and returns true if reachable', async () => {
      Object.defineProperty(Navigator.prototype, 'onLine', {
        get: () => false,
        configurable: true,
      });

      // Mock fetch to succeed (simulating the API is reachable)
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

      const result = await networkStatus.checkConnectivity({ force: true });
      expect(result).toBe(true);
      expect(networkStatus.isOnline()).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it('returns false when navigator.onLine is false and API probe fails', async () => {
      Object.defineProperty(Navigator.prototype, 'onLine', {
        get: () => false,
        configurable: true,
      });

      // Mock fetch to fail (network error)
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const result = await networkStatus.checkConnectivity({ force: true });
      expect(result).toBe(false);
      expect(networkStatus.isOnline()).toBe(false);
    });

    it('treats any HTTP response (even 401) as proof of connectivity', async () => {
      Object.defineProperty(Navigator.prototype, 'onLine', {
        get: () => false,
        configurable: true,
      });

      // Mock fetch to return 401 (still proves connectivity)
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

      const result = await networkStatus.checkConnectivity({ force: true });
      expect(result).toBe(true);
    });

    it('uses cached result within TTL when not forced', async () => {
      Object.defineProperty(Navigator.prototype, 'onLine', {
        get: () => false,
        configurable: true,
      });

      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

      // First call probes
      await networkStatus.checkConnectivity({ force: true });
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      // Second call within TTL should use cache
      await networkStatus.checkConnectivity();
      expect(globalThis.fetch).toHaveBeenCalledOnce(); // Still only 1 call
    });

    it('force bypasses cache', async () => {
      Object.defineProperty(Navigator.prototype, 'onLine', {
        get: () => false,
        configurable: true,
      });

      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

      await networkStatus.checkConnectivity({ force: true });
      await networkStatus.checkConnectivity({ force: true });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('initNetworkStatus()', () => {
    it('can be called multiple times safely', () => {
      expect(() => {
        networkStatus.initNetworkStatus();
        networkStatus.initNetworkStatus();
      }).not.toThrow();
    });
  });

  describe('destroyNetworkStatus()', () => {
    it('resets state to defaults', () => {
      networkStatus.destroyNetworkStatus();
      expect(networkStatus.isOnline()).toBe(true);
    });
  });

  describe('false offline recovery', () => {
    it('recovers from false offline when API probe succeeds', async () => {
      Object.defineProperty(Navigator.prototype, 'onLine', {
        get: () => false,
        configurable: true,
      });

      // First: simulate genuinely offline
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      await networkStatus.checkConnectivity({ force: true });
      expect(networkStatus.isOnline()).toBe(false);

      // Then: API becomes reachable (but browser still says offline)
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      await networkStatus.checkConnectivity({ force: true });
      expect(networkStatus.isOnline()).toBe(true);
    });
  });
});
