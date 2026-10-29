<script lang="ts">
  /**
   * A banner for a message that may not be from who it says (sender-warnings.ts).
   * Renders nothing for the usual message, so it adds no space to the reader.
   */
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import { getSenderWarnings } from '../../utils/sender-warnings';

  interface Props {
    message?: unknown;
  }

  const { message = null }: Props = $props();

  const warnings = $derived(getSenderWarnings(message as Parameters<typeof getSenderWarnings>[0]));
</script>

{#if warnings.length}
  <div
    class="flex items-start gap-2 p-3 mb-4 bg-state-caution/10 border border-state-caution/25 text-sm"
    role="note"
    data-testid="sender-warning"
    data-warning-kinds={warnings.map((w) => w.kind).join(' ')}
  >
    <ShieldAlert class="h-4 w-4 text-state-caution shrink-0 mt-0.5" />
    <div class="space-y-1">
      <p class="font-medium">Be careful with this message</p>
      {#each warnings as warning (warning.kind)}
        <p class="text-muted-foreground">{warning.message}</p>
      {/each}
    </div>
  </div>
{/if}
