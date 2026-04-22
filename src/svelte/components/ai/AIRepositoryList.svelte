<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
  import { listRepositories, deleteRepository } from '../../../ai/repositories/store';
  import type { RepositorySummary } from '../../../ai/repositories/types';
  import AIRepositoryForm from './AIRepositoryForm.svelte';

  let repos = $state<RepositorySummary[]>([]);
  let loading = $state(true);

  const refresh = async () => {
    try {
      repos = await listRepositories();
    } catch (err) {
      console.warn('[AIRepositoryList] list failed', err);
    } finally {
      loading = false;
    }
  };

  onMount(refresh);

  const remove = async (id: string) => {
    const ok = window.confirm(
      'Remove this repository from the AI?\n\nOnly the registration is removed. Files on disk are not touched.',
    );
    if (!ok) return;
    await deleteRepository(id);
    await refresh();
  };
</script>

<div class="space-y-3">
  {#if loading}
    <div class="text-sm text-muted-foreground">Loading…</div>
  {:else if repos.length === 0}
    <div class="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
      No repositories registered yet. Add one below — the AI will be able to <code>grep</code>,
      list, and read text files from it when drafting support replies.
    </div>
  {:else}
    <ul class="space-y-2">
      {#each repos as repo (repo.id)}
        <li
          class="flex items-start justify-between gap-3 rounded-md border bg-muted/10 px-3 py-2 text-sm"
        >
          <div class="flex min-w-0 flex-1 items-start gap-2">
            <FolderGit2 class="mt-[2px] h-4 w-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{repo.label}</div>
              <div class="truncate font-mono text-xs text-muted-foreground">{repo.path}</div>
              <div class="text-[11px] text-muted-foreground">
                Added {new Date(repo.createdAt).toLocaleDateString()}
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onclick={() => remove(repo.id)}
            aria-label="Remove"
            title="Remove repository"
          >
            <Trash2 class="h-4 w-4" />
          </Button>
        </li>
      {/each}
    </ul>
  {/if}

  <AIRepositoryForm onAdded={refresh} />
</div>
