/**
 * The hint bar: one row at the bottom of the terminal with the keys for
 * what is on screen, the way terminal mail programs show them.
 *
 *   r Reply  a Reply all  f Forward  e Archive  s Star  Del Delete  ? Shortcuts
 *
 * The keys are read from the webmail's own shortcut manager, so a shortcut
 * rebound in Settings › Keyboard Shortcuts shows its new key here at once.
 * Clicking a hint presses its key. The ? list ends with a way to the
 * settings page where shortcuts are changed.
 */
import type { AnyRecord } from './types';

interface Hint {
  keys: string;
  label: string;
  // Pressed when the hint is clicked: terminal input, or an action.
  press?: string | null;
  run?: () => void;
}

interface Shortcut {
  key: string;
  action: string;
  sequence?: boolean;
}

interface ShortcutManager {
  getShortcutsList(): Shortcut[];
  captureInProgress?: boolean;
}

// What a terminal sends for a named key.
const KEY_BYTES: Record<string, string> = {
  esc: '\x1b',
  enter: '\r',
  tab: '\t',
  space: ' ',
  delete: '\x1b[3~',
  backspace: '\x7f',
  '↑': '\x1b[A',
  '↓': '\x1b[B',
  '→': '\x1b[C',
  '←': '\x1b[D',
  f5: '\x1b[15~',
};

const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'option', 'cmd', 'meta']);

