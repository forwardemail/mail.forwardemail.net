/**
 * Desktop shortcut that opens or focuses Forward Email from any other app.
 *
 * The native side (src-tauri/src/global_shortcut.rs) owns registration and the
 * saved choice. This module turns a key the user presses into the accelerator
 * string that side accepts, and formats the saved combo for the settings page.
 * Command and Ctrl stay distinct: the in-app shortcut manager folds both into
 * "ctrl", which would make it impossible to tell Chrome's Command+Shift+M
 * from Ctrl+Shift+M.
 */

import { isTauri, invoke } from './tauri-bridge.js';

/** What "Reset" sends. The native side maps this to Command on macOS and Ctrl elsewhere. */
export const DEFAULT_ACCELERATOR_INPUT = 'CommandOrControl+Shift+KeyM';

export type ShortcutPlatform = 'macos' | 'windows' | 'linux';

export interface GlobalShortcutStatus {
  enabled: boolean;
  accelerator: string;
  registered: boolean;
  error: string | null;
  defaultAccelerator: string;
}

export interface ShortcutKeyEvent {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}

export type ShortcutCapture =
  | { type: 'pending' }
  | { type: 'cancel' }
  | { type: 'accelerator'; accelerator: string }
  | { type: 'invalid'; message: string };

const MODIFIER_REQUIRED =
  'Include Ctrl, Alt, or the Command key. Shift alone would block normal typing.';

const UNSUPPORTED_KEY = 'That key cannot be used as a global shortcut.';

const NAMED_CODES = [
  'Backquote',
  'Backslash',
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Equal',
  'Minus',
  'Period',
  'Quote',
  'Semicolon',
  'Slash',
  'Backspace',
  'CapsLock',
  'Enter',
  'Space',
  'Tab',
  'Delete',
  'End',
  'Home',
  'Insert',
  'PageDown',
  'PageUp',
  'PrintScreen',
  'ScrollLock',
  'Pause',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'NumLock',
  'NumpadAdd',
  'NumpadDecimal',
  'NumpadDivide',
  'NumpadEnter',
  'NumpadEqual',
  'NumpadMultiply',
  'NumpadSubtract',
  'Escape',
  'AudioVolumeDown',
  'AudioVolumeUp',
  'AudioVolumeMute',
  'MediaPlay',
  'MediaPause',
  'MediaPlayPause',
  'MediaStop',
  'MediaTrackNext',
  'MediaTrackPrevious',
];

const SUPPORTED_CODES = new Set<string>(NAMED_CODES);

for (let code = 65; code <= 90; code += 1) {
  SUPPORTED_CODES.add(`Key${String.fromCharCode(code)}`);
}
for (let digit = 0; digit <= 9; digit += 1) {
  SUPPORTED_CODES.add(`Digit${digit}`);
  SUPPORTED_CODES.add(`Numpad${digit}`);
}
for (let fn = 1; fn <= 24; fn += 1) {
  SUPPORTED_CODES.add(`F${fn}`);
}

const CODE_LABELS: Record<string, string> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
  Space: 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
};

const DISPLAY_MODIFIERS = ['super', 'control', 'alt', 'shift'] as const;

function labelForCode(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return `Num ${numpad[1]}`;
  const fn = /^F\d{1,2}$/.exec(code);
  if (fn) return code;
  return code;
}

function modifierLabel(modifier: (typeof DISPLAY_MODIFIERS)[number], platform: ShortcutPlatform) {
  if (platform === 'macos') {
    return { super: '⌘', control: '⌃', alt: '⌥', shift: '⇧' }[modifier];
  }
  return {
    super: platform === 'windows' ? 'Win' : 'Super',
    control: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
  }[modifier];
}

/**
 * A saved accelerator as a person would read it. `shift+super+KeyM` is ⌘⇧M
 * on macOS and Super+Shift+M on Linux.
 */
