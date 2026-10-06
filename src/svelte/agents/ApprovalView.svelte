<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { MonoLabel } from '$lib/components/ui/mono-label';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ReasonChip from '../components/agents/ReasonChip.svelte';
  import AgentTag from '../components/agents/AgentTag.svelte';
  import type { Agent, AgentPolicyVersion, PendingAction } from '../../types/agents';
  import type { LocalDecision } from '../../stores/agentStore';
  import { actionClassLabel } from '../../utils/agent-policy';

  /**
   * Approval (spec §5.2): the exact bytes the agent wants to send, why they
   * are waiting, who the counterparty is, and what level this class has.
   * Approve is a yes/no on these bytes; editing is Take over.
   */
  let {
    action,
    agent,
    policy,
    local,
    isMock = false,
    navigate,
    onApprove,
    onReject,
    onTakeOver,
    onDismiss,
    onSimulateRemote,
  }: {
    action: PendingAction | null;
    agent?: Agent;
    policy?: AgentPolicyVersion;
    local?: LocalDecision;
    isMock?: boolean;
    navigate: (path: string) => void;
    onApprove: () => void;
    onReject: () => void;
    onTakeOver: () => void;
    onDismiss: () => void;
    onSimulateRemote?: () => void;
  } = $props();

  const level = $derived(action && policy ? policy.levels[action.actionClass] : undefined);
  const expires = $derived(
    action ? new Date(action.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '',
  );
  const decided = $derived(action ? action.status !== 'pending' : false);
  const busy = $derived(local?.state === 'sending' || local?.state === 'queued');
</script>

<div class="fe-approval">
  <Button variant="ghost" class="min-h-11 gap-2 self-start" onclick={() => navigate('/agents')}>
    <ArrowLeft class="h-4 w-4" /> Waiting on you
  </Button>

  {#if !action}
    <p class="text-fg-secondary">This action no longer exists.</p>
  {:else}
    <header class="fe-ap-head">
      <ReasonChip summary={action.reason.summary} rule={action.reason.rule} />
      <h1 class="fe-ap-title">{action.envelope.subject}</h1>
      <p class="font-mono fe-ap-route">
        <AgentTag />
        <span class="text-fg-primary">{agent?.name ?? 'agent'}</span>
        <span aria-hidden="true">→</span>
        {action.envelope.to.join(', ')}
      </p>
    </header>

    <div class="fe-ap-grid">
      <article class="fe-ap-draft" aria-label="Message the agent wants to send">
        <MonoLabel>Draft, exactly as it would send</MonoLabel>
        <pre class="fe-ap-body">{action.body ?? action.preview}</pre>
      </article>

      <aside class="fe-ap-side">
        <section>
          <MonoLabel tick tone="caution">Why it's waiting</MonoLabel>
          <p>{action.reason.summary}.</p>
          <p class="text-fg-muted fe-ap-small font-mono">
            rule {action.reason.rule} · policy v{action.policyVersion}
          </p>
        </section>

        <section>
          <MonoLabel tick>Counterparty</MonoLabel>
          <p class="font-mono">{action.counterparty.domain}</p>
          <p class="fe-ap-small text-fg-secondary">
            {#if action.counterparty.status === 'new'}
              First contact. Nobody on this account has written to this domain before.
            {:else if action.counterparty.status === 'agent'}
              This counterparty is an automated agent.
            {:else}
              Known contact{action.counterparty.messages
                ? `, ${action.counterparty.messages} messages exchanged`
                : ''}.
            {/if}
          </p>
        </section>

        <section>
          <MonoLabel tick>This class</MonoLabel>
          <p>{actionClassLabel(action.actionClass)}</p>
          {#if level}
            <p class="fe-ap-small text-fg-secondary">
              Current level: <strong>{level}</strong>.
              {#if agent}
                <a
                  href={`/agents/${agent.id}`}
                  class="text-fg-link"
                  onclick={(e) => {
                    e.preventDefault();
                    navigate(`/agents/${agent.id}`);
                  }}>Change in policy</a
                >
              {/if}
            </p>
          {/if}
        </section>

        <section>
          <MonoLabel tick>Expires</MonoLabel>
          <p class="fe-ap-small text-fg-secondary">
            {expires}. Unanswered actions expire and are never sent.
          </p>
        </section>
      </aside>
    </div>

    <div class="fe-ap-actions">
      {#if local?.state === 'conflict'}
        <p role="status" class="fe-ap-status">
          Already handled on another device: {local.outcome}.
        </p>
        <Button variant="outline" class="min-h-11" onclick={onDismiss}>OK</Button>
      {:else if local?.state === 'failed'}
        <p role="status" class="fe-ap-status text-destructive">{local.error}</p>
        <Button variant="outline" class="min-h-11" onclick={onDismiss}>OK</Button>
      {:else if local?.state === 'queued'}
        <p role="status" class="fe-ap-status">
          Will {local.verb === 'approve' ? 'send' : 'reject'} when online.
        </p>
      {:else if decided}
        <p role="status" class="fe-ap-status">This action was {action.status}.</p>
      {:else if action.kind === 'escalation'}
        <Button variant="outline" class="min-h-11" disabled={busy} onclick={onReject}>
          Decline
        </Button>
        <Button class="min-h-11" disabled={busy} onclick={onTakeOver}>Take over</Button>
      {:else}
        <Button variant="ghost" class="min-h-11" disabled={busy} onclick={onTakeOver}>
          Edit as my draft
        </Button>
        <Button variant="outline" class="min-h-11" disabled={busy} onclick={onReject}>
          Reject
        </Button>
        <Button class="min-h-11" disabled={busy} onclick={onApprove}>Approve and send</Button>
      {/if}
    </div>

    {#if isMock && !decided && onSimulateRemote}
      <p class="fe-ap-mock">
        Prototype:
        <button type="button" class="text-fg-link underline" onclick={onSimulateRemote}>
          approve this on another device
        </button>, then act here to see the conflict.
      </p>
    {/if}
  {/if}
</div>

<style>
  .fe-approval {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-4);
    max-width: 1000px;
  }
  .fe-ap-head {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-2);
    align-items: flex-start;
  }
  .fe-ap-title {
    font-size: var(--type-body-lg);
    font-weight: 600;
    color: var(--fg-primary);
  }
  .fe-ap-route {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fe-space-2);
    font-size: var(--type-code-size);
    color: var(--fg-secondary);
  }
  .fe-ap-grid {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr);
    gap: var(--fe-space-5);
  }
  @media (max-width: 860px) {
    .fe-ap-grid {
      grid-template-columns: 1fr;
    }
  }
  .fe-ap-draft {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-2);
    padding: var(--fe-space-4);
    background: var(--surface-raised);
    border: 1px solid var(--border-default);
    border-radius: var(--fe-radius-lg);
  }
  .fe-ap-body {
    white-space: pre-wrap;
    font-family: var(--font-body);
    font-size: var(--type-body-sm);
    color: var(--fg-primary);
    margin: 0;
  }
  .fe-ap-side {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-4);
    font-size: var(--type-body-sm);
    color: var(--fg-primary);
  }
  .fe-ap-side section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .fe-ap-small {
    font-size: var(--type-body-xs);
  }
  .fe-ap-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fe-space-2);
    padding-top: var(--fe-space-3);
    border-top: 1px solid var(--border-subtle);
  }
  .fe-ap-status {
    margin-right: auto;
    font-size: var(--type-body-sm);
    color: var(--fg-secondary);
  }
  .fe-ap-mock {
    font-size: var(--type-meta);
    color: var(--fg-muted);
  }
</style>
