import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPgpModal } from '../../src/utils/pgp-key-prompt';

afterEach(() => {
  document.body.innerHTML = '';
});

const dialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement | null;

describe('the missing PGP key prompt', () => {
  it('is a labelled modal dialog with the safe choice focused', () => {
    createPgpModal({});
    const el = dialog();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(el!.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('PGP encrypted message detected');
    expect(document.activeElement?.textContent).toBe('Not now');
  });

  it('closes with Escape, as other dialogs do', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    createPgpModal({ onClose, onConfirm });
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(dialog()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    // Gone for good: a later Escape is someone else's.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('runs the chosen action from its buttons', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    createPgpModal({ onClose, onConfirm });
    const go = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Go to settings',
    )!;
    go.click();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
  });
});
