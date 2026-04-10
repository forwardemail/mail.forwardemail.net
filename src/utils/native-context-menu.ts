/**
 * Native Context Menu for Tauri Desktop
 *
 * Builds and shows a native OS context menu for message actions.
 * Falls back gracefully — if anything fails, returns false so the
 * caller can show the HTML context menu instead.
 */

interface ContextMenuActions {
  onToggleRead: () => void;
  onReply: () => void;
  onForward: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onMoveTo: (path: string) => void;
  onToggleStar?: () => void;
}

interface ContextMenuOptions {
  message: { is_unread?: boolean; is_starred?: boolean; flags?: string[] };
  actions: ContextMenuActions;
  folders: { path: string; name?: string }[];
  isArchiveFolder?: boolean;
  isDraftFolder?: boolean;
  isTrashFolder?: boolean;
  isSpamFolder?: boolean;
}

export async function showNativeContextMenu(options: ContextMenuOptions): Promise<boolean> {
  try {
    const { Menu, MenuItem, Submenu, PredefinedMenuItem } = await import('@tauri-apps/api/menu');
    const { message, actions, folders } = options;

    const isUnread = Boolean(message.is_unread);
    const isStarred =
      Boolean(message.is_starred) ||
      (Array.isArray(message.flags) && message.flags.includes('\\Flagged'));

    const items = [];

    // Reply / Forward
    items.push(await MenuItem.new({ text: 'Reply', action: actions.onReply }));
    items.push(await MenuItem.new({ text: 'Forward', action: actions.onForward }));
    items.push(await PredefinedMenuItem.new({ item: 'Separator' }));

    // Read / Unread
    items.push(
      await MenuItem.new({
        text: isUnread ? 'Mark as Read' : 'Mark as Unread',
        action: actions.onToggleRead,
      }),
    );

    // Star / Unstar
    if (actions.onToggleStar) {
      items.push(
        await MenuItem.new({
          text: isStarred ? 'Unstar' : 'Star',
          action: actions.onToggleStar,
        }),
      );
    }

    items.push(await PredefinedMenuItem.new({ item: 'Separator' }));

    // Archive (not in archive/spam/drafts/trash)
    if (
      !options.isArchiveFolder &&
      !options.isSpamFolder &&
      !options.isDraftFolder &&
      !options.isTrashFolder
    ) {
      items.push(await MenuItem.new({ text: 'Archive', action: actions.onArchive }));
    }

    // Delete
    items.push(await MenuItem.new({ text: 'Delete', action: actions.onDelete }));

    // Move to folder submenu
    if (folders.length > 0) {
      items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
      const moveItems = await Promise.all(
        folders.slice(0, 20).map((f) =>
          MenuItem.new({
            text: f.path || f.name || 'Unknown',
            action: () => actions.onMoveTo(f.path),
          }),
        ),
      );
      const moveSubmenu = await Submenu.new({ text: 'Move to', items: moveItems });
      items.push(moveSubmenu);
    }

    const menu = await Menu.new({ items });
    await menu.popup();
    return true;
  } catch (err) {
    console.warn('[native-context-menu] Failed, falling back to HTML menu:', err);
    return false;
  }
}
