import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

vi.mock('../../src/utils/tauri-bridge.js', () => ({
  triggerHaptic: vi.fn(),
}));

import BottomSheet from '../../src/svelte/components/BottomSheet.svelte';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

describe('<BottomSheet />', () => {
  it('renders nothing when closed', () => {
    const onClose = vi.fn();
    render(BottomSheet, { props: { open: false, title: 'Test', onClose } });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the title and actions when open', () => {
    const onA = vi.fn();
    const onB = vi.fn();
    render(BottomSheet, {
      props: {
        open: true,
        title: 'Actions',
        actions: [
          { label: 'Archive', onclick: onA },
          { label: 'Delete', variant: 'destructive', onclick: onB },
        ],
        onClose: vi.fn(),
      },
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('clicking an action invokes its handler and onClose', async () => {
    const onClose = vi.fn();
    const onArchive = vi.fn();
    render(BottomSheet, {
      props: {
        open: true,
        actions: [{ label: 'Archive', onclick: onArchive }],
        onClose,
      },
    });

    await fireEvent.click(screen.getByText('Archive'));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the sheet', async () => {
    const onClose = vi.fn();
    render(BottomSheet, {
      props: { open: true, actions: [], onClose },
    });

    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel button closes the sheet', async () => {
    const onClose = vi.fn();
    render(BottomSheet, {
      props: { open: true, actions: [], onClose },
    });

    await fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables the action button when the action is disabled', () => {
    render(BottomSheet, {
      props: {
        open: true,
        actions: [{ label: 'Send', onclick: vi.fn(), disabled: true }],
        onClose: vi.fn(),
      },
    });

    const btn = screen.getByText('Send').closest('button');
    expect(btn).toBeDisabled();
  });
});
