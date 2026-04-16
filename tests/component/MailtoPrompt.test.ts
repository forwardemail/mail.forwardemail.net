import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';

const hoisted = vi.hoisted(() => ({
  shouldShow: vi.fn(),
  register: vi.fn(),
  markShown: vi.fn(),
}));

vi.mock('../../src/utils/mailto-handler.js', () => ({
  shouldShowMailtoPrompt: (...a: unknown[]) => hoisted.shouldShow(...a),
  registerAsMailtoHandler: (...a: unknown[]) => hoisted.register(...a),
  markPromptShown: (...a: unknown[]) => hoisted.markShown(...a),
}));

import MailtoPrompt from '../../src/svelte/components/MailtoPrompt.svelte';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<MailtoPrompt />', () => {
  it('does not show the prompt when shouldShowMailtoPrompt returns false', async () => {
    hoisted.shouldShow.mockReturnValue(false);
    render(MailtoPrompt, { props: { account: 'me@example.com' } });

    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the prompt after the 2s delay when the helper says so', async () => {
    hoisted.shouldShow.mockReturnValue(true);
    render(MailtoPrompt, { props: { account: 'me@example.com' } });

    // Not visible yet
    expect(screen.queryByRole('alert')).toBeNull();

    await vi.advanceTimersByTimeAsync(2000);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set as default/i })).toBeInTheDocument();
  });

  it('clicking "Set as default" registers and dismisses', async () => {
    hoisted.shouldShow.mockReturnValue(true);
    hoisted.register.mockResolvedValue({ method: 'native' });

    render(MailtoPrompt, { props: { account: 'me@example.com' } });
    await vi.advanceTimersByTimeAsync(2000);

    await fireEvent.click(screen.getByRole('button', { name: /set as default/i }));
    // Let the awaited promise settle.
    await vi.runAllTimersAsync();

    expect(hoisted.register).toHaveBeenCalledTimes(1);
    expect(hoisted.markShown).toHaveBeenCalledWith('me@example.com');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('macOS sandbox path shows instructions inline and keeps the prompt visible', async () => {
    hoisted.shouldShow.mockReturnValue(true);
    hoisted.register.mockResolvedValue({
      method: 'open_mail_settings',
      message: 'Open System Settings → Mail',
    });

    render(MailtoPrompt, { props: { account: 'me@example.com' } });
    await vi.advanceTimersByTimeAsync(2000);

    await fireEvent.click(screen.getByRole('button', { name: /set as default/i }));
    await vi.runAllTimersAsync();

    expect(screen.getByText(/Open System Settings/)).toBeInTheDocument();
    // Alert remains visible so user can follow the instruction.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Dismiss marks the prompt shown and hides', async () => {
    hoisted.shouldShow.mockReturnValue(true);
    render(MailtoPrompt, { props: { account: 'me@example.com' } });
    await vi.advanceTimersByTimeAsync(2000);

    await fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(hoisted.markShown).toHaveBeenCalledWith('me@example.com');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
