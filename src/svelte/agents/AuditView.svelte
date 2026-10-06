<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { StatusLog } from '$lib/components/ui/status-log';
  import Download from '@lucide/svelte/icons/download';
  import AuditRow from '../components/agents/AuditRow.svelte';
  import type { Agent, AuditEvent, AuditEventType, AuditVerifyResult } from '../../types/agents';
  import { verifyAuditChain } from '../../stores/agentStore';

  /** All agents' audit events, filterable and exportable (spec §5.2, §4.6). */
  let { events, agents }: { events: AuditEvent[]; agents: Agent[] } = $props();

  let agentFilter = $state('all');
  let typeFilter = $state<'all' | AuditEventType>('all');
  let chains = $state<Record<string, AuditVerifyResult>>({});
  let verifying = $state(false);

  const byId = $derived(Object.fromEntries(agents.map((a) => [a.id, a])));
  const filtered = $derived(
    events.filter(
      (e) =>
        (agentFilter === 'all' || e.agentId === agentFilter) &&
        (typeFilter === 'all' || e.type === typeFilter),
    ),
  );

  const TYPES: AuditEventType[] = [
    'send',
    'queue',
    'approve',
    'reject',
    'deny',
    'inbound_blocked',
    'budget_reached',
    'policy_publish',
    'pause',
    'resume',
    'revoke',
  ];

  async function verifyAll() {
    verifying = true;
    const next: Record<string, AuditVerifyResult> = {};
    for (const agent of agents) next[agent.id] = await verifyAuditChain(agent.id);
    chains = next;
    verifying = false;
  }

  /** JSON Lines with hashes, so the chain can be checked independently. */
  function exportJsonl() {
    const ordered = [...filtered].sort((a, b) =>
      a.agentId === b.agentId ? a.seq - b.seq : a.agentId.localeCompare(b.agentId),
    );
    const blob = new Blob([ordered.map((e) => JSON.stringify(e)).join('\n') + '\n'], {
      type: 'application/x-ndjson',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<div class="fe-audit">
  <header class="fe-au-head">
    <h1 class="fe-au-title">Audit log</h1>
    <div class="fe-au-tools">
      <label class="fe-au-field">
        <span class="fe-type-label">Agent</span>
        <select bind:value={agentFilter} class="fe-au-select">
          <option value="all">All agents</option>
          {#each agents as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
        </select>
      </label>
      <label class="fe-au-field">
        <span class="fe-type-label">Event</span>
        <select bind:value={typeFilter} class="fe-au-select">
          <option value="all">All events</option>
          {#each TYPES as t (t)}<option value={t}>{t.replace('_', ' ')}</option>{/each}
        </select>
      </label>
      <Button variant="outline" class="min-h-11" disabled={verifying} onclick={verifyAll}>
        Verify chains
      </Button>
      <Button variant="outline" class="min-h-11 gap-2" onclick={exportJsonl}>
        <Download class="h-4 w-4" /> Export JSONL
      </Button>
    </div>
  </header>

  {#if Object.keys(chains).length}
    <ul class="fe-au-chains" role="status">
      {#each agents as a (a.id)}
        {@const c = chains[a.id]}
        {#if c}
          <li class:text-state-success={c.valid} class:text-destructive={!c.valid}>
            <span class="font-mono">{a.name}</span>:
            {c.valid ? `✓ ${c.checked} events, intact` : `✕ broken at event ${c.brokenAt}`}
          </li>
        {/if}
      {/each}
    </ul>
  {/if}

  <StatusLog label="Agent audit log">
    {#each filtered as event (event.id)}
      <AuditRow {event} agentName={byId[event.agentId]?.name} />
    {/each}
  </StatusLog>
  {#if filtered.length === 0}<p class="text-fg-secondary">No matching events.</p>{/if}
</div>

<style>
  .fe-audit {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-4);
    max-width: 1000px;
  }
  .fe-au-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--fe-space-3);
  }
  .fe-au-title {
    font-size: var(--type-body-lg);
    font-weight: 600;
    color: var(--fg-primary);
  }
  .fe-au-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--fe-space-2);
  }
  .fe-au-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--fg-muted);
  }
  .fe-au-select {
    min-height: 44px;
    padding: 0 var(--fe-space-2);
    border: 1px solid var(--border-default);
    border-radius: var(--fe-radius-sm);
    background: var(--surface-raised);
    color: var(--fg-primary);
    font-size: var(--type-body-sm);
  }
  .fe-au-chains {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: var(--type-body-sm);
  }
</style>
