<script lang="ts">
  /**
   * The rule that queued an action. The text is PendingAction.reason.summary,
   * shown verbatim: the server wrote it, and rewording it here would let the
   * UI drift from what was actually enforced.
   */
  let { summary, rule }: { summary: string; rule?: string } = $props();
</script>

<span class="fe-reason-chip fe-type-label" title={rule ? `Rule: ${rule}` : undefined}>
  {summary}
</span>

<style>
  .fe-reason-chip {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    padding: 2px var(--fe-space-2);
    border: 1px solid currentColor;
    border-radius: var(--fe-radius-sm);
    color: var(--state-caution);
    text-transform: none;
    letter-spacing: 0.02em;
    white-space: normal;
  }
</style>
