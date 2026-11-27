/**
 * Buttons the message reader can show in its header, beside the folder badge
 * and the "…" menu. Which ones show is the reader_header_actions setting
 * (Settings → Appearance → Message header buttons). Every action stays in the
 * "…" menu either way, so hiding one here never makes it unreachable.
 *
 * The list follows the bulk-selection toolbar (archive, delete, mark read or
 * unread, move) and adds report spam, star and the reply family.
 */
export const READER_HEADER_ACTIONS = [
  { id: 'reply', label: 'Reply' },
  { id: 'replyAll', label: 'Reply all' },
  { id: 'forward', label: 'Forward' },
  { id: 'archive', label: 'Archive' },
  { id: 'reportSpam', label: 'Report spam' },
  { id: 'delete', label: 'Delete' },
  { id: 'toggleRead', label: 'Mark read / unread' },
  { id: 'move', label: 'Move to folder' },
  { id: 'star', label: 'Star' },
] as const;

export type ReaderHeaderAction = (typeof READER_HEADER_ACTIONS)[number]['id'];

const KNOWN = new Set<string>(READER_HEADER_ACTIONS.map((a) => a.id));

/** Today's header: Reply only, so nothing changes until someone opts in. */
export const DEFAULT_READER_HEADER_ACTIONS: ReaderHeaderAction[] = ['reply'];

/**
 * Turn whatever is stored into a list of known actions in the order above.
 * Anything that is not an array (missing, corrupt) means the default; an
 * empty array is a real choice (no buttons) and is kept.
 */
export const normalizeReaderHeaderActions = (value: unknown): ReaderHeaderAction[] => {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [...DEFAULT_READER_HEADER_ACTIONS];
    }
  }
  if (!Array.isArray(list)) return [...DEFAULT_READER_HEADER_ACTIONS];
  const chosen = new Set(list.filter((id) => typeof id === 'string' && KNOWN.has(id)));
  return READER_HEADER_ACTIONS.map((a) => a.id).filter((id) => chosen.has(id));
};

/** Actions the full-screen reader toolbar already shows above the header. */
const FULLSCREEN_TOOLBAR_ACTIONS = new Set<ReaderHeaderAction>([
  'archive',
  'delete',
  'toggleRead',
  'move',
  'star',
]);

export type ReaderHeaderContext = {
  /** The full-screen reader toolbar is showing (full screen layout or phone). */
  fullscreenToolbar?: boolean;
  canReply?: boolean;
  canForward?: boolean;
  canArchive?: boolean;
  canReportSpam?: boolean;
  canToggleRead?: boolean;
};

/**
 * The header buttons to draw for the open message: the chosen ones, minus any
 * the folder does not allow (no Archive in Archive, no Report spam in Spam,
 * no reply in Drafts) and any the full-screen toolbar already shows.
 */
export const visibleReaderHeaderActions = (
  chosen: readonly ReaderHeaderAction[],
  ctx: ReaderHeaderContext = {},
): ReaderHeaderAction[] =>
  normalizeReaderHeaderActions(chosen).filter((id) => {
    if (ctx.fullscreenToolbar && FULLSCREEN_TOOLBAR_ACTIONS.has(id)) return false;
    switch (id) {
      case 'reply':
      case 'replyAll':
        return ctx.canReply !== false;
      case 'forward':
        return ctx.canForward !== false;
      case 'archive':
        return ctx.canArchive !== false;
      case 'reportSpam':
        return ctx.canReportSpam !== false;
      case 'toggleRead':
        return ctx.canToggleRead !== false;
      default:
        return true;
    }
  });
