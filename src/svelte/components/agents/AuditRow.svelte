<script lang="ts">
  import { StatusLine, type StatusLineStatus } from '$lib/components/ui/status-log';
  import type { AuditEvent } from '../../../types/agents';

  let { event, agentName }: { event: AuditEvent; agentName?: string } = $props();

  const STATUS: Record<AuditEvent['type'], StatusLineStatus> = {
    send: 'success',
    approve: 'success',
    resume: 'success',
    queue: 'active',
    policy_publish: 'info',
    pause: 'caution',
    budget_reached: 'caution',
    reject: 'danger',
    deny: 'danger',
    revoke: 'danger',
    inbound_blocked: 'danger',
  };

  const VERB: Record<AuditEvent['type'], string> = {
    send: 'sent',
    queue: 'queued',
    approve: 'approved',
    reject: 'rejected',
    deny: 'refused',
    policy_publish: 'policy published',
    pause: 'paused',
    resume: 'resumed',
    revoke: 'revoked',
    inbound_blocked: 'blocked',
    budget_reached: 'budget reached',
  };

  const time = $derived(
    new Date(event.at).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  );
  const meta = $derived(
    [event.policyVersion ? `v${event.policyVersion}` : '', event.level ?? '']
      .filter(Boolean)
      .join(' · '),
  );
</script>

<StatusLine status={STATUS[event.type]} {meta}>
  <span class="fe-numeral text-fg-muted">{time}</span>
  {#if agentName}<span class="font-mono"> {agentName}</span>{/if}
  <span> {VERB[event.type]}</span>
  {#if event.summary}<span class="text-fg-secondary"> · {event.summary}</span>{/if}
  {#if event.rule}<span class="text-fg-muted"> · {event.rule}</span>{/if}
</StatusLine>
