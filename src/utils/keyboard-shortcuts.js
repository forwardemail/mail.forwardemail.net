/**
 * Keyboard Shortcuts Manager
 * Based on Thunderbird's keyboard shortcuts design
 * Context-aware, customizable, with Mac/Windows support
 * Now powered by hotkeys-js for binding and capture support.
 */

import hotkeys from 'hotkeys-js';

const STORAGE_KEY = 'keyboard_shortcuts';

// Default keyboard shortcuts (Gmail-inspired set for better UX)
const DEFAULT_SHORTCUTS = {
  // Common / Message-level
  'ctrl+n': { action: 'new-message', label: 'New message' },
  'ctrl+m': { action: 'new-message', label: 'New message' },
  r: { action: 'reply', label: 'Reply to sender' },
  a: { action: 'reply-all', label: 'Reply All' },
  'shift+r': { action: 'reply-list', label: 'Reply to list' },
  f: { action: 'forward', label: 'Forward message' },
  'ctrl+s': { action: 'save-draft', label: 'Save draft' },
  'ctrl+p': { action: 'print', label: 'Print message or draft' },

  // Receiving / Reading / Navigation
  f5: { action: 'refresh', label: 'Get new messages (current account)' },
  // F5-only is awkward on Mac keyboards (needs a dedicated key or Fn+F5),
  // and unlike refresh-all, refresh has no ctrl-based alternate that would
  // auto-gain a cmd+ variant on Mac, so give it one explicitly.
  'ctrl+shift+u': { action: 'refresh', label: 'Get new messages (current account)' },
  'shift+f5': { action: 'refresh-all', label: 'Get new messages (all accounts)' },
  'ctrl+shift+y': { action: 'refresh-all', label: 'Get new messages (all accounts)' },
  arrowright: { action: 'expand-thread', label: 'Expand collapsed thread' },
  arrowleft: { action: 'collapse-thread', label: 'Collapse thread' },
  arrowdown: { action: 'next-message', label: 'Select next message', context: 'list' },
  arrowup: { action: 'previous-message', label: 'Select previous message', context: 'list' },

  // Managing / Marking / Deleting / Tagging
  m: { action: 'toggle-read', label: 'Mark message read/unread' },
  'shift+i': { action: 'mark-thread-read', label: 'Mark thread as read' },
  'shift+c': { action: 'mark-folder-read', label: 'Mark all messages read in folder' },
  j: { action: 'mark-junk', label: 'Mark as Junk' },
  'shift+j': { action: 'mark-not-junk', label: 'Mark as Not Junk' },
  s: { action: 'star', label: 'Add / remove star' },
  e: { action: 'archive', label: 'Archive message' },
  delete: { action: 'delete', label: 'Delete message' },
  'shift+delete': { action: 'delete-permanent', label: 'Delete bypassing Trash' },

  // Search & Filter
  'ctrl+k': { action: 'quick-filter', label: 'Quick Filter / folder search' },
  'ctrl+f': { action: 'find-in-message', label: 'Find text in current message' },
  'ctrl+shift+k': { action: 'quick-filter-advanced', label: 'Quick-filter messages in folder' },

  // Other useful
  // Bound as shift+/ rather than the literal '?' character: hotkeys-js
  // resolves a bare '?' binding to a fallback char code that never matches
  // what an actual Shift+/ keypress dispatches, so it would never fire.
  // formatKey() below displays this back as "?".
  'shift+/': { action: 'help', label: 'Show keyboard shortcuts' },
};

// US-layout shifted symbol -> the physical/base key that produces it.
// hotkeys-js resolves bindings by physical key + modifier flags, not by the
// shifted character itself, so a captured combo must use the base key here
// (with "shift" added as a modifier) or the binding silently never fires —
// the same bug that affected the default '?' (shift+/) shortcut above.
const SHIFTED_SYMBOL_TO_BASE = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
};

