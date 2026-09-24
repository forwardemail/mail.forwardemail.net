import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const lock = vi.hoisted(() => ({
  unlockWithPin: vi.fn(),
}));

vi.mock('../../src/utils/crypto-store.js', () => ({
  isVaultConfigured: () => true,
  isUnlocked: () => false,
  unlockWithPin: (...args: unknown[]) => lock.unlockWithPin(...args),
  unlockWithPasskey: vi.fn(),
  getLockPrefs: () => ({ enabled: true, pinLength: 4, hasPasskey: false }),
}));
vi.mock('../../src/utils/passkey-auth.js', () => ({
  isWebAuthnAvailable: () => false,
  hasPasskeyCredential: () => false,
  authenticatePasskey: vi.fn(),
}));

import LockScreen from '../../src/svelte/LockScreen.svelte';

let appRoot: HTMLElement;
let overlay: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  appRoot = document.createElement('div');
  appRoot.id = 'mailbox-root';
  appRoot.innerHTML = '<button id="behind">Behind</button>';
  overlay = document.createElement('div');
  overlay.id = 'app-lock-overlay';
  document.body.append(appRoot, overlay);
});

afterEach(() => {
  cleanup();
  appRoot.remove();
  overlay.remove();
});

const digit = (value: string) => screen.getByRole('button', { name: value });

async function tap(button: HTMLElement) {
  await fireEvent.pointerDown(button, { pointerType: 'touch', button: 0 });
  // The click iOS sends after the finger lifts must not count twice.
  await fireEvent.click(button);
}

describe('<LockScreen />', () => {
  it('registers each tap exactly once, including repeated digits', async () => {
    lock.unlockWithPin.mockResolvedValue(true);
    render(LockScreen, { target: overlay });

    for (const value of ['1', '1', '2', '2']) {
      await tap(digit(value));
    }

    await waitFor(() => expect(lock.unlockWithPin).toHaveBeenCalledTimes(1));
    expect(lock.unlockWithPin).toHaveBeenCalledWith('1122');
  });

  it('still accepts plain clicks (assistive technology, mouse)', async () => {
    lock.unlockWithPin.mockResolvedValue(true);
    render(LockScreen, { target: overlay });

    for (const value of ['4', '3', '2', '1']) {
      await fireEvent.click(digit(value));
    }

    await waitFor(() => expect(lock.unlockWithPin).toHaveBeenCalledWith('4321'));
  });

  it('ignores taps while a PIN is being checked', async () => {
    let finish: (value: boolean) => void = () => {};
    lock.unlockWithPin.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(LockScreen, { target: overlay });

    for (const value of ['1', '2', '3', '4']) {
      await tap(digit(value));
    }
    await tap(digit('9'));
    finish(false);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Incorrect PIN'));
    expect(lock.unlockWithPin).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/PIN entry, 0 of 4/)).toBeInTheDocument();
  });

  it('makes the app behind it inert while shown and restores it afterwards', async () => {
    const { unmount } = render(LockScreen, { target: overlay });

    expect(appRoot.hasAttribute('inert')).toBe(true);
    expect(overlay.hasAttribute('inert')).toBe(false);

    unmount();
    expect(appRoot.hasAttribute('inert')).toBe(false);
  });
});
