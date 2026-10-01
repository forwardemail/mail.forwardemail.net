/**
 * The mouse pointer's shape follows the page, as in a browser: a hand over
 * links and buttons, an I-beam over text fields. Terminals that support it
 * change their pointer when asked with OSC 22 (Ghostty, kitty, WezTerm,
 * foot, xterm); the others are not asked, since some print what they do not
 * understand. FORWARDEMAIL_POINTER=1 asks any terminal, 0 none.
 */
import type { AnyRecord } from './types';

// CSS cursor values to the names OSC 22 takes (the CSS names, as the
// supporting terminals read them).
const SHAPES = new Set<string>([
  'default',
  'pointer',
  'text',
  'grab',
  'grabbing',
  'not-allowed',
  'move',
  'wait',
  'progress',
  'help',
  'crosshair',
  'col-resize',
  'row-resize',
  'ew-resize',
  'ns-resize',
]);

export function pointerShapesSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.FORWARDEMAIL_POINTER;
  if (setting === '0') return false;
  if (setting === '1') return true;
  const program = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = env.TERM ?? '';
  if (env.TMUX) return false;
  return (
    program === 'ghostty' ||
    program === 'wezterm' ||
    term === 'xterm-kitty' ||
    term === 'xterm-ghostty' ||
    term.startsWith('foot') ||
    Boolean(env.KITTY_WINDOW_ID) ||
    Boolean(env.WEZTERM_EXECUTABLE)
  );
}

/**
 * The shape for an element under the pointer. The stylesheet's cursor
 * declarations are pruned at build time (src/cli/prune-css.js), so the
 * Tailwind classes and inline styles that set them are read instead.
 */
export function shapeFor(win: AnyRecord, element: AnyRecord | null): string {
  for (let el = element; el; el = el.parentElement) {
    const inline = String(el.style?.cursor ?? '');
    if (inline && inline !== 'auto') {
      const name = inline.split(',').pop()!.trim();
      return SHAPES.has(name) ? name : 'default';
    }
    for (const name of Array.from((el.classList ?? []) as Iterable<string>)) {
      // cursor-pointer, cursor-text, …; not the hover:/active: variants.
      const match = /^cursor-([a-z-]+)$/.exec(name);
      if (match && SHAPES.has(match[1])) return match[1];
    }
    if (
      el.matches?.(
        'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable="true"], [contenteditable=""]',
      )
    ) {
      return 'text';
    }
    if (
      el.matches?.(
        'a[href], button:not([disabled]), [role="button"], [role="option"], [role="menuitem"], [role="tab"], summary, label[for], select',
      )
    ) {
      return 'pointer';
    }
  }
  return 'default';
}

export function installPointer(
  win: AnyRecord,
  options: { output?: { write(text: string): unknown }; supported?: boolean } = {},
) {
  if (!(options.supported ?? pointerShapesSupported())) return;
  const output = options.output ?? process.stdout;
  let current = 'default';
  const set = (shape: string) => {
    if (shape === current) return;
    current = shape;
    output.write(`\x1b]22;${shape}\x1b\\`);
  };
  win.addEventListener('mousemove', (event: AnyRecord) => set(shapeFor(win, event.target)), true);
  win.addEventListener('mouseout', (event: AnyRecord) => {
    if (!event.relatedTarget) set('default');
  });
  process.on('exit', () => {
    if (current !== 'default') {
      try {
        output.write('\x1b]22;default\x1b\\');
      } catch {
        // the terminal is gone
      }
    }
  });
}
