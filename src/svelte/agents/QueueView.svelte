<script lang="ts">
  import { MonoLabel } from '$lib/components/ui/mono-label';
  import DecisionCard from '../components/agents/DecisionCard.svelte';
  import AuditRow from '../components/agents/AuditRow.svelte';
  import { StatusLog } from '$lib/components/ui/status-log';
  import type { Agent, AuditEvent, DigestRow, PendingAction } from '../../types/agents';
  import type { LocalDecision } from '../../stores/agentStore';

  /**
   * Waiting on you (spec §5.2). Keyboard (§9): j/k move between cards,
   * a approves, r rejects, Enter opens the detail. The parent owns the key
   * listener so it can stand down while a dialog is open.
   */
  let {
    section,
    waiting,
    unusualPending,
    blocked,
    decided,
    digestRows,
    agentsById,
    local,
    focusIndex = $bindable(-1),
    onApprove,
    onReject,
    onTakeOver,
    onOpen,
    onDismiss,
  }: {
    section: 'waiting' | 'unusual' | 'done';
    waiting: PendingAction[];
    unusualPending: PendingAction[];
    blocked: AuditEvent[];
    decided: PendingAction[];
    digestRows: DigestRow[];
    agentsById: Record<string, Agent>;
    local: Record<string, LocalDecision>;
    focusIndex?: number;
    onApprove: (id: string) => void;
    onReject: (id: string) => void;
    onTakeOver: (id: string) => void;
    onOpen: (id: string) => void;
    onDismiss: (id: string) => void;
  } = $props();

  const nameOf = (agentId: string) => agentsById[agentId]?.name ?? 'agent';

  const OUTCOME: Record<PendingAction['status'], string> = {
    approved: 'Approved',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    expired: 'Expired',
    pending: 'Pending',
  };

  const relative = (iso: string) => {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (minutes < 60) return `${Math.max(minutes, 1)}m`;
    return `${Math.round(minutes / 60)}h`;
  };
</script>

