/**
 * A message is sent with its attachments in the request, so the time allowed
 * for it grows with its size (a 5 MB attachment timed out on a slow
 * connection, see mail.forwardemail.net#114).
 */
import { describe, expect, it, vi } from 'vitest';

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

const { getRequestTimeout } = await import('../../src/utils/remote.js');

const MB = 1_048_576;
const attachment = (bytes) => ({ attachments: [{ content: 'a'.repeat(bytes) }] });

describe('getRequestTimeout', () => {
  it('keeps the timeout of other requests', () => {
    expect(getRequestTimeout('MessageList', attachment(7 * MB))).toBe(10_000);
    expect(getRequestTimeout('Unknown', {})).toBe(30_000);
  });

  it('allows more time to send a larger message', () => {
    const small = getRequestTimeout('Emails', { text: 'hi' });
    const large = getRequestTimeout('Emails', attachment(7 * MB));
    expect(small).toBe(30_000);
    expect(large).toBe(30_000 + 7 * 30_000);
  });

  it('allows at most 10 minutes', () => {
    expect(getRequestTimeout('Emails', attachment(50 * MB))).toBe(600_000);
  });
});

describe('Remote.request', () => {
  it('gives up on a send after the time allowed for its size', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { Remote } = await import('../../src/utils/remote.js');
    // (a server that never answers, until the request is aborted)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (request) =>
          new Promise((resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason));
          }),
      ),
    );

    const request = Remote.request('Emails', attachment(2 * MB), {
      method: 'POST',
      bypassCircuit: true,
    });
    let error;
    request.catch((err) => (error = err));

    // (still waiting after the default 30 seconds, and given up at 90)
    await vi.advanceTimersByTimeAsync(31_000);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toMatchObject({ isClientTimeout: true });

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
