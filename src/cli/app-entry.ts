/**
 * The terminal build's app entry: the webmail's own main.ts, unchanged, plus
 * what the terminal needs from inside the app bundle.
 */
import '../main';
// @ts-expect-error -- a plain JS module without type declarations
import { keyboardShortcuts } from '../utils/keyboard-shortcuts.js';

// A terminal passes Ctrl to the app and keeps Cmd for itself, so shortcuts
// are shown (in the ? list, settings and the hint bar) with Ctrl on a Mac
// too. Both were bound already; this only changes how they are written.
keyboardShortcuts.isMac = false;

// The hint bar (src/cli/hints.ts) lists the current bindings, rebound ones
// included.
(globalThis as Record<string, unknown>).__forwardemailShortcuts = keyboardShortcuts;
