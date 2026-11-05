/**
 * Remote.request with the real ky retry layer: a 503 that names a long wait
 * (Retry-After, or an X-RateLimit-Reset epoch now that CORS exposes them)
 * must not hold a request for minutes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({ config: { apiBase: 'https://api.example.com' } }));
vi.mock('../../src/utils/auth.ts', () => ({
  buildApiKeyAuthHeader: vi.fn(() => ''),
  getAuthHeader: vi.fn(() => 'Basic dXNlckBleGFtcGxlLmNvbTpwdw=='),
}));
vi.mock('../../src/utils/error-logger.ts', () => ({ logApiError: vi.fn() }));
vi.mock('../../src/utils/perf-logger.ts', () => ({ logPerfEvent: vi.fn() }));
vi.mock('../../src/utils/demo-mode', () => ({
  interceptDemoRequest: vi.fn(() => ({ handled: false })),
  isDemoMode: vi.fn(() => false),
}));

const { Remote } = await import('../../src/utils/remote.js');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settlesWithin(promise, ms) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

describe('Remote.request — 503 with a long Retry-After', () => {
  const cases = [
    ['Retry-After', () => '600'],
    ['X-RateLimit-Reset', () => String(Math.floor(Date.now() / 1000) + 3600)],
  ];
  for (const [header, value] of cases) {
    it(`gives up within seconds when the server sends ${header}`, async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchMock = vi.fn(
        async () =>
          new Response('{"message":"Rekey in progress"}', {
            status: 503,
            headers: { 'Content-Type': 'application/json', [header]: value() },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const request = Remote.request('MessageList', { folder: 'INBOX' }, { bypassCircuit: true });
      request.catch(() => {});

      // two retries, each waiting at most 5s
      expect(await settlesWithin(request, 11_000)).toBe(true);
      await expect(request).rejects.toMatchObject({ status: 503 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      vi.unstubAllGlobals();
    });
  }
});
