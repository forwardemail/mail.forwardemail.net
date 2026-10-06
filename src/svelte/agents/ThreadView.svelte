<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { MonoLabel } from '$lib/components/ui/mono-label';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import AgentTag from '../components/agents/AgentTag.svelte';
  import BudgetMeter from '../components/agents/BudgetMeter.svelte';
  import type { Agent, AgentThread, PendingAction } from '../../types/agents';

  /** Agent-to-agent conversation (spec §5.2, §6.2). */
  let {
    thread,
    threads,
    agentsById,
    pendingAction,
    navigate,
    onTakeOver,
    onDecline,
  }: {
    thread: AgentThread | null;
    threads: AgentThread[];
    agentsById: Record<string, Agent>;
    pendingAction?: PendingAction;
    navigate: (path: string) => void;
    onTakeOver: (id: string) => void;
    onDecline: (id: string) => void;
  } = $props();
</script>

{#if !thread}
  <div class="fe-thread">
    <h1 class="fe-th-title">Agent threads</h1>
    {#if threads.length === 0}
      <p class="text-fg-secondary">No conversations between agents yet.</p>
    {:else}
      <ul class="fe-th-list">
        {#each threads as t (t.id)}
          <li>
            <button
              type="button"
              class="fe-th-row"
              onclick={() => navigate(`/agents/threads/${t.id}`)}
            >
              <span class="fe-th-row-title">{t.subject}</span>
              <span class="font-mono text-fg-secondary fe-th-small">
                {agentsById[t.agentId]?.name} ↔ {t.counterparty}
              </span>
              <BudgetMeter used={t.budgetUsed} total={t.budget} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{:else}
  <div class="fe-thread">
    <Button
      variant="ghost"
      class="min-h-11 gap-2 self-start"
      onclick={() => navigate('/agents/threads')}
    >
      <ArrowLeft class="h-4 w-4" /> Agent threads
    </Button>
    <header class="fe-th-head">
      <h1 class="fe-th-title">{thread.subject}</h1>
      <p class="font-mono text-fg-secondary fe-th-small">
        {agentsById[thread.agentId]?.name} ↔ {thread.counterparty}
      </p>
      <BudgetMeter used={thread.budgetUsed} total={thread.budget} />
    </header>

    <section class="fe-th-summary">
      <MonoLabel tick>Summary</MonoLabel>
      <p>{thread.summary}</p>
    </section>

    <ol class="fe-th-messages" aria-label="Messages">
      {#each thread.messages as m (m.id)}
        <li class="fe-th-msg" data-side={m.side}>
          <div class="fe-th-msg-head">
            <span class="font-mono">{m.from}</span>
            {#if m.isAgent}<AgentTag label={m.side === 'ours' ? 'Your agent' : 'Agent'} />{/if}
            <span class="fe-numeral text-fg-muted fe-th-small">
              {new Date(m.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <p>{m.body}</p>
        </li>
      {/each}
    </ol>

    {#if pendingAction && pendingAction.status === 'pending'}
      <section class="fe-th-escalation" aria-label="Escalation">
        <MonoLabel tick tone="caution">{pendingAction.reason.summary}</MonoLabel>
        <p class="fe-th-small text-fg-secondary">
          The next message from {agentsById[thread.agentId]?.name} is held:
          <q>{pendingAction.preview}</q>. Take over to reply yourself; your reply resets the budget.
        </p>
        <div class="fe-th-actions">
          <Button variant="outline" class="min-h-11" onclick={() => onDecline(pendingAction.id)}>
            Decline
          </Button>
          <Button class="min-h-11" onclick={() => onTakeOver(pendingAction.id)}>Take over</Button>
        </div>
      </section>
    {/if}
  </div>
{/if}

<style>
  .fe-thread {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-4);
    max-width: 760px;
  }
  .fe-th-head {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-2);
  }
  .fe-th-title {
    font-size: var(--type-body-lg);
    font-weight: 600;
    color: var(--fg-primary);
  }
  .fe-th-small {
    font-size: var(--type-meta);
  }
  .fe-th-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-2);
  }
  .fe-th-row {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
    padding: var(--fe-space-3) var(--fe-space-4);
    border: 1px solid var(--border-default);
    border-radius: var(--fe-radius-md);
    background: var(--surface-raised);
    cursor: pointer;
  }
  .fe-th-row-title {
    font-weight: 600;
    color: var(--fg-primary);
  }
  .fe-th-summary {
    padding: var(--fe-space-3) var(--fe-space-4);
    border-radius: var(--fe-radius-md);
    background: var(--surface-sunken);
    font-size: var(--type-body-sm);
  }
  .fe-th-messages {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-2);
  }
  .fe-th-msg {
    padding: var(--fe-space-3) var(--fe-space-4);
    border: 1px solid var(--border-subtle);
    border-radius: var(--fe-radius-md);
    background: var(--surface-raised);
    font-size: var(--type-body-sm);
    max-width: 88%;
  }
  .fe-th-msg[data-side='ours'] {
    align-self: flex-end;
    border-color: var(--border-default);
  }
  .fe-th-msg-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fe-space-2);
    margin-bottom: 4px;
    font-size: var(--type-meta);
    color: var(--fg-secondary);
  }
  .fe-th-escalation {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-2);
    padding: var(--fe-space-4);
    border: 1px solid var(--border-strong);
    border-left: 3px solid var(--state-caution-fill);
    border-radius: var(--fe-radius-md);
    background: var(--surface-raised);
  }
  .fe-th-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--fe-space-2);
  }
</style>
