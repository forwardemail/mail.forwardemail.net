/**
 * Message list status icons. The replied and attachment icons had no label
 * at all: nothing on hover, nothing for a screen reader, and a tap on one
 * just opened the message. A status icon now names itself, shows its label
 * as a tooltip. On a touch screen a tap shows the label instead of opening
 * the message; with a mouse a click still opens or selects the row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import RowStatusIconsHost from './stubs/RowStatusIconsHost.svelte';

beforeEach(() => {
  vi.useFakeTimers();
});

const realMatchMedia = window.matchMedia;

// A touch screen: no hover.
function useTouchScreen() {
  window.matchMedia = ((query: string) => ({
    matches: query === '(hover: none)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

describe('<RowStatusIcons />', () => {
  it('labels the status icons and gives each a tooltip', () => {
    render(RowStatusIconsHost);

    const replied = screen.getByRole('img', { name: 'Replied to' });
    const attachments = screen.getByRole('img', { name: 'Has attachments' });
    expect(replied).toHaveAttribute('data-tooltip', 'Replied to');
    expect(attachments).toHaveAttribute('data-tooltip', 'Has attachments');
    // The svg inside is decoration; the wrapper carries the name.
    expect(replied.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows the label on a tap and does not open the message', async () => {
    useTouchScreen();
    const onOpen = vi.fn();
    render(RowStatusIconsHost, { props: { onOpen } });

    const replied = screen.getByRole('img', { name: 'Replied to' });
    expect(replied).not.toHaveAttribute('data-tooltip-open');

    await fireEvent.click(replied);
    expect(onOpen).not.toHaveBeenCalled();
    expect(replied).toHaveAttribute('data-tooltip-open');

    // A tap on another icon moves the label there.
    const attachments = screen.getByRole('img', { name: 'Has attachments' });
    await fireEvent.click(attachments);
    expect(onOpen).not.toHaveBeenCalled();
    expect(attachments).toHaveAttribute('data-tooltip-open');
    expect(replied).not.toHaveAttribute('data-tooltip-open');

    // The label goes away by itself.
    await vi.advanceTimersByTimeAsync(1500);
    expect(attachments).not.toHaveAttribute('data-tooltip-open');

    // The rest of the row still opens the message.
    await fireEvent.click(screen.getByTestId('message-row'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('lets a mouse click on a status icon reach the row', async () => {
    const onOpen = vi.fn();
    render(RowStatusIconsHost, { props: { onOpen } });

    const replied = screen.getByRole('img', { name: 'Replied to' });
    await fireEvent.click(replied);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(replied).not.toHaveAttribute('data-tooltip-open');
  });

  it('names the star action, toggles it, and does not open the message', async () => {
    const onOpen = vi.fn();
    render(RowStatusIconsHost, { props: { onOpen } });

    const star = screen.getByRole('button', { name: 'Star' });
    expect(star).toHaveAttribute('data-tooltip', 'Not starred');

    await fireEvent.click(star);
    expect(onOpen).not.toHaveBeenCalled();
    expect(star).toHaveAccessibleName('Unstar');
    expect(star).toHaveAttribute('data-tooltip', 'Starred');

    await fireEvent.click(star);
    expect(star).toHaveAccessibleName('Star');
    expect(star).toHaveAttribute('data-tooltip', 'Not starred');
  });
});