class KeyboardShortcutManager {
  constructor() {
    this.shortcuts = { ...DEFAULT_SHORTCUTS };
    this.handlers = new Map();
    this.context = 'default'; // default, list, compose, reader
    this.enabled = true;
    this.sequenceBuffer = [];
    this.sequenceTimeout = null;
    this.isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    this.boundHandlers = new Map();
    this.captureHandler = null;
    this.captureInProgress = false;
    this.sequenceListener = null;

    this.configureFilter();
    this.loadCustomShortcuts();
    this.bindShortcuts();
    this.bindSequenceListener();
  }

  /**
   * Load custom shortcuts from localStorage
   */
  loadCustomShortcuts() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const custom = JSON.parse(stored);
        const normalizedCustom = {};
        Object.entries(custom).forEach(([combo, definition]) => {
          normalizedCustom[this.normalizeShortcut(combo)] = definition;
        });
        this.shortcuts = { ...DEFAULT_SHORTCUTS, ...normalizedCustom };
      }
    } catch (error) {
      console.error('Failed to load custom shortcuts:', error);
    }
  }

  /**
   * Save custom shortcuts to localStorage
   */
  saveCustomShortcuts() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.shortcuts));
    } catch (error) {
      console.error('Failed to save custom shortcuts:', error);
    }
  }

  /**
   * Register a handler for a specific action
   */
  on(action, handler) {
    this.handlers.set(action, handler);
  }

  /**
   * Unregister a handler
   */
  off(action) {
    this.handlers.delete(action);
  }

  /**
   * Set the current context (list, compose, reader, etc.)
   */
  setContext(context) {
    this.context = context;
  }

  /**
   * Enable or disable shortcuts globally
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * Configure global filter so hotkeys-js ignores normal inputs but still
   * allows capture fields and modifier-based shortcuts.
   */
  configureFilter() {
    hotkeys.filter = (event) => {
      const target = event.target;
      if (!target) return true;

      // Allow capture fields to see every key
      if (target.closest?.('[data-shortcut-capture="true"]')) {
        return true;
      }

      const tagName = (target.tagName || '').toLowerCase();
      const isEditable =
        target.isContentEditable || target.getAttribute?.('contenteditable') === 'true';

      if (tagName === 'input' || tagName === 'textarea' || isEditable) {
        // Permit modifier combos (e.g., ctrl/cmd+enter) but ignore plain typing
        return Boolean(event.ctrlKey || event.metaKey || event.altKey);
      }

      return true;
    };
  }

  /**
   * Normalize a shortcut string (used for storage, comparison, and capture)
   */
  normalizeShortcut(shortcut) {
    if (!shortcut) return '';
    const trimmed = shortcut.toLowerCase().trim();
    const parts = trimmed
      .split(' ')
      .filter(Boolean)
      .map((part) => part.replace(/\s*\+\s*/g, '+').replace(/\b(meta|cmd|command)\b/g, 'ctrl'));
    return parts.join(' ');
  }

  /**
   * Check if an element should ignore keyboard shortcuts
   */
  shouldIgnoreEvent(event) {
    const target = event.target;
    if (!target) return false;
    if (target.closest?.('[data-shortcut-capture="true"]')) return false;

    const tagName = (target.tagName || '').toLowerCase();
    const isEditable =
      target.isContentEditable || target.getAttribute?.('contenteditable') === 'true';

    if (tagName === 'input' || tagName === 'textarea' || isEditable) {
      // Let ctrl/cmd/alt based shortcuts through for compose/send, block plain typing
      return !(event.ctrlKey || event.metaKey || event.altKey);
    }

    return false;
  }

  /**
   * Bind all non-sequence shortcuts through hotkeys-js
   */
  bindShortcuts() {
    this.unbindShortcuts();

    Object.entries(this.shortcuts).forEach(([combo, shortcut]) => {
      if (shortcut.sequence) return; // handled by sequence listener
      const normalizedCombo = this.normalizeShortcut(combo);
      const handler = (event) => {
        if (!this.enabled || this.captureInProgress) return;
        if (this.shouldIgnoreEvent(event)) return;
        if (shortcut.context && shortcut.context !== this.context) return;

        const actionHandler = this.handlers.get(shortcut.action);
        if (actionHandler) {
          event.preventDefault();
          event.stopPropagation();
          try {
            actionHandler(event);
          } catch (error) {
            console.error('Keyboard shortcut handler error:', error);
          }
        }
      };

      const combosToBind = new Set([normalizedCombo]);
      if (this.isMac && normalizedCombo.includes('ctrl')) {
        combosToBind.add(normalizedCombo.replace(/ctrl/g, 'command'));
      }

      // Add delete/backspace/del aliases so delete keys work across keyboards/browsers
      const parts = normalizedCombo.split('+');
      const last = parts[parts.length - 1];
      if (['delete', 'del', 'backspace'].includes(last)) {
        ['delete', 'del', 'backspace'].forEach((alias) => {
          const nextParts = [...parts];
          nextParts[nextParts.length - 1] = alias;
          combosToBind.add(nextParts.join('+'));
        });
      }

      combosToBind.forEach((comboKey) => {
        hotkeys(comboKey, { keyup: false }, handler);
        this.boundHandlers.set(comboKey, handler);
      });
    });
  }

  /**
   * Hotkeys-js doesn't have native sequence buffering, so we keep a lightweight
   * listener for space-delimited sequences (e.g., "g i").
   */
  bindSequenceListener() {
    if (this.sequenceListener) {
      hotkeys.unbind('*', this.sequenceListener);
    }

    this.sequenceListener = (event) => {
      if (!this.enabled || this.captureInProgress) return;
      if (this.shouldIgnoreEvent(event)) return;

      const matched = this.handleSequence(event);
      if (matched) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    hotkeys('*', { keyup: false }, this.sequenceListener);
  }

  /**
   * Remove all non-sequence bindings
   */
  unbindShortcuts() {
    this.boundHandlers.forEach((handler, combo) => {
      hotkeys.unbind(combo, handler);
    });
    this.boundHandlers.clear();
  }

  /**
   * Handle sequence shortcuts (e.g., 'g i' for goto inbox)
   */
  handleSequence(event) {
    // Clear timeout if exists
    if (this.sequenceTimeout) {
      clearTimeout(this.sequenceTimeout);
    }

    // Add key to sequence buffer
    this.sequenceBuffer.push(event.key.toLowerCase());

    // Set timeout to clear buffer (1 second)
    this.sequenceTimeout = setTimeout(() => {
      this.sequenceBuffer = [];
    }, 1000);

    // Check if buffer matches any sequence
    const sequence = this.normalizeShortcut(this.sequenceBuffer.join(' '));

    for (const [key, shortcut] of Object.entries(this.shortcuts)) {
      if (shortcut.sequence && key === sequence) {
        this.sequenceBuffer = [];
        const handler = this.handlers.get(shortcut.action);
        if (handler) {
          handler(event);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Bare function-key combos (f1-f19) require a dedicated key or holding Fn
   * on most Mac keyboards, so they're hidden from the Mac shortcuts list —
   * the binding itself still works (Fn+key, or with standard F-keys
   * enabled in System Settings), this only affects what's displayed.
   */
  isFunctionKeyCombo(key) {
    const parts = String(key).split('+');
    return /^f\d{1,2}$/.test(parts[parts.length - 1]);
  }

  /**
   * Get all shortcuts as a list (for help dialog)
   */
  getShortcutsList() {
    const list = [];

    for (const [key, shortcut] of Object.entries(this.shortcuts)) {
      if (this.isMac && this.isFunctionKeyCombo(key)) continue;
      list.push({
        key: this.formatKey(key),
        originalKey: key,
        action: shortcut.action,
        label: shortcut.label,
        context: shortcut.context || 'all',
        sequence: shortcut.sequence || false,
      });
    }

    // Keep list stable for display
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Format key combination for display
   */
  formatKey(key) {
    if (!key) return '';
    let formatted = String(key).toLowerCase();

    if (formatted === 'shift+/') return '?';

    if (this.isMac) {
      formatted = formatted
        .replace(/ctrl\+/g, 'cmd + ')
        .replace(/shift\+/g, 'shift + ')
        .replace(/alt\+/g, 'option + ');
    } else {
      formatted = formatted
        .replace(/ctrl\+/g, 'ctrl + ')
        .replace(/shift\+/g, 'shift + ')
        .replace(/alt\+/g, 'alt + ');
    }

    // Format special keys
    formatted = formatted
      .replace(/\bdelete\b/g, 'delete')
      .replace(/\bescape\b/g, 'esc')
      .replace(/\benter\b/g, 'enter')
      .replace(/\bf5\b/g, 'f5')
      .replace(/\barrowleft\b/g, '←')
      .replace(/\barrowright\b/g, '→')
      .replace(/\barrowup\b/g, '↑')
      .replace(/\barrowdown\b/g, '↓');

    return formatted;
  }

  /**
   * Update a keyboard shortcut
   */
  updateShortcut(oldKey, newKey) {
    const normalizedOld = this.normalizeShortcut(oldKey);
    const normalizedNew = this.normalizeShortcut(newKey);

    // Check if the new key already exists
    if (normalizedNew !== normalizedOld && this.shortcuts[normalizedNew]) {
      throw new Error(
        `Shortcut "${normalizedNew}" is already in use for ${this.shortcuts[normalizedNew].label}`,
      );
    }

    // Get the old shortcut definition
    const shortcutDef = this.shortcuts[normalizedOld];
    if (!shortcutDef) {
      throw new Error(`Shortcut "${normalizedOld}" not found`);
    }

    // Remove the old key
    delete this.shortcuts[normalizedOld];

    // Add the new key
    this.shortcuts[normalizedNew] = shortcutDef;

    // Save to localStorage
    this.saveCustomShortcuts();
    this.bindShortcuts();
  }

  /**
   * Reset shortcuts to defaults
   */
  resetToDefaults() {
    this.shortcuts = { ...DEFAULT_SHORTCUTS };
    this.saveCustomShortcuts();
    this.bindShortcuts();
    this.sequenceBuffer = [];
  }

  /**
   * Register additional shortcuts at runtime (e.g., platform-specific shortcuts).
   * Accepts an object in the same format as DEFAULT_SHORTCUTS.
   */
  addShortcuts(shortcuts) {
    Object.assign(this.shortcuts, shortcuts);
    this.bindShortcuts();
  }

  /**
   * Map a raw KeyboardEvent.key to the token used in DEFAULT_SHORTCUTS
   * (e.g. "ArrowRight" -> "arrowright", " " -> "space", "?" -> "/").
   * Shifted symbols resolve to their base key here; the caller is
   * responsible for adding "shift" to the modifier list (event.shiftKey
   * is already true whenever a shifted symbol was produced).
   */
  eventKeyToComboToken(rawKey) {
    if (!rawKey) return '';
    if (SHIFTED_SYMBOL_TO_BASE[rawKey]) return SHIFTED_SYMBOL_TO_BASE[rawKey];
    const key = rawKey.toLowerCase();
    const named = {
      ' ': 'space',
      spacebar: 'space',
      escape: 'esc',
      del: 'delete',
    };
    return named[key] || key;
  }

  /**
   * Capture the next shortcut entered by the user via hotkeys-js.
   * Waits for a non-modifier key so a bare Ctrl/Shift/Alt/Meta press
   * (held before the real key lands) doesn't get captured on its own.
   * Builds the combo directly from the raw event's modifier flags and
   * `event.key` rather than the wildcard handler's own `key` (which is
   * always the literal bound string "*", not the key(s) actually pressed)
   * or hotkeys-js's internal modifier names (which resolve to ambiguous
   * glyphs like "⌃"/"⇧" that wouldn't match the "ctrl+"/"shift+" tokens
   * already used throughout DEFAULT_SHORTCUTS).
   */
  startCapture(onCapture) {
    if (typeof onCapture !== 'function') return;
    this.stopCapture();
    this.captureInProgress = true;

    this.captureHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();

      const rawKey = event.key || '';
      const lowerKey = rawKey.toLowerCase();
      if (['control', 'shift', 'alt', 'meta', 'os'].includes(lowerKey)) {
        return; // wait for the real key while a bare modifier is held
      }

      const mainKey = this.eventKeyToComboToken(rawKey);
      if (!mainKey) return;

      const modifiers = [];
      if (event.ctrlKey || event.metaKey) modifiers.push('ctrl');
      if (event.altKey) modifiers.push('alt');
      if (event.shiftKey) modifiers.push('shift');

      const captured = this.normalizeShortcut([...modifiers, mainKey].join('+'));
      if (!captured) return;

      onCapture(captured);
    };

    hotkeys('*', { keyup: true }, this.captureHandler);
  }

  stopCapture() {
    if (this.captureHandler) {
      hotkeys.unbind('*', this.captureHandler);
      this.captureHandler = null;
    }
    this.captureInProgress = false;
  }

  /**
   * Destroy the manager and remove event listeners
   */
  destroy() {
    this.unbindShortcuts();
    if (this.sequenceListener) {
      hotkeys.unbind('*', this.sequenceListener);
    }
    this.stopCapture();
    if (this.sequenceTimeout) {
      clearTimeout(this.sequenceTimeout);
    }
  }
}

// Tab shortcuts — registered dynamically on Tauri desktop only (not web or mobile)
export const TAB_SHORTCUTS = {
  'ctrl+t': { action: 'new-tab', label: 'New tab' },
  'ctrl+w': { action: 'close-tab', label: 'Close tab' },
  'ctrl+1': { action: 'tab-1', label: 'Switch to tab 1' },
  'ctrl+2': { action: 'tab-2', label: 'Switch to tab 2' },
  'ctrl+3': { action: 'tab-3', label: 'Switch to tab 3' },
  'ctrl+4': { action: 'tab-4', label: 'Switch to tab 4' },
  'ctrl+5': { action: 'tab-5', label: 'Switch to tab 5' },
  'ctrl+6': { action: 'tab-6', label: 'Switch to tab 6' },
  'ctrl+7': { action: 'tab-7', label: 'Switch to tab 7' },
  'ctrl+8': { action: 'tab-8', label: 'Switch to tab 8' },
  'ctrl+9': { action: 'tab-9', label: 'Switch to tab 9' },
  'ctrl+tab': { action: 'next-tab', label: 'Next tab' },
  'ctrl+shift+tab': { action: 'prev-tab', label: 'Previous tab' },
};

// Create singleton instance
export const keyboardShortcuts = new KeyboardShortcutManager();

// Helper to show keyboard shortcuts help
export function showKeyboardShortcutsHelp() {
  const shortcuts = keyboardShortcuts.getShortcutsList();

  // Group by category
  const grouped = {
    'Common & Message': [],
    'Receiving & Navigation': [],
    'Managing & Tags': [],
    'Search & Filter': [],
    Tabs: [],
    Other: [],
  };

  shortcuts.forEach((shortcut) => {
    if (
      [
        'new-message',
        'reply',
        'reply-all',
        'reply-list',
        'forward',
        'save-draft',
        'print',
      ].includes(shortcut.action)
    ) {
      grouped['Common & Message'].push(shortcut);
      return;
    }

    if (
      [
        'refresh',
        'refresh-all',
        'zoom-in',
        'zoom-out',
        'zoom-reset',
        'expand-thread',
        'collapse-thread',
        'toggle-pane',
        'switch-pane',
      ].includes(shortcut.action)
    ) {
      grouped['Receiving & Navigation'].push(shortcut);
      return;
    }

    if (
      shortcut.action.includes('mark') ||
      ['toggle-read', 'archive', 'delete', 'delete-permanent', 'star'].includes(shortcut.action) ||
      shortcut.action.startsWith('tag-') ||
      shortcut.action === 'clear-tags'
    ) {
      grouped['Managing & Tags'].push(shortcut);
      return;
    }

    if (
      shortcut.action.includes('search') ||
      shortcut.action.includes('filter') ||
      shortcut.action.includes('find')
    ) {
      grouped['Search & Filter'].push(shortcut);
      return;
    }

    if (shortcut.action.includes('tab') || shortcut.action === 'close-tab') {
      grouped['Tabs'].push(shortcut);
      return;
    }

    grouped['Other'].push(shortcut);
  });

  // Remove empty groups (e.g., "Tabs" on web/mobile where tab shortcuts aren't registered)
  Object.keys(grouped).forEach((key) => {
    if (grouped[key].length === 0) delete grouped[key];
  });

  return grouped;
}
