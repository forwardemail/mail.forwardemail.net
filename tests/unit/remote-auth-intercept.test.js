import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
vi.mock('ky', () => {
  const create = vi.fn(() => mockKyInstance);
  const mockKyInstance = vi.fn();
  mockKyInstance.create = create;
  return { default: { create } };
});

vi.mock('../../src/config', () => ({
  config: { apiBase: 'https://api.example.com' },
}));

vi.mock('../../src/utils/auth.ts', () => ({
  buildApiKeyAuthHeader: vi.fn(() => ''),
  getAuthHeader: vi.fn(() => 'Basic dGVzdDp0ZXN0'),
}));

vi.mock('../../src/utils/error-logger.ts', () => ({
  logApiError: vi.fn(),
}));

vi.mock('../../src/utils/perf-logger.ts', () => ({
  logPerfEvent: vi.fn(),
}));

vi.mock('../../src/utils/demo-mode', () => ({
  interceptDemoRequest: vi.fn(() => ({ handled: false })),
  isDemoMode: vi.fn(() => false),
}));

// Capture fe:auth-expired events
let authExpiredEvents = [];
const authExpiredHandler = () => authExpiredEvents.push(Date.now());

beforeEach(() => {
  authExpiredEvents = [];
  window.addEventListener('fe:auth-expired', authExpiredHandler);
});

afterEach(() => {
  window.removeEventListener('fe:auth-expired', authExpiredHandler);
  vi.restoreAllMocks();
});

// Import after mocks
const ky = (await import('ky')).default;
const { Remote } = await import('../../src/utils/remote.js');

function make401Error() {
  const err = new Error('Unauthorized');
  err.name = 'HTTPError';
  err.response = {
    status: 401,
    json: vi.fn().mockResolvedValue({ message: 'Basic authentication required' }),
  };
  return err;
}

function makeOkResponse(data = {}) {
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    json: vi.fn().mockResolvedValue(data),
  };
}

describe('Remote.request — 401 interception', () => {
  it('fires fe:auth-expired after 3 consecutive 401s', async () => {
    const kyInstance = ky.create();

    // 3 consecutive 401 errors
    for (let i = 0; i < 3; i++) {
      kyInstance.mockRejectedValueOnce(make401Error());
    }

    for (let i = 0; i < 3; i++) {
      await expect(Remote.request('Account')).rejects.toThrow();
    }

    // Allow microtask to fire
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(authExpiredEvents.length).toBe(1);
  });

  it('resets counter on successful request', async () => {
    const kyInstance = ky.create();

    // 2 failures, then success, then 2 more failures
    kyInstance.mockRejectedValueOnce(make401Error());
    kyInstance.mockRejectedValueOnce(make401Error());
    kyInstance.mockResolvedValueOnce(makeOkResponse({ ok: true }));
    kyInstance.mockRejectedValueOnce(make401Error());
    kyInstance.mockRejectedValueOnce(make401Error());

    await expect(Remote.request('Account')).rejects.toThrow();
    await expect(Remote.request('Account')).rejects.toThrow();
    await Remote.request('Account'); // success — resets counter
    await expect(Remote.request('Account')).rejects.toThrow();
    await expect(Remote.request('Account')).rejects.toThrow();

    // Allow microtask to fire
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    // Should NOT have fired — counter was reset by the success
    expect(authExpiredEvents.length).toBe(0);
  });

  it('does not fire fe:auth-expired for non-401 errors', async () => {
    const kyInstance = ky.create();

    const make500Error = () => {
      const err = new Error('Server Error');
      err.name = 'HTTPError';
      err.response = {
        status: 500,
        json: vi.fn().mockResolvedValue({ message: 'Internal Server Error' }),
      };
      return err;
    };

    for (let i = 0; i < 5; i++) {
      kyInstance.mockRejectedValueOnce(make500Error());
    }

    for (let i = 0; i < 5; i++) {
      await expect(Remote.request('Account')).rejects.toThrow();
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(authExpiredEvents.length).toBe(0);
  });
});
