<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { MonoLabel } from '$lib/components/ui/mono-label';
  import { StatusLog } from '$lib/components/ui/status-log';
  import * as Dialog from '$lib/components/ui/dialog';
  import Info from '@lucide/svelte/icons/info';
  import AutonomyLadder from '../components/agents/AutonomyLadder.svelte';
  import AuditRow from '../components/agents/AuditRow.svelte';
  import type {
    ActionClass,
    Agent,
    AgentPolicyVersion,
    AuditEvent,
    AuditVerifyResult,
    AutonomyLevel,
    DryRunResult,
  } from '../../types/agents';
  import { ACTION_CLASSES } from '../../types/agents';
  import { actionClassLabel, levelRank } from '../../utils/agent-policy';
  import {
    dryRunPolicy,
    policyVersions,
    publishPolicy,
    revokeAgent,
    rollbackPolicy,
    setAgentPaused,
    verifyAuditChain,
  } from '../../stores/agentStore';

  let {
    agent,
    audit,
    online,
    canEditPolicy = true,
  }: {
    agent: Agent;
    audit: AuditEvent[];
    online: boolean;
    /** Mobile is supervision only (§5.7): policy is read-only there. */
    canEditPolicy?: boolean;
  } = $props();

  let versions = $state<AgentPolicyVersion[]>([]);
  let draftLevels = $state<Record<ActionClass, AutonomyLevel> | null>(null);
  let dry = $state<DryRunResult | null>(null);
  let dryLoading = $state(false);
  let working = $state(false);
  let error = $state('');
  let notice = $state('');
  let verify = $state<AuditVerifyResult | null>(null);
  let revokeOpen = $state(false);
  let loadedFor = '';

  const current = $derived(versions[versions.length - 1]);
  const dirty = $derived(
    Boolean(
      current &&
      draftLevels &&
      ACTION_CLASSES.some((cls) => draftLevels![cls] !== current.levels[cls]),
    ),
  );
  const revoked = $derived(agent.status === 'revoked');

  async function loadVersions() {
    try {
      versions = await policyVersions(agent.id);
      const latest = versions[versions.length - 1];
      draftLevels = latest ? { ...latest.levels } : null;
      dry = null;
    } catch (err) {
      error = (err as Error)?.message || 'Could not load policy';
    }
  }

  $effect(() => {
    // Reload when the user moves to a different agent or its policy version changes.
    const key = `${agent.id}:${agent.policyVersion}`;
    if (key !== loadedFor) {
      loadedFor = key;
      verify = null;
      void loadVersions();
    }
  });

  // Dry run on every local change, debounced.
  let dryTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const levels = draftLevels;
    const base = current;
    if (!levels || !base || !dirty) {
      dry = null;
      return;
    }
    clearTimeout(dryTimer);
    dryLoading = true;
    dryTimer = setTimeout(async () => {
      try {
        dry = await dryRunPolicy(agent.id, {
          levels: { ...levels },
          locked: base.locked,
          scope: base.scope,
          quotas: base.quotas,
        });
      } catch {
        dry = null;
      } finally {
        dryLoading = false;
      }
    }, 250);
    return () => clearTimeout(dryTimer);
  });

  async function run(fn: () => Promise<unknown>, success: string) {
    working = true;
    error = '';
    notice = '';
    try {
      await fn();
      notice = success;
    } catch (err) {
      error = (err as Error)?.message || 'Request failed';
    } finally {
      working = false;
    }
  }

  const publish = () =>
    run(async () => {
      if (!draftLevels || !current) return;
      const v = await publishPolicy(agent.id, {
        levels: { ...draftLevels },
        locked: current.locked,
        scope: current.scope,
        quotas: current.quotas,
      });
      await loadVersions();
      notice = `Published policy v${v.version}`;
    }, 'Published');

  const rollback = (to: number) =>
    run(async () => {
      const v = await rollbackPolicy(agent.id, to);
      await loadVersions();
      notice = `Restored v${to} as v${v.version}`;
    }, 'Restored');

  const NEXT: Partial<Record<AutonomyLevel, AutonomyLevel>> = {
    draft: 'approve',
    approve: 'notify',
  };
  const STREAK_DAYS = 30;
  const STREAK_ACTIONS = 50;

  /** Earned autonomy (§5.4): display only, never applied automatically. */
  const suggestions = $derived.by(() => {
    if (!current || revoked) return [];
    const out: Array<{ cls: ActionClass; next: AutonomyLevel; days: number; actions: number }> = [];
    for (const cls of ACTION_CLASSES) {
      const level = current.levels[cls];
      const next = NEXT[level];
      const streak = agent.classStreaks?.[cls];
      if (!next || !streak || current.locked.includes(cls) || cls === 'unclassified') continue;
      if (levelRank(next) <= levelRank(level)) continue;
      const days = Math.floor((Date.now() - Date.parse(streak.since)) / 86_400_000);
      out.push({ cls, next, days, actions: streak.actions });
    }
    return out;
  });

  const raise = (cls: ActionClass, next: AutonomyLevel) => {
    if (!draftLevels) return;
    draftLevels = { ...draftLevels, [cls]: next };
  };

  const cleanDays = $derived(Math.floor((Date.now() - Date.parse(agent.cleanSince)) / 86_400_000));
  const agentAudit = $derived(audit.filter((e) => e.agentId === agent.id).slice(0, 30));

  const fmtBytes = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