{#snippet cards(list: PendingAction[], offset: number)}
  <ul role="list" class="fe-queue-list">
    {#each list as action, i (action.id)}
      <DecisionCard
        {action}
        agentName={nameOf(action.agentId)}
        local={local[action.id]}
        focused={focusIndex === offset + i}
        onApprove={() => onApprove(action.id)}
        onReject={() => onReject(action.id)}
        onTakeOver={() => onTakeOver(action.id)}
        onOpen={() => onOpen(action.id)}
        onDismiss={() => onDismiss(action.id)}
      />
    {/each}
  </ul>
{/snippet}

<div class="fe-queue">
  {#if section === 'waiting'}
    <section aria-labelledby="fe-q-waiting">
      <header class="fe-q-head">
        <h1 id="fe-q-waiting" class="fe-q-title">Waiting on you</h1>
        <span class="fe-numeral text-fg-muted">{waiting.length}</span>
      </header>
      {#if waiting.length === 0}
        <p class="fe-q-empty">
          Nothing needs a decision. Agents are working inside their policies.
        </p>
      {:else}
        {@render cards(waiting, 0)}
        <p class="fe-q-keys text-fg-muted">
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> approve · <kbd>r</kbd> reject ·
          <kbd>Enter</kbd> open
        </p>
      {/if}
    </section>
  {/if}

  {#if section === 'waiting' || section === 'unusual'}
    <section aria-labelledby="fe-q-unusual">
      <header class="fe-q-head">
        <h2 id="fe-q-unusual" class="fe-q-title fe-q-title-sm">Unusual</h2>
        <span class="fe-numeral text-fg-muted">{unusualPending.length + blocked.length}</span>
      </header>
      {#if unusualPending.length}
        {@render cards(unusualPending, section === 'waiting' ? waiting.length : 0)}
      {/if}
      {#if blocked.length}
        <ul role="list" class="fe-queue-list">
          {#each blocked as event (event.id)}
            <li class="fe-blocked">
              <MonoLabel tick tone="danger">Refused by the server</MonoLabel>
              <p class="fe-blocked-text">{event.summary}</p>
              <p class="fe-blocked-meta font-mono">
                {nameOf(event.agentId)} · from {event.counterpartyDomain} · {event.messageRef} ·
                {relative(event.at)} ago
              </p>
            </li>
          {/each}
        </ul>
      {:else if unusualPending.length === 0}
        <p class="fe-q-empty">Nothing unusual.</p>
      {/if}
    </section>
  {/if}

  {#if section === 'waiting'}
    <section aria-labelledby="fe-q-digest">
      <header class="fe-q-head">
        <h2 id="fe-q-digest" class="fe-q-title fe-q-title-sm">Last 24 hours by counterparty</h2>
      </header>
      {#if digestRows.length === 0}
        <p class="fe-q-empty">No agent activity in the last day.</p>
      {:else}
        <table class="fe-digest">
          <thead>
            <tr>
              <th class="fe-type-label" scope="col">Counterparty</th>
              <th class="fe-type-label" scope="col">Sent</th>
              <th class="fe-type-label" scope="col">Queued</th>
              <th class="fe-type-label" scope="col">Last</th>
            </tr>
          </thead>
          <tbody>
            {#each digestRows as row (row.counterpartyDomain)}
              <tr>
                <td class="font-mono">{row.counterpartyDomain}</td>
                <td class="fe-numeral">{row.sent}</td>
                <td class="fe-numeral">{row.queued}</td>
                <td class="fe-numeral text-fg-muted">{relative(row.lastAt)} ago</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {/if}

  {#if section === 'done'}
    <section aria-labelledby="fe-q-done">
      <header class="fe-q-head">
        <h1 id="fe-q-done" class="fe-q-title">Done today</h1>
        <span class="fe-numeral text-fg-muted">{decided.length}</span>
      </header>
      {#if decided.length === 0}
        <p class="fe-q-empty">No decisions yet today.</p>
      {:else}
        <StatusLog label="Decisions today">
          {#each decided as action (action.id)}
            <AuditRow
              agentName={nameOf(action.agentId)}
              event={{
                id: action.id,
                agentId: action.agentId,
                seq: 0,
                prevHash: '',
                hash: '',
                at: action.decidedAt ?? action.createdAt,
                actor: { kind: 'user', id: action.decidedBy ?? '' },
                type: action.status === 'approved' ? 'approve' : 'reject',
                policyVersion: action.policyVersion,
                summary: `${OUTCOME[action.status]}: ${action.envelope.subject}`,
              }}
            />
          {/each}
        </StatusLog>
      {/if}
    </section>
  {/if}
</div>

<style>
  .fe-queue {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-6);
    max-width: 760px;
  }
  .fe-q-head {
    display: flex;
    align-items: baseline;
    gap: var(--fe-space-2);
    margin-bottom: var(--fe-space-3);
  }
  .fe-q-title {
    font-size: var(--type-body-lg);
    font-weight: 600;
    color: var(--fg-primary);
  }
  .fe-q-title-sm {
    font-size: var(--type-body-md);
  }
  .fe-queue-list {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-3);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .fe-q-empty {
    color: var(--fg-secondary);
    font-size: var(--type-body-sm);
  }
  .fe-q-keys {
    margin-top: var(--fe-space-2);
    font-size: var(--type-meta);
  }
  .fe-q-keys kbd {
    font-family: var(--font-mono);
  }
  .fe-blocked {
    padding: var(--fe-space-3) var(--fe-space-4);
    border: 1px solid var(--border-default);
    border-left: 3px solid var(--state-danger);
    border-radius: var(--fe-radius-md);
    background: var(--surface-raised);
  }
  .fe-blocked-text {
    margin-top: var(--fe-space-1);
    font-size: var(--type-body-sm);
    color: var(--fg-primary);
  }
  .fe-blocked-meta {
    margin-top: var(--fe-space-1);
    font-size: var(--type-meta);
    color: var(--fg-muted);
    overflow-wrap: anywhere;
  }
  .fe-digest {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--type-body-sm);
  }
  .fe-digest th {
    text-align: left;
    color: var(--fg-muted);
    padding: var(--fe-space-2);
    border-bottom: 1px solid var(--border-default);
  }
  .fe-digest td {
    padding: var(--fe-space-2);
    border-bottom: 1px solid var(--border-subtle);
  }
</style>
