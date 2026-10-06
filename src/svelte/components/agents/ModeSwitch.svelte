<script lang="ts">
  /**
   * Mail | Agents segmented control at the top of the sidebar (spec §5.1).
   * Only rendered when agent mode is enabled; Mail mode is otherwise
   * untouched.
   */
  let {
    mode,
    pendingCount = 0,
    navigate,
  }: {
    mode: 'mail' | 'agents';
    pendingCount?: number;
    navigate: (path: string) => void;
  } = $props();
</script>

<div class="fe-mode-switch" role="group" aria-label="Mode" data-testid="mode-switch">
  <button
    type="button"
    class="fe-mode-option"
    aria-pressed={mode === 'mail'}
    onclick={() => mode !== 'mail' && navigate('/mailbox')}
  >
    Mail
  </button>
  <button
    type="button"
    class="fe-mode-option"
    aria-pressed={mode === 'agents'}
    onclick={() => mode !== 'agents' && navigate('/agents')}
  >
    Agents
    {#if pendingCount > 0}
      <span class="fe-mode-count fe-numeral" aria-label={`${pendingCount} waiting`}>
        {pendingCount}
      </span>
    {/if}
  </button>
</div>

<style>
  .fe-mode-switch {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    padding: 2px;
    border-radius: var(--fe-radius-md);
    background: var(--surface-sunken);
    border: 1px solid var(--border-subtle);
  }
  .fe-mode-option {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 36px;
    border-radius: calc(var(--fe-radius-md) - 2px);
    font-size: var(--type-body-sm);
    font-weight: 500;
    color: var(--fg-secondary);
    background: transparent;
    border: 0;
    cursor: pointer;
    transition: background var(--motion-fast);
  }
  .fe-mode-option:hover {
    color: var(--fg-primary);
  }
  .fe-mode-option[aria-pressed='true'] {
    background: var(--surface-raised);
    color: var(--fg-primary);
    box-shadow: var(--elev-1);
  }
  .fe-mode-option:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 1px;
  }
  .fe-mode-count {
    min-width: 18px;
    padding: 0 5px;
    border-radius: var(--fe-radius-full);
    background: var(--action-primary-bg);
    color: var(--action-primary-fg);
    font-size: 11px;
    line-height: 18px;
  }
  @media (max-width: 640px) {
    .fe-mode-option {
      min-height: 44px;
    }
  }
</style>
