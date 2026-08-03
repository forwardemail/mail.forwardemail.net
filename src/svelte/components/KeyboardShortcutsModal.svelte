<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { showKeyboardShortcutsHelp } from '../../utils/keyboard-shortcuts.js';

  interface Props {
    visible?: boolean;
    onClose?: () => void;
  }

  let { visible = $bindable(false), onClose = () => {} }: Props = $props();

  interface ShortcutEntry {
    key: string;
    label: string;
  }

  const groups = $derived(
    (visible ? showKeyboardShortcutsHelp() : {}) as Record<string, ShortcutEntry[]>,
  );

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
</script>

<Dialog.Root open={visible} onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Keyboard shortcuts</Dialog.Title>
    </Dialog.Header>

    <div class="max-h-[60vh] overflow-y-auto py-2">
      {#each Object.entries(groups) as [category, shortcuts]}
        <div class="mb-4 last:mb-0">
          <h3 class="mb-2 text-sm font-semibold text-muted-foreground">{category}</h3>
          <div class="space-y-1">
            {#each shortcuts as shortcut}
              <div class="flex items-center justify-between gap-4 py-1">
                <span class="text-sm">{shortcut.label}</span>
                <code class="rounded bg-muted px-2 py-1 text-sm">{shortcut.key}</code>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={onClose}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
