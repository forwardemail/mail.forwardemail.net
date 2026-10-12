import { checkClearManifest, isVersionBelow } from '../../src/utils/clear-manifest';

const manifestResponse = (body: unknown, ok = true) =>
  ({ ok, json: async () => body }) as unknown as Response;

const setup = (fetchImpl: typeof fetch, version = '0.14.30') => {
  const clear = vi.fn(async () => {});
  const reload = vi.fn();
  return { clear, reload, run: () => checkClearManifest({ version, fetchImpl, clear, reload }) };
};

describe('isVersionBelow', () => {
  it('compares major, minor and patch numerically', () => {
    expect(isVersionBelow('0.14.30', '0.14.31')).toBe(true);
    expect(isVersionBelow('0.9.0', '0.14.0')).toBe(true);
    expect(isVersionBelow('0.14.30', '0.14.30')).toBe(false);
    expect(isVersionBelow('1.0.0', '0.99.99')).toBe(false);
  });

  it('ignores a build hash suffix instead of failing the comparison', () => {
    // "30-a1b2c3d4" used to become NaN, so a hashed build never reset.
    expect(isVersionBelow('0.14.30-a1b2c3d4', '0.14.31')).toBe(true);
  });
});

describe('checkClearManifest', () => {
  it('wipes and reloads a client below clear_below', async () => {
    const { clear, reload, run } = setup(async () => manifestResponse({ clear_below: '0.15.0' }));
    await expect(run()).resolves.toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
  });

  it('leaves a current client alone, and a missing or broken manifest', async () => {
    for (const fetchImpl of [
      async () => manifestResponse({ clear_below: '0.14.30' }),
      async () => manifestResponse({}),
      async () => manifestResponse(null, false),
      async () => {
        throw new TypeError('Failed to fetch');
      },
    ]) {
      const { clear, reload, run } = setup(fetchImpl as typeof fetch);
      await expect(run()).resolves.toBe(false);
      expect(clear).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    }
  });

  it('gives up on a stalled request instead of holding up boot', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      // Like a real fetch: never answers, but rejects once aborted.
      const stalled = ((_url: string, init: { signal?: AbortSignal }) => {
        signal = init.signal ?? undefined;
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        });
      }) as unknown as typeof fetch;
      const clear = vi.fn(async () => {});
      const result = checkClearManifest({ fetchImpl: stalled, timeoutMs: 3000, clear });

      await vi.advanceTimersByTimeAsync(2999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(false);
      expect(clear).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
