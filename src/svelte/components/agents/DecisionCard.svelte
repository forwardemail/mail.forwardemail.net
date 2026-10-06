<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import ReasonChip from './ReasonChip.svelte';
  import type { PendingAction } from '../../../types/agents';
  import type { LocalDecision } from '../../../stores/agentStore';

  /**
   * One PendingAction (spec §5.3). The card is a listitem whose accessible
   * name is "<agent> to <recipient>: <title>" (§9).
   */
  let {
    action,
    agentName,
    local,
    focused = false,
    onApprove,
    onReject,
    onOpen,
    onTakeOver,
    onDismiss,
  }: {
    action: PendingAction;
    agentName: string;
    local?: LocalDecision;
    focused?: boolean;
    onApprove?: () => void;
    onReject?: () => void;
    onOpen?: () => void;
    onTakeOver?: () => void;
    onDismiss?: () => void;
  } = $props();

  const recipient = $derived(action.envelope.to.join(', '));
  const accessibleName = $derived(`${agentName} to ${recipient}: ${action.envelope.subject}`);
  const busy = $derived(local?.state === 'sending' || local?.state === 'queued');

  const COUNTERPARTY: Record<PendingAction['counterparty']['status'], string> = {
    known: 'Known contact',
    new: 'First contact',
    agent: 'Counterparty is an agent',
  };

  const OUTCOME: Record<PendingAction['status'], string> = {
    approved: 'approved',
    rejected: 'rejected',
    expired: 'expired',
    cancelled: 'cancelled',
    pending: 'still pending',
  };

  const age = $derived.by(() => {
    const minutes = Math.round((Date.now() - Date.parse(action.createdAt)) / 60_000);
    if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  });
</script>

<li
  class="fe-decision-card"
  class:focused
  class:escalation={action.kind === 'escalation'}
  aria-label={accessibleName}
  data-action-id={action.id}
  data-testid="decision-card"
>
  <div class="fe-dc-head">
    <span class="font-mono fe-dc-route">
      <span class="text-fg-primary">{agentName}</span>
      <span class="text-fg-muted" aria-hidden="true">→</span>
      <span>{recipient}</span>
    </span>
    <span class="fe-numeral text-fg-muted fe-dc-age">{age}</span>
  </div>

  <ReasonChip summary={action.reason.summary} rule={action.reason.rule} />

  <button type="button" class="fe-dc-body" onclick={onOpen}>
    <span class="fe-dc-title">{action.envelope.subject}</span>
    <span class="fe-dc-preview">{action.preview}</span>
  </button>

  <div class="fe-dc-foot">
    <span class="fe-dc-counterparty">
      {COUNTERPARTY[action.counterparty.status]} · {action.counterparty.domain}
    </span>

    {#if local?.state === 'queued'}
      <span class="fe-dc-status" role="status">
        Will {local.verb === 'approve' ? 'send' : 'reject'} when online
      </span>
    {:else if local?.state === 'conflict'}
      <span class="fe-dc-status" role="status">
        Already handled on another device: {OUTCOME[local.outcome]}
      </span>
      <Button variant="ghost" class="min-h-11" onclick={onDismiss}>Dismiss</Button>
    {:else if local?.state === 'failed'}
      <span class="fe-dc-status fe-dc-error" role="status">{local.error}</span>
      <Button variant="ghost" class="min-h-11" onclick={onDismiss}>Dismiss</Button>
    {:else if action.kind === 'escalation'}
      <div class="fe-dc-actions">
        <Button variant="outline" class="min-h-11" disabled={busy} onclick={onReject}>
          Decline
        </Button>
        <Button class="min-h-11" disabled={busy} onclick={onTakeOver}>Take over</Button>
      </div>
    {:else}
      <div class="fe-dc-actions">
        <Button variant="ghost" class="min-h-11" onclick={onOpen}>Review</Button>
        <Button variant="outline" class="min-h-11" disabled={busy} onclick={onReject}>
          Reject
        </Button>
        <Button class="min-h-11" disabled={busy} onclick={onApprove}>
          {local?.state === 'sending' && local.verb === 'approve' ? 'Sending…' : 'Approve'}
        </Button>
      </div>
    {/if}
  </div>
</li>

<style>
  .fe-decision-card {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-2);
    padding: var(--fe-space-4);
    background: var(--surface-raised);
    border: 1px solid var(--border-default);
    border-radius: var(--fe-radius-lg);
    box-shadow: var(--elev-1), var(--elev-inset);
  }
  .fe-decision-card.focused {
    outline: 2px solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .fe-decision-card.escalation {
    border-left: 3px solid var(--state-caution-fill);
  }
  .fe-dc-head {
    display: flex;
    justify-content: space-between;
    gap: var(--fe-space-3);
    font-size: var(--type-code-size);
    color: var(--fg-secondary);
  }
  .fe-dc-route {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .fe-dc-age {
    flex-shrink: 0;
    font-size: var(--type-meta);
  }
  .fe-dc-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    color: inherit;
  }
  .fe-dc-title {
    font-size: var(--type-body-md);
    font-weight: 600;
    color: var(--fg-primary);
  }
  .fe-dc-preview {
    font-size: var(--type-body-sm);
    color: var(--fg-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .fe-dc-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fe-space-2);
    margin-top: var(--fe-space-1);
  }
  .fe-dc-counterparty {
    font-size: var(--type-meta);
    color: var(--fg-muted);
  }
  .fe-dc-actions {
    display: flex;
    gap: var(--fe-space-2);
    margin-left: auto;
  }
  .fe-dc-status {
    font-size: var(--type-body-xs);
    color: var(--fg-secondary);
    margin-left: auto;
  }
  .fe-dc-error {
    color: var(--state-danger);
  }
</style>
