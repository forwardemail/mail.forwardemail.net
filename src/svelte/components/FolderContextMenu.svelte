<script lang="ts">
  import { Separator } from '$lib/components/ui/separator';
  import type { Folder } from '$types';

  interface MenuState {
    x: number;
    y: number;
    folder: Folder;
  }

  interface Props {
    menu?: MenuState | null;
    onCreateSubfolder?: (folder: Folder) => void;
    onRename?: (folder: Folder) => void;
    onDelete?: (folder: Folder) => void;
    onMarkAsRead?: (folder: Folder) => void;
    onClose?: () => void;
    isSystemFolder?: (path: string) => boolean;
  }

  let {
    menu = null,
    onCreateSubfolder = () => {},
    onRename = () => {},
    onDelete = () => {},
    onMarkAsRead = () => {},
    onClose = () => {},
    isSystemFolder = () => false,
  }: Props = $props();

  let menuEl: HTMLDivElement | null = $state(null);
  let adjustedX = $state(0);
  let adjustedY = $state(0);

  // Guard to prevent loop from setting adjustedX/Y
  let positionAdjusted = false;
  $effect(() => {
    if (menu && menuEl && !positionAdjusted) {
      positionAdjusted = true;
      adjustPosition();
    } else if (!menu) {
      positionAdjusted = false;
    }
  });

  const adjustPosition = () => {
    if (!menu || !menuEl) return;

    const rect = menuEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = menu.x;
    let y = menu.y;

    if (x + rect.width > viewportWidth) {
      x = viewportWidth - rect.width - 10;
    }
    if (x < 10) {
      x = 10;
    }

    if (y + rect.height > viewportHeight) {
      y = viewportHeight - rect.height - 10;
    }
    if (y < 10) {
      y = 10;
    }

    adjustedX = x;
    adjustedY = y;
  };

  const handleOutsideClick = (event: MouseEvent) => {
    if (menuEl && !menuEl.contains(event.target as Node)) {
      onClose();
    }
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const handleAction = (action: (folder: Folder) => void) => {
    if (menu?.folder) {
      action(menu.folder);
    }
    onClose();
  };

  // Guard for event listeners
  let listenersAttached = false;
  $effect(() => {
    if (!listenersAttached) {
      listenersAttached = true;
      document.addEventListener('click', handleOutsideClick);
      document.addEventListener('contextmenu', handleOutsideClick as EventListener);
      window.addEventListener('keydown', handleKeydown);

      setTimeout(() => adjustPosition(), 0);
    }

    return () => {
      listenersAttached = false;
      document.removeEventListener('click', handleOutsideClick);
      document.removeEventListener('contextmenu', handleOutsideClick as EventListener);
      window.removeEventListener('keydown', handleKeydown);
    };
  });

  const systemFolder = $derived(menu?.folder ? isSystemFolder(menu.folder.path) : false);
</script>

{#if menu}
  <div
    bind:this={menuEl}
    class="fixed z-50 min-w-[220px] animate-in fade-in-0 zoom-in-95 border bg-popover p-1.5 text-popover-foreground shadow-md"
    style="left: {adjustedX}px; top: {adjustedY}px;"
    role="menu"
    aria-label="Folder actions"
  >
    <button
      type="button"
      class="flex w-full items-center gap-2.5 px-3 py-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
      onclick={() => handleAction(onCreateSubfolder)}
      role="menuitem"
    >
      <LucidePlus class="h-4 w-4 text-muted-foreground" />
      <span>Create subfolder</span>
    </button>

    <button
      type="button"
      class="flex w-full items-center gap-2.5 px-3 py-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
      onclick={() => handleAction(onRename)}
      disabled={systemFolder}
      role="menuitem"
    >
      <LucidePencil class="h-4 w-4 text-muted-foreground" />
      <span>Rename</span>
    </button>

    <button
      type="button"
      class="flex w-full items-center gap-2.5 px-3 py-2 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
      onclick={() => handleAction(onMarkAsRead)}
      role="menuitem"
    >
      <LucideCheckCheck class="h-4 w-4 text-muted-foreground" />
      <span>Mark all as read</span>
    </button>

    <Separator class="my-1.5" />

    <button
      type="button"
      class="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-destructive outline-none transition-colors hover:bg-destructive/10 focus:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
      onclick={() => handleAction(onDelete)}
      disabled={systemFolder}
      role="menuitem"
    >
      <LucideTrash2 class="h-4 w-4" />
      <span>Delete</span>
    </button>
  </div>
{/if}
