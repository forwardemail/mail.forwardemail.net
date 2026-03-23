<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { validateFolderName } from '../../utils/folder-validation.ts';
  import type { Folder } from '$types';

  interface Props {
    action?: 'create' | 'rename';
    folder?: Folder | null;
    onConfirm?: (action: string, folder: Folder | null, value: string) => void;
    onClose?: () => void;
  }

  let {
    action = 'create',
    folder = null,
    onConfirm = () => {},
    onClose = () => {},
  }: Props = $props();

  let folderName = $state('');
  let errorMessage = $state('');
  let inputEl: HTMLInputElement | null = $state(null);

  // Guard to only set folderName once per folder
  let lastFolderId = '';
  $effect(() => {
    const folderId = folder?.path || '';
    if (action === 'rename' && folder && folderId !== lastFolderId) {
      lastFolderId = folderId;
      // Pre-fill with current name for rename
      const parts = folder.path.split('/');
      folderName = parts[parts.length - 1];
    }
    setTimeout(() => inputEl?.focus(), 50);
  });

  const handleSubmit = () => {
    errorMessage = '';

    const result = validateFolderName(folderName);
    if (!result.ok) {
      errorMessage = result.error;
      return;
    }

    onConfirm(action, folder, result.value);
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const title = $derived(
    action === 'create' ? (folder ? 'Create Subfolder' : 'Create Folder') : 'Rename Folder',
  );
  const placeholder = $derived(action === 'create' ? 'Folder name' : 'New folder name');
</script>

<Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      {#if action === 'create' && folder}
        <Dialog.Description>
          in: <strong>{folder.name || folder.path}</strong>
        </Dialog.Description>
      {/if}
    </Dialog.Header>

    <div class="grid gap-4 py-4">
      <div class="grid gap-2">
        <Label for="folder-name">Folder name</Label>
        <Input
          id="folder-name"
          type="text"
          bind:ref={inputEl}
          bind:value={folderName}
          {placeholder}
          maxlength={100}
          aria-invalid={!!errorMessage}
          onkeydown={handleKeydown}
        />
        {#if errorMessage}
          <p class="text-sm text-destructive">{errorMessage}</p>
        {/if}
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={onClose}>Cancel</Button>
      <Button onclick={handleSubmit}>
        {action === 'create' ? 'Create' : 'Rename'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
