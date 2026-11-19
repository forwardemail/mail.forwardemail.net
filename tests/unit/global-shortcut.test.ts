import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureFromKeyboardEvent,
  formatAccelerator,
  parseGlobalShortcutStatus,
  validateAcceleratorInput,
  type ShortcutKeyEvent,
} from '../../src/utils/global-shortcut';

const key = (overrides: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({
  key: 'M',
  code: 'KeyM',
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});

describe('captureFromKeyboardEvent', () => {
  it('keeps Command and Ctrl as different modifiers', () => {
    expect(captureFromKeyboardEvent(key({ metaKey: true, shiftKey: true }))).toEqual({
      type: 'accelerator',
      accelerator: 'shift+super+KeyM',
    });
    expect(
      captureFromKeyboardEvent(key({ ctrlKey: true, shiftKey: true, key: 'K', code: 'KeyK' })),
    ).toEqual({
      type: 'accelerator',
      accelerator: 'shift+control+KeyK',
    });
  });

  it('waits while a modifier is held and ignores a repeated key', () => {
    expect(
      captureFromKeyboardEvent(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })),
    ).toEqual({
      type: 'pending',
    });
    expect(captureFromKeyboardEvent(key({ metaKey: true, shiftKey: true, repeat: true }))).toEqual({
      type: 'pending',
    });
  });

  it('cancels on Escape', () => {
    expect(captureFromKeyboardEvent(key({ key: 'Escape', code: 'Escape' }))).toEqual({
      type: 'cancel',
    });
  });

  it('refuses Shift alone and a bare letter', () => {
    const shiftOnly = captureFromKeyboardEvent(key({ shiftKey: true }));
    expect(shiftOnly).toMatchObject({ type: 'invalid' });
    if (shiftOnly.type === 'invalid') expect(shiftOnly.message).toMatch(/Shift alone/);
    expect(captureFromKeyboardEvent(key({}))).toMatchObject({ type: 'invalid' });
  });

  it('refuses a key the operating system shortcut parser does not know', () => {
    expect(
      captureFromKeyboardEvent(key({ ctrlKey: true, code: 'IntlRo', key: 'Ro' })),
    ).toMatchObject({
      type: 'invalid',
    });
  });
});

describe('formatAccelerator', () => {
  it('writes the macOS default the way the menu bar would', () => {
    expect(formatAccelerator('shift+super+KeyM', 'macos')).toBe('⌘⇧M');
  });

  it('writes Ctrl+Shift+M on Windows and Linux', () => {
    expect(formatAccelerator('shift+control+KeyM', 'windows')).toBe('Ctrl+Shift+M');
    expect(formatAccelerator('shift+control+KeyM', 'linux')).toBe('Ctrl+Shift+M');
  });

  it('labels the Windows key and punctuation', () => {
    expect(formatAccelerator('super+Digit1', 'windows')).toBe('Win+1');
    expect(formatAccelerator('alt+Slash', 'linux')).toBe('Alt+/');
  });
});

describe('validateAcceleratorInput', () => {
  it('accepts a modifier combo and refuses shift alone', () => {
    expect(validateAcceleratorInput('ctrl+shift+k')).toBeNull();
    expect(validateAcceleratorInput('shift+m')).toMatch(/Shift alone/);
    expect(validateAcceleratorInput('')).toMatch(/modifier/);
    expect(validateAcceleratorInput(`ctrl+${'a'.repeat(80)}`)).toMatch(/modifier/);
  });
});

describe('parseGlobalShortcutStatus', () => {
  it('reads the payload the native command returns', () => {
    expect(
      parseGlobalShortcutStatus({
        enabled: false,
        accelerator: 'shift+super+KeyM',
        registered: false,
        error: null,
        defaultAccelerator: 'shift+super+KeyM',
      }),
    ).toEqual({
      enabled: false,
      accelerator: 'shift+super+KeyM',
      registered: false,
      error: null,
      defaultAccelerator: 'shift+super+KeyM',
    });
  });

  it('drops a payload that is missing the combo', () => {
    expect(parseGlobalShortcutStatus({ enabled: true })).toBeNull();
    expect(parseGlobalShortcutStatus(null)).toBeNull();
    expect(parseGlobalShortcutStatus('shift+control+KeyM')).toBeNull();
  });
});

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(), emit: vi.fn() }));

describe('global shortcut commands', () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
  });

  it('reads and updates the shortcut through the allow-listed commands', async () => {
    const saved = {
      enabled: true,
      accelerator: 'shift+control+KeyM',
      registered: true,
      error: null,
      defaultAccelerator: 'shift+control+KeyM',
    };
    invoke.mockResolvedValueOnce(saved);
    const { getGlobalShortcut, setGlobalShortcut } =
      await import('../../src/utils/global-shortcut');
    await expect(getGlobalShortcut()).resolves.toEqual(saved);
    expect(invoke).toHaveBeenCalledWith('get_global_shortcut', undefined);

    invoke.mockResolvedValueOnce({ ...saved, enabled: false, registered: false });
    await setGlobalShortcut({ enabled: false });
    expect(invoke).toHaveBeenLastCalledWith('set_global_shortcut', {
      enabled: false,
      accelerator: null,
    });
  });

  it('does not call the backend for a shortcut that is only Shift', async () => {
    const { setGlobalShortcut } = await import('../../src/utils/global-shortcut');
    await expect(setGlobalShortcut({ enabled: true, accelerator: 'shift+m' })).rejects.toThrow(
      /Shift alone/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('surfaces a registration failure from the native side', async () => {
    invoke.mockRejectedValueOnce(
      "Couldn't register that shortcut. Another app may already be using it.",
    );
    const { setGlobalShortcut } = await import('../../src/utils/global-shortcut');
    await expect(setGlobalShortcut({ enabled: true, accelerator: 'ctrl+shift+m' })).rejects.toThrow(
      /Another app may already be using it/,
    );
  });
});
