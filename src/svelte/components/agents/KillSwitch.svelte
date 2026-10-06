<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import OctagonPause from '@lucide/svelte/icons/octagon-pause';
  import Play from '@lucide/svelte/icons/play';

  /**
   * Account-wide pause (spec §5.3, §5.5). One confirmation to pause, none to
   * resume. Online only: a kill switch that silently queues is worse than
   * one that honestly can't fire, so offline it is disabled and says why.
   */
  let {
    paused,
    online,
    confirmOpen = $bindable(false),
    onPause,
    onResume,
  }: {
    paused: boolean;
    online: boolean;
    confirmOpen?: boolean;
    onPause: () => Promise<void>;
    onResume: () => Promise<void>;
  } = $props();

  let working = $state(false);
  let error = $state('');

  async function run(fn: () => Promise<void>) {
    working = true;
    error = '';
    try {
      await fn();
      confirmOpen = false;
    } catch (err) {
      error = (err as Error)?.message || 'Could not reach the server';
    } finally {
      working = false;
    }
  }
</script>

{#if paused}
  <Button
    variant="outline"
    class="min-h-11 gap-2"
    disabled={!online || working}
    title={online ? 'Resume all agents' : 'Connect to resume agents'}
    onclick={() => run(onResume)}
    data-testid="kill-switch"
  >
    <Play class="h-4 w-4" />
    {online ? 'Resume all' : 'Connect to resume agents'}
  </Button>
{:else}
  <Button
    variant="destructive"
    class="min-h-11 gap-2"
    disabled={!online || working}
    title={online ? 'Pause all agents (Shift+P)' : 'Connect to pause agents'}
    aria-keyshortcuts="Shift+P"
    onclick={() => (confirmOpen = true)}
    data-testid="kill-switch"
  >
    <OctagonPause class="h-4 w-4" />
    {online ? 'Pause all' : 'Connect to pause agents'}
  </Button>
{/if}
{#if error && !confirmOpen}
  <span class="text-sm text-destructive" role="alert">{error}</span>
{/if}

<Dialog.Root bind:open={confirmOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Pause all agents?</Dialog.Title>
      <Dialog.Description>
        Every agent stops sending immediately. Their credentials keep working and nothing is
        revoked; resume restores them.
      </Dialog.Description>
    </Dialog.Header>
    {#if error}
      <p class="text-sm text-destructive" role="alert">{error}</p>
    {/if}
    <Dialog.Footer>
      <Button variant="outline" class="min-h-11" onclick={() => (confirmOpen = false)}>
        Cancel
      </Button>
      <Button
        variant="destructive"
        class="min-h-11"
        disabled={!online || working}
        onclick={() => run(onPause)}
      >
        Pause all
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
