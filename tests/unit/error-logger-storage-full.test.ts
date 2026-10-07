/**
 * error-logger: with session storage full, saving a log entry fails and the
 * logger reports that on console.error. The logger also records everything
 * written to console.error, so the report was logged, saved, failed and
 * reported again until the stack ran out, on every error the app logged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('error logger with session storage full', () => {
  const originalError = console.error;

  afterEach(() => {
    console.error = originalError;
    vi.restoreAllMocks();
  });

  it('logs an error once and does not recurse', async () => {
    const printed = vi.fn();
    console.error = printed;
    // Importing it puts its handler on console.error.
    await import('../../src/utils/error-logger.ts');

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });

    expect(() => console.error('Sync failed')).not.toThrow();

    // One save and its one retry after trimming.
    expect(setItem).toHaveBeenCalledTimes(2);
    // The message itself, and the logger's own report of the failed save.
    expect(printed.mock.calls.map((call) => String(call[0]))).toEqual([
      'Failed to save logs to sessionStorage:',
      'Sync failed',
    ]);
  });
});
