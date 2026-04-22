<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import Folder from '@lucide/svelte/icons/folder';
  import { saveRepository, allocateRepoId } from '../../../ai/repositories/store';
  import { isTauriDesktop } from '../../../utils/platform.js';

  interface Props {
    onAdded?: () => void;
  }

  let { onAdded }: Props = $props();

  let label = $state('');
  let path = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const pickFolder = async () => {
    if (!isTauriDesktop) {
      error = 'Folder picker requires the desktop app.';
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === 'string' && selected) {
        path = selected;
        if (!label) {
          const name = selected.split(/[/\\]/).filter(Boolean).pop();
          if (name) label = name;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  };

  const add = async () => {
    error = null;
    const trimmedLabel = label.trim();
    const trimmedPath = path.trim();
    if (!trimmedLabel || !trimmedPath) {
      error = 'Label and path are required.';
      return;
    }
    busy = true;
    try {
      const id = await allocateRepoId(trimmedLabel);
      await saveRepository({
        id,
        label: trimmedLabel,
        path: trimmedPath,
      });
      label = '';
      path = '';
      onAdded?.();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  };
</script>

<div class="space-y-3 rounded-md border p-3">
  <div class="text-sm font-medium">Add a repository</div>

  <div class="space-y-2">
    <Label for="repo-label">Label</Label>
    <Input id="repo-label" type="text" placeholder="acme-backend" bind:value={label} />
  </div>

  <div class="space-y-2">
    <Label for="repo-path">Path</Label>
    <div class="flex gap-2">
      <Input
        id="repo-path"
        type="text"
        placeholder="/Users/you/code/acme-backend"
        bind:value={path}
        class="flex-1"
      />
      <Button variant="outline" size="sm" onclick={pickFolder} disabled={!isTauriDesktop}>
        <Folder class="mr-1 h-4 w-4" />
        Browse
      </Button>
    </div>
    {#if !isTauriDesktop}
      <p class="text-xs text-muted-foreground">
        Folder picker requires the desktop app. You can paste an absolute path above to test on web.
      </p>
    {/if}
  </div>

  {#if error}
    <div
      class="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
    >
      {error}
    </div>
  {/if}

  <div class="flex justify-end">
    <Button size="sm" onclick={add} disabled={busy || !label.trim() || !path.trim()}>
      {busy ? 'Adding…' : 'Add repository'}
    </Button>
  </div>
</div>
