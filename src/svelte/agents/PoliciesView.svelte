<script lang="ts">
  import { MonoLabel } from '$lib/components/ui/mono-label';
  import type { Agent } from '../../types/agents';

  /** Index of agents and their enforced policy versions. Editing lives on the agent page. */
  let { agents, navigate }: { agents: Agent[]; navigate: (path: string) => void } = $props();
</script>

<div class="fe-policies">
  <h1 class="fe-po-title">Policies</h1>
  <p class="text-fg-secondary fe-po-small">
    Every agent runs under one versioned policy. Publishing creates a new version; restoring an old
    one publishes it again as the newest.
  </p>
  <ul class="fe-po-list">
    {#each agents as a (a.id)}
      <li>
        <button type="button" class="fe-po-row" onclick={() => navigate(`/agents/${a.id}`)}>
          <span class="font-mono">{a.name}</span>
          <MonoLabel as="span">v{a.policyVersion} · {a.status}</MonoLabel>
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .fe-policies {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-3);
    max-width: 760px;
  }
  .fe-po-title {
    font-size: var(--type-body-lg);
    font-weight: 600;
    color: var(--fg-primary);
  }
  .fe-po-small {
    font-size: var(--type-body-sm);
  }
  .fe-po-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .fe-po-row {
    width: 100%;
    min-height: 44px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--fe-space-2) var(--fe-space-3);
    border-bottom: 1px solid var(--border-subtle);
    background: none;
    cursor: pointer;
    color: var(--fg-primary);
  }
  .fe-po-row:hover {
    background: var(--action-ghost-hover-bg);
  }
</style>