</script>

<div class="fe-agent">
  <header class="fe-ag-head">
    <div>
      <h1 class="fe-ag-title font-mono">{agent.name}</h1>
      <p class="fe-ag-sub text-fg-secondary">
        <span class="fe-status-dot" data-status={agent.status} aria-hidden="true"></span>
        <span class="capitalize">{agent.status}</span>
        · {agent.address} · policy v{agent.policyVersion}
        {#if !revoked}· {cleanDays} days without a rejection or block{/if}
      </p>
    </div>
    {#if !revoked}
      <div class="fe-ag-controls">
        {#if agent.status === 'paused'}
          <Button
            variant="outline"
            class="min-h-11"
            disabled={!online || working}
            title={online ? undefined : 'Connect to resume this agent'}
            onclick={() => run(() => setAgentPaused(agent.id, false), 'Resumed')}>Resume</Button
          >
        {:else}
          <Button
            variant="outline"
            class="min-h-11"
            disabled={!online || working}
            title={online ? undefined : 'Connect to pause this agent'}
            onclick={() => run(() => setAgentPaused(agent.id, true), 'Paused')}>Pause</Button
          >
        {/if}
        <Button
          variant="destructive"
          class="min-h-11"
          disabled={!online || working}
          title={online ? undefined : 'Connect to revoke this agent'}
          onclick={() => (revokeOpen = true)}>Revoke</Button
        >
      </div>
    {/if}
  </header>

  {#if revoked}
    <p class="fe-ag-banner" role="status">
      Revoked {agent.revokedAt ? new Date(agent.revokedAt).toLocaleString() : ''}. Credentials no
      longer work and mail sent to {agent.address} goes to your inbox for 30 days. Its history stays in
      the audit log.
    </p>
  {/if}
  {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
  {#if notice}<p class="text-sm text-fg-secondary" role="status">{notice}</p>{/if}

  <section class="fe-ag-section" aria-labelledby="fe-ag-policy">
    <div class="fe-ag-section-head">
      <MonoLabel as="h2" id="fe-ag-policy" tick>Autonomy</MonoLabel>
      {#if !canEditPolicy}
        <span class="text-fg-muted fe-ag-small">Read only on this device</span>
      {/if}
    </div>
    {#if draftLevels && current}
      <AutonomyLadder
        bind:levels={draftLevels}
        locked={current.locked}
        published={current.levels}
        readonly={!canEditPolicy || revoked}
      />
    {/if}

    <p class="fe-ag-limit">
      <Info class="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        The server classifies first contact, replies, attachments and forwards from the message
        itself. Commitments are declared by the agent, so an agent that has been manipulated could
        send one without declaring it. The recipient allowlist and per-counterparty limits are what
        bound that risk.
      </span>
    </p>

    {#if dirty}
      <div class="fe-publish-bar" role="region" aria-label="Unpublished changes">
        <span class="fe-publish-summary" aria-live="polite">
          {dryLoading ? 'Checking against recent actions…' : (dry?.summary ?? '')}
        </span>
        <Button
          variant="ghost"
          class="min-h-11"
          disabled={working}
          onclick={() => (draftLevels = current ? { ...current.levels } : null)}>Discard</Button
        >
        <Button class="min-h-11" disabled={!online || working} onclick={publish}>
          {online ? `Publish v${(current?.version ?? 0) + 1}` : 'Connect to publish'}
        </Button>
      </div>
    {/if}
  </section>

  {#if suggestions.length}
    <section class="fe-ag-section" aria-labelledby="fe-ag-earned">
      <MonoLabel as="h2" id="fe-ag-earned" tick tone="success">Earned autonomy</MonoLabel>
      <ul class="fe-earned">
        {#each suggestions as s (s.cls)}
          {@const meets = s.days >= STREAK_DAYS && s.actions >= STREAK_ACTIONS}
          <li>
            <span>
              {actionClassLabel(s.cls)}: {s.days} days and {s.actions} actions without a rejection or
              block.
              {meets
                ? `Meets the suggested ${STREAK_DAYS} days and ${STREAK_ACTIONS} actions.`
                : `Suggested threshold is ${STREAK_DAYS} days and ${STREAK_ACTIONS} actions.`}
            </span>
            {#if meets && canEditPolicy}
              <Button variant="outline" class="min-h-11" onclick={() => raise(s.cls, s.next)}>
                Raise to {s.next[0].toUpperCase() + s.next.slice(1)}
              </Button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if current}
    <section class="fe-ag-section fe-ag-cols" aria-label="Scope and limits">
      <div>
        <MonoLabel as="h2" tick>Scope</MonoLabel>
        <dl class="fe-dl">
          <dt>May write to</dt>
          <dd class="font-mono">
            {current.scope.writeDomains.length
              ? current.scope.writeDomains.join(', ')
              : 'Any domain, with approval'}
          </dd>
          <dt>May read</dt>
          <dd class="font-mono">{current.scope.readFolders.join(', ')}</dd>
          <dt>Largest attachment</dt>
          <dd class="fe-numeral">{fmtBytes(current.scope.maxAttachmentBytes)}</dd>
        </dl>
      </div>
      <div>
        <MonoLabel as="h2" tick>Limits</MonoLabel>
        <dl class="fe-dl">
          <dt>Sends per day</dt>
          <dd class="fe-numeral">{current.quotas.sendsPerDay}</dd>
          <dt>Per counterparty per day</dt>
          <dd class="fe-numeral">{current.quotas.sendsPerCounterpartyPerDay}</dd>
          <dt>Agent-to-agent budget</dt>
          <dd class="fe-numeral">{current.quotas.agentThreadBudget} messages</dd>
          {#if current.quotas.commitmentLimit}
            <dt>Commitments up to</dt>
            <dd class="fe-numeral">
              {current.quotas.commitmentLimit.amount}
              {current.quotas.commitmentLimit.currency}
            </dd>
          {/if}
        </dl>
      </div>
    </section>
  {/if}

  <section class="fe-ag-section" aria-labelledby="fe-ag-versions">
    <MonoLabel as="h2" id="fe-ag-versions" tick>Policy versions</MonoLabel>
    <ul class="fe-versions">
      {#each [...versions].reverse() as v (v.id)}
        <li>
          <span class="font-mono">v{v.version}</span>
          <span class="text-fg-muted fe-ag-small">
            {new Date(v.publishedAt).toLocaleString()}
          </span>
          {#if v.version === current?.version}
            <span class="fe-type-label text-fg-secondary">Enforced</span>
          {:else if canEditPolicy && !revoked}
            <Button
              variant="ghost"
              size="sm"
              class="min-h-11"
              disabled={!online || working}
              onclick={() => rollback(v.version)}>Restore</Button
            >
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <section class="fe-ag-section" aria-labelledby="fe-ag-audit">
    <div class="fe-ag-section-head">
      <MonoLabel as="h2" id="fe-ag-audit" tick>Audit trail</MonoLabel>
      <Button
        variant="ghost"
        size="sm"
        class="min-h-11"
        onclick={async () => (verify = await verifyAuditChain(agent.id))}>Verify chain</Button
      >
      {#if verify}
        <span
          class="fe-ag-small"
          class:text-state-success={verify.valid}
          class:text-destructive={!verify.valid}
          role="status"
        >
          {verify.valid
            ? `✓ ${verify.checked} events, chain intact`
            : `✕ Chain broken at event ${verify.brokenAt}`}
        </span>
      {/if}
    </div>
    <StatusLog label={`Audit trail for ${agent.name}`}>
      {#each agentAudit as event (event.id)}
        <AuditRow {event} />
      {/each}
    </StatusLog>
  </section>
</div>

<Dialog.Root bind:open={revokeOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Revoke {agent.name}?</Dialog.Title>
      <Dialog.Description>
        It stops sending and receiving immediately. Its history stays in the audit log.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" class="min-h-11" onclick={() => (revokeOpen = false)}>Cancel</Button
      >
      <Button
        variant="destructive"
        class="min-h-11"
        disabled={!online || working}
        onclick={async () => {
          await run(() => revokeAgent(agent.id), `${agent.name} revoked`);
          revokeOpen = false;
        }}>Revoke</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .fe-agent {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-5);
    max-width: 960px;
  }
  .fe-ag-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--fe-space-3);
  }
  .fe-ag-title {
    font-size: var(--type-body-lg);
    font-weight: 600;
    color: var(--fg-primary);
  }
  .fe-ag-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--type-body-xs);
  }
  .fe-ag-controls {
    display: flex;
    gap: var(--fe-space-2);
  }
  .fe-ag-banner {
    padding: var(--fe-space-3) var(--fe-space-4);
    border-radius: var(--fe-radius-md);
    background: var(--surface-sunken);
    border: 1px solid var(--border-default);
    font-size: var(--type-body-sm);
  }
  .fe-ag-section {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-3);
  }
  .fe-ag-section-head {
    display: flex;
    align-items: center;
    gap: var(--fe-space-3);
  }
  .fe-ag-cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--fe-space-5);
  }
  .fe-ag-small {
    font-size: var(--type-meta);
  }
  .fe-ag-limit {
    display: flex;
    gap: var(--fe-space-2);
    font-size: var(--type-body-xs);
    color: var(--fg-secondary);
    max-width: 70ch;
  }
  .fe-publish-bar {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fe-space-2);
    padding: var(--fe-space-3) var(--fe-space-4);
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--fe-radius-md);
    box-shadow: var(--elev-2);
  }
  .fe-publish-summary {
    flex: 1;
    min-width: 200px;
    font-size: var(--type-body-sm);
    color: var(--fg-primary);
  }
  .fe-earned {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-2);
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .fe-earned li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fe-space-2);
    font-size: var(--type-body-sm);
  }
  .fe-dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px var(--fe-space-4);
    margin-top: var(--fe-space-2);
    font-size: var(--type-body-sm);
  }
  .fe-dl dt {
    color: var(--fg-secondary);
  }
  .fe-dl dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .fe-versions {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .fe-versions li {
    display: flex;
    align-items: center;
    gap: var(--fe-space-3);
    min-height: 44px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .fe-status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--state-success-fill);
  }
  .fe-status-dot[data-status='paused'] {
    background: var(--state-caution-fill);
  }
  .fe-status-dot[data-status='revoked'] {
    background: var(--state-danger);
  }
</style>
