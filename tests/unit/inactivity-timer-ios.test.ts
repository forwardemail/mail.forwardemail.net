/**
 * Lock-on-minimize on iOS follows real background entry only.
 *
 * iOS resigns "active" for Control Center, notification banners, Face ID /
 * passkey sheets and permission alerts while the app is still on screen. That
 * used to start the minimize grace period, so a slow passkey or permission
 * prompt locked the app under the user. SceneDelegate.swift now reports those
 * as fe:app-inactive and real backgrounding as fe:app-background.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: true,
  isTauriMobile: true,
  nativePlatform: 'ios',
}));
vi.mock('../../src/utils/crypto-store.js', () => ({
  getLockPrefs: () => ({ enabled: true, lockOnMinimize: true, timeoutMs: 60 * 60 * 1000 }),
}));

const timer = await import('../../src/utils/inactivity-timer.js');

const fire = (name: string) => window.dispatchEvent(new CustomEvent(name));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  timer.stop();
  vi.useRealTimers();
});

async function startWith(onLock: () => void) {
  timer.start(onLock);
  // setupTauriListeners is async; let it register the lifecycle listeners.
  await vi.advanceTimersByTimeAsync(0);
}

describe('iOS lock on minimize', () => {
  it('does not lock while the app is merely inactive (system sheet on screen)', async () => {
    const onLock = vi.fn();
    await startWith(onLock);

    fire('fe:app-inactive');
    await vi.advanceTimersByTimeAsync(120_000);
    fire('fe:app-foreground');

    expect(onLock).not.toHaveBeenCalled();
  });

  it('locks on return after the grace period in the background', async () => {
    const onLock = vi.fn();
    await startWith(onLock);

    fire('fe:app-background');
    vi.setSystemTime(Date.now() + 31_000);
    fire('fe:app-foreground');

    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('does not lock after a quick switch away and back', async () => {
    const onLock = vi.fn();
    await startWith(onLock);

    fire('fe:app-background');
    await vi.advanceTimersByTimeAsync(5_000);
    fire('fe:app-foreground');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onLock).not.toHaveBeenCalled();
  });
});
