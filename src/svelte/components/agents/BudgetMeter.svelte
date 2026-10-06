<script lang="ts">
  /** Agent-to-agent conversation budget, n of N (spec §6.2). */
  let { used, total }: { used: number; total: number } = $props();

  const segments = $derived(Array.from({ length: Math.max(total, 0) }, (_, i) => i < used));
  const reached = $derived(used >= total);
</script>

<div
  class="fe-budget"
  role="meter"
  aria-valuemin={0}
  aria-valuemax={total}
  aria-valuenow={used}
  aria-label="Conversation budget"
>
  <div class="fe-budget-bar" aria-hidden="true">
    {#each segments as filled, i (i)}
      <span class="fe-budget-seg" class:filled class:reached></span>
    {/each}
  </div>
  <span class="fe-numeral fe-budget-count">
    {used} of {total}{reached ? ' · budget reached' : ''}
  </span>
</div>

<style>
  .fe-budget {
    display: flex;
    align-items: center;
    gap: var(--fe-space-3);
  }
  .fe-budget-bar {
    display: flex;
    gap: 3px;
    flex: 1;
    max-width: 240px;
  }
  .fe-budget-seg {
    flex: 1;
    height: 8px;
    border-radius: 2px;
    background: var(--surface-sunken);
    border: 1px solid var(--border-default);
  }
  .fe-budget-seg.filled {
    background: var(--state-active-fill);
    border-color: transparent;
  }
  .fe-budget-seg.filled.reached {
    background: var(--state-caution-fill);
  }
  .fe-budget-count {
    color: var(--fg-secondary);
    font-size: var(--type-meta);
  }
</style>