function splitCombo(combo: string): { mods: Set<string>; key: string } {
  const parts = combo
    .toLowerCase()
    .split(/\s*\+\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const mods = new Set(parts.filter((part) => MODIFIERS.has(part)));
  const key = parts.filter((part) => !MODIFIERS.has(part)).pop() ?? '';
  return { mods, key };
}

/** The bytes a terminal sends for a shortcut, or null if it cannot. */
export function bytesFor(combo: string): string | null {
  if (combo === '?') return '?';
  const { mods, key } = splitCombo(combo);
  if (!key || mods.has('alt') || mods.has('option') || mods.has('cmd') || mods.has('meta')) {
    return null;
  }
  if (mods.has('ctrl')) {
    // Ctrl+H, I, J and M are the same bytes as Backspace, Tab, Enter.
    return !mods.has('shift') && /^[a-z]$/.test(key) && !'hijm'.includes(key)
      ? String.fromCharCode(key.charCodeAt(0) - 96)
      : null;
  }
  if (key === 'tab' && mods.has('shift')) return '\x1b[Z';
  if (key.length === 1) return mods.has('shift') ? key.toUpperCase() : key;
  return mods.has('shift') ? null : (KEY_BYTES[key] ?? null);
}

/** A shortcut as the hint bar writes it: Ctrl+N, Shift+R, Del, r. */
export function displayCombo(combo: string): string {
  if (combo === '?') return '?';
  const { mods, key } = splitCombo(combo);
  const name =
    key === 'delete'
      ? 'Del'
      : key === 'esc' || key === 'enter' || key === 'tab' || /^f\d+$/.test(key)
        ? key[0].toUpperCase() + key.slice(1)
        : mods.size > 0 && key.length === 1
          ? key.toUpperCase()
          : key;
  const prefix = ['ctrl', 'shift', 'alt']
    .filter((mod) => mods.has(mod))
    .map((mod) => `${mod[0].toUpperCase()}${mod.slice(1)}+`)
    .join('');
  return `${prefix}${name}`;
}

const ACTION_LABELS: Record<string, string> = {
  'new-message': 'New',
  reply: 'Reply',
  'reply-all': 'Reply all',
  forward: 'Forward',
  archive: 'Archive',
  star: 'Star',
  'toggle-read': 'Read/unread',
  delete: 'Delete',
  'mark-junk': 'Junk',
  'quick-filter': 'Search',
  refresh: 'Refresh',
  'save-draft': 'Save draft',
  help: 'Shortcuts',
};

function isShown(el: AnyRecord | null): boolean {
  const rect = el?.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function installHints(win: AnyRecord, options: { columns: () => number }) {
  const document = win.document as AnyRecord;
  const manager = () =>
    (globalThis as Record<string, unknown>).__forwardemailShortcuts as ShortcutManager | undefined;

  // The current key for an action, as rebound by the user.
  const keyFor = (action: string): string | null => {
    const keys = (manager()?.getShortcutsList() ?? [])
      .filter((shortcut) => shortcut.action === action && !shortcut.sequence)
      .map((shortcut) => shortcut.key)
      .sort((a, b) => a.length - b.length);
    return keys[0] ?? null;
  };
  const action = (name: string, label = ACTION_LABELS[name] ?? name): Hint | null => {
    const combo = keyFor(name);
    return combo ? { keys: displayCombo(combo), label, press: bytesFor(combo) } : null;
  };
  const key = (keys: string, label: string, combo = keys.toLowerCase()): Hint => ({
    keys,
    label,
    press: bytesFor(combo),
  });

  // Settings › Keyboard Shortcuts, through the app's router.
  // The shortcut list is closed first (with Esc, as by hand), so it is not
  // still open when the user comes back.
  const openShortcutSettings = () => {
    process.stdin.emit('data', Buffer.from('\x1b'));
    setTimeout(goToShortcutSettings, 100);
  };
  const goToShortcutSettings = () => {
    win.history.pushState({}, '', '/mailbox/settings#shortcuts');
    win.dispatchEvent(new win.Event('popstate'));
    let tries = 0;
    const timer = setInterval(() => {
      const tab = [...document.querySelectorAll('button')].find(
        (button: AnyRecord) => button.textContent.trim() === 'Keyboard Shortcuts',
      );
      if (tab || ++tries > 50) clearInterval(timer);
      tab?.click();
    }, 100);
    timer.unref?.();
  };

  const hintsForScreen = (): Hint[] => {
    const shortcuts = action('help') ?? key('?', 'Shortcuts');
    const quit = key('Ctrl+C', 'Quit');
    const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(
      (el: AnyRecord) => isShown(el) && !el.closest('[data-testid="compose-modal"]'),
    );

    if (manager()?.captureInProgress) {
      return [{ keys: '', label: 'Press the new key for this shortcut' }, key('Esc', 'Cancel')];
    }
    if (dialog?.textContent.includes('Keyboard shortcuts')) {
      return [
        key('Esc', 'Close'),
        { keys: '⚙', label: 'Change keys in Settings', run: openShortcutSettings },
      ];
    }
    if (dialog) return [key('Esc', 'Close'), key('Tab', 'Next'), key('Enter', 'Choose')];
    // Settings › Keyboard Shortcuts.
    const reset = [...document.querySelectorAll('button')].find(
      (button: AnyRecord) => button.textContent.trim() === 'Reset to defaults' && isShown(button),
    );
    if (reset) {
      return [
        { keys: 'Edit', label: 'then press the new key to change a shortcut' },
        key('Tab', 'Next'),
        key('Esc', 'Back'),
        quit,
      ];
    }
    if (!document.body?.classList.contains('mailbox-mode')) {
      return [key('Tab', 'Next field'), key('Enter', 'Sign in'), quit];
    }
    if (isShown(document.querySelector('[data-testid="compose-modal"]'))) {
      return [
        key('Tab', 'Next field'),
        key('Shift+Tab', 'Previous', 'shift + tab'),
        action('save-draft'),
        quit,
      ].filter(Boolean) as Hint[];
    }
    if (isShown(document.querySelector('button[aria-label="Back to list"]'))) {
      return [
        key('Esc', 'Back'),
        action('reply'),
        action('reply-all'),
        action('forward'),
        action('archive'),
        action('star'),
        action('toggle-read'),
        action('delete'),
        shortcuts,
        quit,
      ].filter(Boolean) as Hint[];
    }
    if (isShown(document.querySelector('[role="listbox"][aria-label="Conversations"]'))) {
      return [
        { keys: '↑↓', label: 'Open' },
        action('new-message'),
        action('reply'),
        action('archive'),
        action('star'),
        action('delete'),
        action('quick-filter'),
        shortcuts,
        quit,
      ].filter(Boolean) as Hint[];
    }
    return [key('Esc', 'Back'), key('Tab', 'Next'), key('Enter', 'Choose'), shortcuts, quit];
  };

  const bar = document.createElement('div');
  bar.id = 'fe-terminal-hints';
  bar.setAttribute('aria-hidden', 'true');
  let shown: Hint[] = [];
  let html = '';

  // A short notice in place of the hints ("Copied"), from other modules.
  let notice: string | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  win.addEventListener('fe-terminal-notice', (event: AnyRecord) => {
    notice = String(event.detail ?? '');
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = null;
      render();
    }, 2000);
    noticeTimer.unref?.();
    render();
  });

  // Tooltips: a terminal cannot float them over the controls around, so the
  // label of the control under the pointer (its tooltip, else its
  // aria-label or title) takes the bar while the pointer is on it.
  let hovered: AnyRecord | null = null;
  const labelOf = (target: AnyRecord | null): string | null => {
    const control = target?.closest?.(
      '[data-slot="tooltip-trigger"], button, a[href], [role="button"]',
    );
    if (!control || !control.isConnected || bar.contains(control)) return null;
    const content = [...document.querySelectorAll('[data-slot="tooltip-content"]')]
      .map((el: AnyRecord) => el.textContent.trim())
      .find(Boolean);
    const label = (
      content ||
      control.getAttribute('aria-label') ||
      control.getAttribute('title') ||
      ''
    ).trim();
    // A label the control already shows in full adds nothing.
    if (!label || control.textContent.trim() === label) return null;
    return label;
  };
  win.addEventListener(
    'mouseover',
    (event: AnyRecord) => {
      if (event.target === hovered) return;
      hovered = event.target;
      render();
    },
    true,
  );

  const render = () => {
    const width = options.columns();
    const tooltip = hovered ? labelOf(hovered) : null;
    const hints: Hint[] = notice
      ? [{ keys: '✓', label: notice }]
      : tooltip
        ? [{ keys: '', label: tooltip }]
        : hintsForScreen();
    // As many as fit, keeping the shortcut list's hint when anything is cut.
    const fitted: Hint[] = [];
    let used = 1;
    for (const hint of hints) {
      const size = (hint.keys ? hint.keys.length + 1 : 0) + hint.label.length + 3;
      if (used + size > width) break;
      fitted.push(hint);
      used += size;
    }
    const help = hints.find((hint) => hint.label === 'Shortcuts');
    if (help && !fitted.includes(help) && fitted.length > 0) fitted[fitted.length - 1] = help;
    const next = fitted
      .map(
        (hint, index) =>
          `<span class="fe-hint" data-hint="${index}">${
            hint.keys ? `<span class="fe-hint-key">${escapeHtml(hint.keys)}</span> ` : ''
          }${escapeHtml(hint.label)}</span>`,
      )
      .join('');
    shown = fitted;
    if (next !== html) {
      html = next;
      bar.innerHTML = next;
    }
  };

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      render();
    }, 120);
  };

  // A press on the bar must not take the focus from the field the key is
  // for (Tab from the To field, Save draft from the editor).
  bar.addEventListener('mousedown', (event: AnyRecord) => event.preventDefault());
  bar.addEventListener('click', (event: AnyRecord) => {
    const index = Number(event.target?.closest?.('[data-hint]')?.getAttribute('data-hint'));
    const hint = shown[index];
    if (!hint) return;
    if (hint.run) hint.run();
    else if (hint.press) process.stdin.emit('data', Buffer.from(hint.press));
  });

  document.documentElement.classList.add('fe-has-hints');
  document.documentElement.append(bar);
  new win.MutationObserver((records: AnyRecord[]) => {
    if (records.every((record) => bar.contains(record.target))) return;
    schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
  for (const type of ['focusin', 'keyup', 'resize']) win.addEventListener(type, schedule, true);
  render();
}
