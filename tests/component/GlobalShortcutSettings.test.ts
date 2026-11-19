import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { GlobalShortcutStatus } from '../../src/utils/global-shortcut';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('../../src/utils/global-shortcut', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/global-shortcut')>(
    '../../src/utils/global-shortcut',
  );
  return {
    ...actual,
    getGlobalShortcut: () => api.get(),
    setGlobalShortcut: (input: { enabled: boolean; accelerator?: string }) => api.set(input),
  };
});

import GlobalShortcutSettings from '../../src/svelte/components/GlobalShortcutSettings.svelte';

const initial = (): GlobalShortcutStatus => ({
  enabled: true,
  accelerator: 'shift+control+KeyM',
  registered: true,
  error: null,
  defaultAccelerator: 'shift+control+KeyM',
});

describe('GlobalShortcutSettings', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the saved shortcut and turns it off', async () => {
    const saved = initial();
    api.get.mockImplementation(async () => ({ ...saved }));
    api.set.mockImplementation(async (input: { enabled: boolean; accelerator?: string }) => {
      saved.enabled = input.enabled;
      if (input.accelerator) saved.accelerator = input.accelerator;
      saved.registered = input.enabled;
      saved.error = null;
      return { ...saved };
    });

    render(GlobalShortcutSettings);
    expect(await screen.findByTestId('global-shortcut-combo')).toHaveTextContent('Ctrl+Shift+M');

    await fireEvent.click(
      screen.getByRole('checkbox', { name: 'Use a global shortcut to show Forward Email' }),
    );

    expect(api.set).toHaveBeenCalledWith({ enabled: false });
    expect(await screen.findByText(/turned off/)).toBeTruthy();
    expect(screen.getByText(/other apps keep Ctrl\+Shift\+M/)).toBeTruthy();
  });

  it('records a new combination and keeps Command separate from Ctrl', async () => {
    const saved = initial();
    api.get.mockImplementation(async () => ({ ...saved }));
    api.set.mockImplementation(async (input: { enabled: boolean; accelerator?: string }) => {
      saved.enabled = input.enabled;
      if (input.accelerator) saved.accelerator = input.accelerator;
      saved.registered = true;
      saved.error = null;
      return { ...saved };
    });

    render(GlobalShortcutSettings);
    await screen.findByTestId('global-shortcut-combo');
    await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await fireEvent.keyDown(window, { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true });

    expect(api.set).toHaveBeenCalledWith({
      enabled: true,
      accelerator: 'shift+control+KeyK',
    });
    expect(await screen.findByTestId('global-shortcut-combo')).toHaveTextContent('Ctrl+Shift+K');
  });

  it('does not save Shift alone', async () => {
    api.get.mockResolvedValue(initial());
    render(GlobalShortcutSettings);
    await screen.findByTestId('global-shortcut-combo');
    await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await fireEvent.keyDown(window, { key: 'M', code: 'KeyM', shiftKey: true });

    expect(api.set).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Shift alone/);
    expect(screen.getByTestId('global-shortcut-combo')).toHaveTextContent('Ctrl+Shift+M');
  });

  it('leaves the previous shortcut in place when registration fails', async () => {
    api.get.mockResolvedValue(initial());
    api.set.mockRejectedValue(
      new Error("Couldn't register that shortcut. Another app may already be using it."),
    );

    render(GlobalShortcutSettings);
    await screen.findByTestId('global-shortcut-combo');
    await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await fireEvent.keyDown(window, { key: 'K', code: 'KeyK', metaKey: true, shiftKey: true });

    expect(api.set).toHaveBeenCalledWith({
      enabled: true,
      accelerator: 'shift+super+KeyK',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Another app may already be using it/,
    );
    expect(screen.getByTestId('global-shortcut-combo')).toHaveTextContent('Ctrl+Shift+M');
  });

  it('restores the shipped default', async () => {
    const saved = initial();
    saved.accelerator = 'shift+control+KeyK';
    api.get.mockResolvedValue({ ...saved });
    api.set.mockImplementation(async (input: { enabled: boolean; accelerator?: string }) => ({
      ...saved,
      enabled: input.enabled,
      accelerator: input.accelerator ?? saved.accelerator,
      registered: true,
      error: null,
    }));

    render(GlobalShortcutSettings);
    expect(await screen.findByTestId('global-shortcut-combo')).toHaveTextContent('Ctrl+Shift+K');
    await fireEvent.click(screen.getByRole('button', { name: 'Use default' }));

    expect(api.set).toHaveBeenCalledWith({
      enabled: true,
      accelerator: 'shift+control+KeyM',
    });
  });

  it('shows a shortcut that was saved but could not be registered at launch', async () => {
    api.get.mockResolvedValue({
      ...initial(),
      registered: false,
      error: "Couldn't register that shortcut. Another app may already be using it.",
    });

    render(GlobalShortcutSettings);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Another app may already be using it/,
    );
    expect(screen.getByRole('button', { name: 'Use default' })).toBeEnabled();
  });
});
