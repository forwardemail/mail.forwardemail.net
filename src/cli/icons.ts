/**
 * Glyphs for the Lucide icons the webmail uses. SVG paths do not draw in a
 * terminal, so the terminal build renders each icon as its glyph (see
 * components/LucideIcon.svelte). Keys are Lucide icon names; renamed icons
 * are listed under both names. Every glyph is a single
 * text-presentation character that terminals and TermDOM agree is one
 * column wide (the trigrams ☰ and ☷, for one, are not; circled letters such
 * as ⓘ are drawn wider than a column by many fonts).
 */
const ICONS: Record<string, string> = {
  inbox: '⇩',
  'mail mailbox mail-open': '✉',
  'send send-horizontal': '➤',
  'archive archive-restore': '⊟',
  'trash trash-2': '✖',
  'file-pen file-edit pencil pen square-pen': '✎',
  'file file-text': '≣',
  'folder folder-closed': '▸',
  'folder-open': '▾',
  'folder-plus plus': '+',
  'folder-input corner-down-right': '↳',
  'shield-alert octagon-alert alert-octagon triangle-alert alert-triangle circle-alert alert-circle':
    '⚠',
  'shield-check': '✔',
  'info circle-help help-circle': 'i',
  'octagon-x circle-x x-circle': '⊗',
  x: '✕',
  minus: '−',
  'check circle-check check-circle check-circle-2 circle-check-big': '✓',
  'check-check': '✓✓',
  'square-check-big square-check check-square list-todo': '☑',
  square: '☐',
  circle: '○',
  'chevron-down': '▾',
  'chevron-up': '▴',
  'chevron-left arrow-left': '‹',
  'chevron-right arrow-right': '›',
  'ellipsis more-horizontal': '…',
  'ellipsis-vertical more-vertical': '⋮',
  'menu rows-3 layout-list list': '≡',
  'list-ordered': '1.',
  'funnel filter list-filter': '⏷',
  'search mail-search': '⌕',
  'refresh-cw rotate-cw refresh-ccw': '↻',
  'loader loader-2 loader-circle': '◌',
  settings: '⚙',
  'sun sun-medium': '☀',
  moon: '☾',
  laptop: '▭',
  smartphone: '▯',
  'user circle-user smile': '☺',
  'users book-user contact': '☻',
  'calendar calendar-days': '▦',
  'calendar-plus': '▦',
  'clock clock-3': '◷',
  'bell bell-ring': '♫',
  'bell-off': '⊘',
  star: '★',
  'star-off': '☆',
  'tag tags': '#',
  paperclip: '⌇',
  'reply undo-2': '↩',
  'reply-all': '⇇',
  'forward redo-2': '↪',
  'download import save': '⤓',
  'upload share': '⤒',
  'copy clipboard-copy': '⧉',
  'external-link': '↗',
  'link link-2': '⛓',
  eye: '◉',
  'eye-off': '◌',
  'lock lock-keyhole lock-open': '⚿',
  key: '⚷',
  'log-out': '⏻',
  play: '▶',
  image: '▨',
  camera: '◙',
  'qr-code': '▩',
  'map-pin': '⌖',
  'message-square': '▭',
  'maximize-2 maximize': '⤢',
  'minimize-2 minimize': '⤡',
  'wifi-off': '⌀',
  wrench: '⚒',
  code: '‹›',
  quote: '❝',
  'eraser remove-formatting': '⌫',
  type: 'T',
  bold: 'B',
  italic: 'I',
  underline: 'U',
  'align-left text-align-start': '⇤',
  'align-center text-align-center': '≡',
  'align-right text-align-end': '⇥',
};

const GLYPHS = new Map<string, string>();
for (const [names, glyph] of Object.entries(ICONS)) {
  for (const name of names.split(' ')) GLYPHS.set(name, glyph);
}

/** The glyph for a Lucide icon name; a bullet for one without its own. */
export function glyphFor(name: string | undefined | null): string {
  return (name && GLYPHS.get(name)) || '•';
}
