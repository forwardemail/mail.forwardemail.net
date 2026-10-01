/**
 * The prompt shown when a message is encrypted with PGP and no private key
 * for it has been added: go to Settings to add one, or not now.
 */
import { DARK_SURFACE, LIGHT_SURFACE } from './dark-surface.ts';

export function createPgpModal({
  onConfirm,
  onClose,
}: {
  onConfirm?: () => void;
  onClose?: () => void;
}): () => void {
  if (typeof document === 'undefined') return () => {};

  const isLightMode = document.body.classList.contains('light-mode');

  const overlay = document.createElement('div');
  overlay.className = 'fe-modal-backdrop';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.background = 'rgba(0, 0, 0, 0.6)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '9999';
  overlay.style.padding = '16px';

  const dialog = document.createElement('div');
  dialog.className = 'fe-modal';

  // This dialog is built with inline styles, so it cannot read the app's CSS
  // custom properties. Both palettes come from dark-surface.ts.
  const palette = isLightMode ? LIGHT_SURFACE : DARK_SURFACE;
  dialog.style.background = palette.overlay;
  dialog.style.border = `1px solid ${palette.border}`;
  dialog.style.color = palette.text;

  dialog.style.borderRadius = '12px';
  dialog.style.padding = '18px';
  dialog.style.maxWidth = '500px';
  dialog.style.width = '96%';
  dialog.style.boxShadow = '0 30px 80px rgba(0, 0, 0, 0.4)';

  const headingColor = palette.text;
  const textColor = palette.textSubtle;

  // Built element by element, with lengths set through `style` rather than
  // an HTML string: the terminal client converts pixel lengths set that
  // way into cells, and one parsed from markup came out as 16 rows of
  // padding, which pushed the buttons off the screen.
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'fe-pgp-modal-title');
  const add = (
    parent: HTMLElement,
    tag: string,
    text: string,
    style: Partial<CSSStyleDeclaration>,
  ): HTMLElement => {
    const el = document.createElement(tag);
    el.textContent = text;
    Object.assign(el.style, style);
    parent.appendChild(el);
    return el;
  };
  const heading = add(dialog, 'h3', 'PGP encrypted message detected', {
    marginTop: '0',
    color: headingColor,
    fontSize: '18px',
    fontWeight: '600',
  });
  heading.id = 'fe-pgp-modal-title';
  add(dialog, 'p', 'You need to add a PGP private key to decrypt this message.', {
    margin: '8px 0 12px',
    color: textColor,
    lineHeight: '1.5',
  });
  add(dialog, 'p', 'Go to Settings > Accounts & Security to add a key now?', {
    margin: '0 0 16px',
    color: textColor,
    lineHeight: '1.5',
  });
  const actions = add(dialog, 'div', '', {
    display: 'flex',
    gap: '10px',
    justifyContent: 'flex-end',
  });
  const cancel = add(actions, 'button', 'Not now', {
    padding: '8px 16px',
    cursor: 'pointer',
  }) as HTMLButtonElement;
  cancel.type = 'button';
  cancel.className = 'fe-button ghost';
  cancel.dataset.role = 'cancel';
  const confirm = add(actions, 'button', 'Go to settings', {
    padding: '8px 16px',
    cursor: 'pointer',
  }) as HTMLButtonElement;
  confirm.type = 'button';
  confirm.className = 'fe-button';
  confirm.dataset.role = 'confirm';

  // Escape closes it, as it does every other dialog.
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
    onClose?.();
  };

  const cleanup = (): void => {
    document.removeEventListener('keydown', onKeydown, true);
    if (overlay && overlay.parentNode) {
      overlay.remove();
    }
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      cleanup();
      onClose?.();
    }
  });

  cancel.addEventListener('click', () => {
    cleanup();
    onClose?.();
  });
  confirm.addEventListener('click', () => {
    cleanup();
    onConfirm?.();
  });
  document.addEventListener('keydown', onKeydown, true);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  // Keyboard users start on the safe choice.
  cancel.focus();

  return cleanup;
}
