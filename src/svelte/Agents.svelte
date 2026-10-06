<script lang="ts">
  import { onMount } from 'svelte';
  import type { Readable, Writable } from 'svelte/store';
  import { Button } from '$lib/components/ui/button';
  import { MonoLabel } from '$lib/components/ui/mono-label';
  import Menu from '@lucide/svelte/icons/menu';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import ModeSwitch from './components/agents/ModeSwitch.svelte';
  import KillSwitch from './components/agents/KillSwitch.svelte';
  import QueueView from './agents/QueueView.svelte';
  import ApprovalView from './agents/ApprovalView.svelte';
  import AgentView from './agents/AgentView.svelte';
  import ThreadView from './agents/ThreadView.svelte';
  import AuditView from './agents/AuditView.svelte';
  import PoliciesView from './agents/PoliciesView.svelte';
  import { parseAgentsPath } from '../utils/agents-route';
  import { getMockControls } from '../utils/agent-api';
  import {
    agentAnnouncement,
    agentById,
    agentError,
    agentFromCache,
    agentLoading,
    agents,
    agentsOnline,
    agentSnapshot,
    agentThreads,
    auditEvents,
    decide,
    decidedToday,
    digest,
    dismissDecision,
    initAgentStore,
    loadAction,
    loadAgents,
    localDecisions,
    pausedAll,
    policyVersions,
    setPausedAll,
    takeOver,
    unusual,
    waitingOnYou,
  } from '../stores/agentStore';
  import type { AgentPolicyVersion, AgentThread, PendingAction } from '../types/agents';

  let {
    navigate,
    path,
    active,
  }: {
    navigate: (path: string) => void;
    path: Readable<string>;
    active: Writable<boolean>;
  } = $props();

  const route = $derived(parseAgentsPath($path));
  let sidebarOpen = $state(false);
  let killConfirmOpen = $state(false);
  // -1 until j/k is used, so a stray "a" never approves a card nobody picked.
  let focusIndex = $state(-1);
  let isMobile = $state(false);
  let currentAction = $state<PendingAction | null>(null);
  let currentPolicy = $state<AgentPolicyVersion | undefined>();
  let currentThread = $state<AgentThread | null>(null);
  // Rebuilt per account by getAgentBackend, so re-read when the snapshot changes.
  const mock = $derived.by(() => {
    void $agentSnapshot;
    return getMockControls();
  });

  onMount(() => {
    initAgentStore();
    const mq = globalThis.matchMedia?.('(max-width: 768px)');
    const sync = () => (isMobile = Boolean(mq?.matches));
    sync();
    mq?.addEventListener?.('change', sync);
    return () => mq?.removeEventListener?.('change', sync);
  });

  // Load on every visit; the store serves the cached snapshot if offline.
  let wasActive = false;
  onMount(() =>
    active.subscribe((isActive) => {
      if (isActive && !wasActive) void loadAgents();
      wasActive = isActive;
    }),
  );

  // Resolve the record the current screen needs. Stale answers from an
  // earlier route are dropped by comparing against the route at resolve time.
  $effect(() => {
    const r = route;
    void $agentSnapshot;
    if (r.screen === 'action') {
      void loadAction(r.id).then(async (found) => {
        if (route.screen !== 'action' || route.id !== r.id) return;
        currentAction = found;
        if (!found) return;
        try {
          const versions = await policyVersions(found.agentId);
          currentPolicy = versions[versions.length - 1];
        } catch {
          currentPolicy = undefined;
        }
      });
    } else if (r.screen === 'thread') {
      currentThread = $agentSnapshot.threads.find((t) => t.id === r.id) ?? null;
    }
  });

  const allCards = $derived([...$waitingOnYou, ...$unusual.pending]);

  const go = (to: string) => {
    sidebarOpen = false;
    navigate(to);
  };

  const onTakeOver = async (id: string) => {
    if (await takeOver(id)) go('/agents');
  };

  const isTyping = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };

  /** Keyboard (§9): j/k/a/r/Enter on the queue, Shift+P for the kill switch. */
  function onKeydown(event: KeyboardEvent) {
    if (!$active || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTyping(event.target) || document.querySelector('[role="dialog"]')) return;

    if (event.key === 'P' && event.shiftKey) {
      if (!$pausedAll && $agentsOnline) {
        event.preventDefault();
        killConfirmOpen = true;
      }
      return;
    }

    if (route.screen !== 'queue' || route.section === 'done' || allCards.length === 0) return;
    const card = focusIndex >= 0 ? allCards[Math.min(focusIndex, allCards.length - 1)] : undefined;
    const scrollTo = (i: number) => {
      focusIndex = i;
      document
        .querySelector(`[data-action-id="${allCards[i]?.id}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    };
    switch (event.key) {
      case 'j':
        event.preventDefault();
        scrollTo(Math.min(focusIndex + 1, allCards.length - 1));
        break;
      case 'k':
        event.preventDefault();
        scrollTo(Math.max(focusIndex - 1, 0));
        break;
      case 'a':
        if (card?.kind === 'standard') {
          event.preventDefault();
          void decide(card.id, 'approve');
        }
        break;
      case 'r':
        if (card) {
          event.preventDefault();
          void decide(card.id, 'reject');
        }
        break;
      case 'Enter':
        if (card && (event.target as HTMLElement)?.tagName !== 'BUTTON') {
          event.preventDefault();
          go(`/agents/actions/${card.id}`);
        }
        break;
    }
  }

  // Prototype: a few agent sends that exercise different rules.
  let simIndex = 0;
  async function simulateSend() {
    if (!mock) return;
    const list = $agents.filter((a) => a.status !== 'revoked');
    const billing = list.find((a) => a.name === 'billing-agent') ?? list[0];
    if (!billing) return;
    const scenarios = [
      {
        to: ['finance@hooli.xyz'],
        subject: 'Statement for September',
        preview: 'Attached is your September statement.',
        meta: { attachmentBytes: 180_000 },
      },
      {
        to: ['ap@acme-supply.com'],
        subject: 'Re: Purchase order 8812',
        preview: 'We can commit to 40 units at $62 each, delivered by Oct 20.',
        declared: { class: 'commitment' as const, amount: 2480, currency: 'USD' },
        meta: { inKnownThread: true },
      },
      {
        to: ['ops@northwind.io'],
        subject: 'Checking in on renewal',
        preview: 'Wanted to check whether you had a chance to review the renewal terms.',
      },
    ];
    const s = scenarios[simIndex++ % scenarios.length];
    const result = await mock.simulateAgentSend({ agentId: billing.id, ...s });
    agentAnnouncement.set(
      `Simulated send from ${billing.name}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`,
    );
    await loadAgents();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="fe-agents-shell" data-testid="agents-shell">
  <!-- The kill switch is the first focusable control in agent mode (§9). -->
  <header class="fe-agents-top">
    <Button
      variant="ghost"
      size="icon"
      class="fe-agents-menu min-h-11 min-w-11"
      aria-label="Agent navigation"
      aria-expanded={sidebarOpen}
      onclick={() => (sidebarOpen = !sidebarOpen)}
    >
      <Menu class="h-5 w-5" />
    </Button>
    <KillSwitch
      paused={$pausedAll}
      online={$agentsOnline}
      bind:confirmOpen={killConfirmOpen}
      onPause={() => setPausedAll(true)}
      onResume={() => setPausedAll(false)}
    />
    <div class="fe-agents-top-meta">
      {#if !$agentsOnline}
        <span class="fe-pill">Offline{$agentFromCache ? ' · showing saved copy' : ''}</span>
      {:else if $agentFromCache}
        <span class="fe-pill">Showing saved copy</span>
      {/if}
      {#if mock}
        <Button variant="ghost" size="sm" class="min-h-11" onclick={simulateSend}>
          Simulate agent send
        </Button>
        <span class="fe-pill" title="Agent mode is running against an in-memory mock server"
          >Prototype data</span
        >
      {/if}
    </div>
  </header>

  {#if $pausedAll}
    <div class="fe-agents-banner" role="status">
      <ShieldAlert class="h-4 w-4" aria-hidden="true" />
      All agents are paused. Nothing they send leaves until you resume.
    </div>
  {/if}

  <div class="fe-agents-body">
    {#if sidebarOpen}
      <button
        type="button"
        class="fe-agents-scrim"
        aria-label="Close navigation"
        onclick={() => (sidebarOpen = false)}
      ></button>
    {/if}
    <nav class="fe-agents-nav" class:open={sidebarOpen} aria-label="Agent mode">
      <ModeSwitch mode="agents" pendingCount={allCards.length} navigate={go} />

      <MonoLabel as="h2" class="fe-nav-label">Supervision</MonoLabel>
      <ul class="fe-nav-list">
        <li>
          <a
            href="/agents"
            class="fe-nav-item"
            aria-current={route.screen === 'queue' && route.section === 'waiting'
              ? 'page'
              : undefined}
            onclick={(e) => {
              e.preventDefault();
              go('/agents');
            }}
          >
            Waiting on you <span class="fe-numeral fe-nav-count">{$waitingOnYou.length}</span>
          </a>
        </li>
        <li>
          <a
            href="/agents/unusual"
            class="fe-nav-item"
            aria-current={route.screen === 'queue' && route.section === 'unusual'
              ? 'page'
              : undefined}
            onclick={(e) => {
              e.preventDefault();
              go('/agents/unusual');
            }}
          >
            Unusual
            <span class="fe-numeral fe-nav-count"
              >{$unusual.pending.length + $unusual.blocked.length}</span
            >
          </a>
        </li>
        <li>
          <a
            href="/agents/done"
            class="fe-nav-item"
            aria-current={route.screen === 'queue' && route.section === 'done' ? 'page' : undefined}
            onclick={(e) => {
              e.preventDefault();
              go('/agents/done');
            }}
          >
            Done today <span class="fe-numeral fe-nav-count">{$decidedToday.length}</span>
          </a>
        </li>
      </ul>

      <MonoLabel as="h2" class="fe-nav-label">Agents</MonoLabel>
      <ul class="fe-nav-list">
        {#each $agents as agent (agent.id)}
          <li>
            <a
              href={`/agents/${agent.id}`}
              class="fe-nav-item"
              aria-current={route.screen === 'agent' && route.id === agent.id ? 'page' : undefined}
              onclick={(e) => {
                e.preventDefault();
                go(`/agents/${agent.id}`);
              }}
            >
              <span class="fe-nav-agent">
                <span class="fe-status-dot" data-status={agent.status} aria-hidden="true"></span>
                <span class="font-mono">{agent.name}</span>
              </span>
              <span class="sr-only">, {agent.status}</span>
            </a>
          </li>
        {/each}
        {#if $agents.length === 0 && !$agentLoading}
          <li class="fe-nav-empty">No agents yet</li>
        {/if}
      </ul>

      <MonoLabel as="h2" class="fe-nav-label">Records</MonoLabel>
      <ul class="fe-nav-list">
        {#each [['/agents/threads', 'Agent threads', ['threads', 'thread']], ['/agents/audit', 'Audit log', ['audit']], ['/agents/policies', 'Policies', ['policies']]] as [href, label, screens] (href)}
          <li>
            <a
              href={href as string}
              class="fe-nav-item"
              aria-current={(screens as string[]).includes(route.screen) ? 'page' : undefined}
              onclick={(e) => {
                e.preventDefault();
                go(href as string);
              }}>{label}</a
            >
          </li>
        {/each}
      </ul>
    </nav>

    <main class="fe-agents-main">
      {#if $agentError}
        <p class="text-destructive" role="alert">{$agentError}</p>
      {:else if $agentLoading && $agents.length === 0}
        <p class="text-fg-secondary">Loading agents…</p>
      {:else if route.screen === 'queue'}
        <QueueView
          section={route.section}
          waiting={$waitingOnYou}
          unusualPending={$unusual.pending}
          blocked={$unusual.blocked}
          decided={$decidedToday}
          digestRows={$digest}
          agentsById={$agentById}
          local={$localDecisions}
          bind:focusIndex
          onApprove={(id) => decide(id, 'approve')}
          onReject={(id) => decide(id, 'reject')}
          {onTakeOver}
          onOpen={(id) => go(`/agents/actions/${id}`)}
          onDismiss={dismissDecision}
        />
      {:else if route.screen === 'action'}
        {@const id = route.id}
        <ApprovalView
          action={currentAction}
          agent={currentAction ? $agentById[currentAction.agentId] : undefined}
          policy={currentPolicy}
          local={$localDecisions[id]}
          isMock={Boolean(mock)}
          navigate={go}
          onApprove={() => decide(id, 'approve')}
          onReject={() => decide(id, 'reject')}
          onTakeOver={() => onTakeOver(id)}
          onDismiss={() => {
            dismissDecision(id);
            go('/agents');
          }}
          onSimulateRemote={async () => {
            await mock?.simulateRemoteDecision(id, 'approved');
            agentAnnouncement.set('Another device approved this action');
          }}
        />
      {:else if route.screen === 'agent'}
        {@const agent = $agentById[route.id]}
        {#if agent}
          <AgentView
            {agent}
            audit={$auditEvents}
            online={$agentsOnline}
            canEditPolicy={!isMobile}
          />
        {:else}
          <p class="text-fg-secondary">Agent not found.</p>
        {/if}
      {:else if route.screen === 'threads' || route.screen === 'thread'}
        <ThreadView
          thread={route.screen === 'thread' ? currentThread : null}
          threads={$agentThreads}
          agentsById={$agentById}
          pendingAction={currentThread?.pendingActionId
            ? $agentSnapshot.pending.find((a) => a.id === currentThread?.pendingActionId)
            : undefined}
          navigate={go}
          {onTakeOver}
          onDecline={(id) => decide(id, 'reject')}
        />
      {:else if route.screen === 'audit'}
        <AuditView events={$auditEvents} agents={$agents} />
      {:else if route.screen === 'policies'}
        <PoliciesView agents={$agents} navigate={go} />
      {/if}
    </main>
  </div>

  <div class="sr-only" aria-live="polite" data-testid="agents-live">{$agentAnnouncement}</div>
</div>

<style>
  .fe-agents-shell {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: var(--surface-canvas);
    color: var(--fg-primary);
  }
  .fe-agents-top {
    display: flex;
    align-items: center;
    gap: var(--fe-space-3);
    padding: var(--fe-space-2) var(--fe-space-4);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
  }
  .fe-agents-top-meta {
    display: flex;
    align-items: center;
    gap: var(--fe-space-2);
    margin-left: auto;
  }
  .fe-pill {
    font-size: var(--type-meta);
    color: var(--fg-secondary);
    padding: 2px var(--fe-space-2);
    border: 1px solid var(--border-default);
    border-radius: var(--fe-radius-full);
    white-space: nowrap;
  }
  .fe-agents-banner {
    display: flex;
    align-items: center;
    gap: var(--fe-space-2);
    padding: var(--fe-space-2) var(--fe-space-4);
    background: var(--surface-sunken);
    border-bottom: 1px solid var(--border-default);
    color: var(--state-caution);
    font-size: var(--type-body-sm);
    font-weight: 500;
  }
  .fe-agents-body {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .fe-agents-nav {
    display: flex;
    flex-direction: column;
    gap: var(--fe-space-1);
    width: 248px;
    flex-shrink: 0;
    padding: var(--fe-space-3);
    overflow-y: auto;
    border-right: 1px solid var(--border-subtle);
    background: var(--surface-raised);
  }
  .fe-agents-nav :global(.fe-nav-label) {
    margin: var(--fe-space-4) var(--fe-space-2) var(--fe-space-1);
    color: var(--fg-muted);
  }
  .fe-nav-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .fe-nav-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 36px;
    padding: 0 var(--fe-space-2);
    border-radius: var(--fe-radius-sm);
    font-size: var(--type-body-sm);
    color: var(--fg-secondary);
    text-decoration: none;
  }
  .fe-nav-item:hover {
    background: var(--action-ghost-hover-bg);
    color: var(--fg-primary);
  }
  .fe-nav-item[aria-current='page'] {
    background: var(--action-ghost-hover-bg);
    color: var(--fg-primary);
    font-weight: 600;
  }
  .fe-nav-count {
    font-size: var(--type-meta);
    color: var(--fg-muted);
  }
  .fe-nav-agent {
    display: inline-flex;
    align-items: center;
    gap: var(--fe-space-2);
  }
  .fe-nav-empty {
    padding: var(--fe-space-2);
    font-size: var(--type-meta);
    color: var(--fg-muted);
  }
  .fe-status-dot {
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
  .fe-agents-main {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: var(--fe-space-5) var(--fe-space-6);
  }
  .fe-agents-scrim {
    display: none;
  }
  .fe-agents-top :global(.fe-agents-menu) {
    display: none;
  }

  @media (max-width: 768px) {
    .fe-agents-top :global(.fe-agents-menu) {
      display: inline-flex;
    }
    .fe-agents-nav {
      position: absolute;
      inset: 0 auto 0 0;
      z-index: 30;
      transform: translateX(-100%);
      transition: transform var(--motion-base);
      box-shadow: var(--elev-3);
    }
    .fe-agents-nav.open {
      transform: none;
    }
    .fe-nav-item {
      min-height: 44px;
    }
    .fe-agents-scrim {
      display: block;
      position: absolute;
      inset: 0;
      z-index: 20;
      background: var(--scrim);
      border: 0;
    }
    .fe-agents-main {
      padding: var(--fe-space-4);
    }
    .fe-agents-top-meta .fe-pill {
      display: none;
    }
  }
</style>
