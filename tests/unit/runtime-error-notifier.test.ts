import { describe, it, expect, vi } from 'vitest';
import {
  installRuntimeErrorNotifier,
  isSanitizedForeignError,
  RUNTIME_ERROR_TOAST_MESSAGE,
} from '../../src/utils/runtime-error-notifier';

function makeTarget() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  return {
    addEventListener(type: string, fn: (e: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string, event: Record<string, unknown>) {
      for (const fn of listeners.get(type) ?? []) fn(event as unknown as Event);
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function setup(intervalMs = 30_000) {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const toasts = { show: vi.fn() };
  const target = makeTarget();
  const uninstall = installRuntimeErrorNotifier(toasts, { now, target, intervalMs });
  return { toasts, target, advance, uninstall };
}

describe('isSanitizedForeignError', () => {
  it('matches the browser-sanitized shape only', () => {
    expect(isSanitizedForeignError({ message: 'Script error.', lineno: 0 })).toBe(true);
    expect(isSanitizedForeignError({ message: 'Script error', lineno: 0 })).toBe(true);
    expect(isSanitizedForeignError({ message: 'Script error.', filename: 'a.js', lineno: 3 })).toBe(
      false,
    );
    expect(isSanitizedForeignError({ message: 'Script error.', error: new Error('x') })).toBe(
      false,
    );
    expect(isSanitizedForeignError({ message: 'TypeError: x is undefined', lineno: 0 })).toBe(
      false,
    );
  });
});

describe('installRuntimeErrorNotifier', () => {
  it('shows one error toast for a genuine runtime error', () => {
    const { toasts, target } = setup();
    target.fire('error', { message: 'boom', error: new Error('boom'), lineno: 5 });
    expect(toasts.show).toHaveBeenCalledTimes(1);
    expect(toasts.show).toHaveBeenCalledWith(RUNTIME_ERROR_TOAST_MESSAGE, 'error');
  });

  it('stays silent for sanitized cross-origin errors', () => {
    const { toasts, target } = setup();
    target.fire('error', { message: 'Script error.', lineno: 0, colno: 0 });
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it('stays silent for resource-load, chunk-load, and harness noise', () => {
    const { toasts, target } = setup();
    target.fire('error', { target: { tagName: 'SCRIPT' }, message: '' });
    target.fire('error', {
      message: 'Failed to fetch dynamically imported module: /assets/x.js',
      error: new Error('Failed to fetch dynamically imported module: /assets/x.js'),
    });
    target.fire('unhandledrejection', { reason: new Error('stale element reference') });
    expect(toasts.show).not.toHaveBeenCalled();
  });

  it('notifies on unhandled rejections', () => {
    const { toasts, target } = setup();
    target.fire('unhandledrejection', { reason: new Error('db failed') });
    expect(toasts.show).toHaveBeenCalledTimes(1);
  });

  it('throttles to one toast per interval', () => {
    const { toasts, target, advance } = setup(30_000);
    target.fire('error', { message: 'a', error: new Error('a') });
    target.fire('error', { message: 'b', error: new Error('b') });
    target.fire('unhandledrejection', { reason: new Error('c') });
    expect(toasts.show).toHaveBeenCalledTimes(1);
    advance(30_000);
    target.fire('error', { message: 'd', error: new Error('d') });
    expect(toasts.show).toHaveBeenCalledTimes(2);
  });

  it('uninstalls cleanly and is a no-op without a toast host', () => {
    const { target, uninstall } = setup();
    expect(target.count('error')).toBe(1);
    uninstall();
    expect(target.count('error')).toBe(0);
    expect(target.count('unhandledrejection')).toBe(0);

    const bare = makeTarget();
    const noop = installRuntimeErrorNotifier(null, { target: bare });
    expect(bare.count('error')).toBe(0);
    noop();
  });

  it('survives a toast host that throws', () => {
    const toasts = {
      show: vi.fn(() => {
        throw new Error('toast host broken');
      }),
    };
    const target = makeTarget();
    installRuntimeErrorNotifier(toasts, { target });
    expect(() => target.fire('error', { message: 'x', error: new Error('x') })).not.toThrow();
  });
});
