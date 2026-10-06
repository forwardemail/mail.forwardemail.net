<script lang="ts">
  import Bot from '@lucide/svelte/icons/bot';

  /**
   * Marks an agent as the sender. Deliberately neutral: the violet in the
   * mockups is --state-encrypted, and reusing it would make "this is an
   * agent" and "this is encrypted" look the same (spec §8.2).
   */
  let { label = 'Agent' }: { label?: string } = $props();
</script>

<span class="fe-agent-tag fe-type-label">
  <Bot class="h-3 w-3" aria-hidden="true" />
  {label}
</span>

<style>
  .fe-agent-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fg-secondary);
  }
</style>