export function formatAccelerator(
  accelerator: string,
  platform: ShortcutPlatform = 'linux',
): string {
  const tokens = accelerator
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return '';

  const key = tokens[tokens.length - 1];
  const modifiers = new Set(tokens.slice(0, -1).map((token) => token.toLowerCase()));
  if (modifiers.has('meta') || modifiers.has('command') || modifiers.has('cmd')) {
    modifiers.add('super');
  }
  if (modifiers.has('ctrl') || modifiers.has('cmdorctrl') || modifiers.has('commandorcontrol')) {
    modifiers.add('control');
  }
  if (modifiers.has('option')) modifiers.add('alt');

  const labels = DISPLAY_MODIFIERS.filter((modifier) => modifiers.has(modifier)).map((modifier) =>
    modifierLabel(modifier, platform),
  );
  labels.push(labelForCode(key));

  if (platform === 'macos') return labels.join('');
  return labels.join('+');
}

/**
 * The next key of a shortcut the user is recording.
 * A bare modifier reports `pending` so the listener keeps waiting.
 * Escape reports `cancel`.
 */
export function captureFromKeyboardEvent(event: ShortcutKeyEvent): ShortcutCapture {
  if (event.repeat) return { type: 'pending' };
  if (event.key === 'Escape' || event.code === 'Escape') return { type: 'cancel' };
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(event.key)) return { type: 'pending' };

  if (!SUPPORTED_CODES.has(event.code)) return { type: 'invalid', message: UNSUPPORTED_KEY };
  if (!event.ctrlKey && !event.altKey && !event.metaKey) {
    return { type: 'invalid', message: MODIFIER_REQUIRED };
  }

  // Same order the native canonical form uses: shift, control, alt, super.
  const parts: string[] = [];
  if (event.shiftKey) parts.push('shift');
  if (event.ctrlKey) parts.push('control');
  if (event.altKey) parts.push('alt');
  if (event.metaKey) parts.push('super');
  parts.push(event.code);
  return { type: 'accelerator', accelerator: parts.join('+') };
}

export function validateAcceleratorInput(accelerator: string): string | null {
  if (typeof accelerator !== 'string') return 'Enter a shortcut.';
  const trimmed = accelerator.trim();
  if (!trimmed || trimmed.length > 80) return 'Enter a shortcut with a modifier and one key.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return 'That shortcut contains an unsupported character.';
  }
  if (
    !/(ctrl|control|alt|option|super|meta|cmd|command|cmdorctrl|commandorcontrol)/i.test(trimmed)
  ) {
    return MODIFIER_REQUIRED;
  }
  return null;
}

export function parseGlobalShortcutStatus(value: unknown): GlobalShortcutStatus | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== 'boolean') return null;
  if (typeof record.accelerator !== 'string' || record.accelerator.length === 0) return null;
  const defaultAccelerator =
    typeof record.defaultAccelerator === 'string' && record.defaultAccelerator
      ? record.defaultAccelerator
      : DEFAULT_ACCELERATOR_INPUT;
  return {
    enabled: record.enabled,
    accelerator: record.accelerator,
    registered: record.registered === true,
    error: typeof record.error === 'string' && record.error ? record.error : null,
    defaultAccelerator,
  };
}

function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return fallback;
}

export async function getGlobalShortcut(): Promise<GlobalShortcutStatus | null> {
  if (!isTauri()) return null;
  try {
    return parseGlobalShortcutStatus(await invoke('get_global_shortcut'));
  } catch (err) {
    throw new Error(errorMessage(err, "Couldn't read the global shortcut."));
  }
}

export async function setGlobalShortcut(input: {
  enabled: boolean;
  accelerator?: string;
}): Promise<GlobalShortcutStatus> {
  if (!isTauri()) {
    throw new Error('Global shortcuts are only available in the desktop app.');
  }
  if (typeof input.enabled !== 'boolean') {
    throw new Error('Enter a shortcut with a modifier and one key.');
  }
  if (input.accelerator !== undefined) {
    const problem = validateAcceleratorInput(input.accelerator);
    if (problem) throw new Error(problem);
  }

  let result: unknown;
  try {
    result = await invoke('set_global_shortcut', {
      enabled: input.enabled,
      accelerator: input.accelerator ?? null,
    });
  } catch (err) {
    throw new Error(errorMessage(err, "Couldn't update the global shortcut."));
  }

  const status = parseGlobalShortcutStatus(result);
  if (!status) throw new Error("Couldn't update the global shortcut.");
  return status;
}
